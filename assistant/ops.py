"""Validate structured edit ops against a project snapshot."""

from __future__ import annotations

import json
import re
from typing import Any

LINK_TYPES = {"FS", "SS", "FF", "SF"}
CONSTRAINT_TYPES = {"ASAP", "SNET", "FNLT", "MSO"}
FENCE_RE = re.compile(r"```(?:json)?\s*", re.I)
TEMP_ID_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]{0,15}$")

_OP_CANON = {
    "insert": "insert",
    "add": "insert",
    "create": "insert",
    "patch": "patch",
    "update": "patch",
    "delete": "delete",
    "remove": "delete",
    "link": "link",
    "addlink": "link",
    "dependency": "link",
    "unlink": "unlink",
    "indent": "indent",
    "indenttasks": "indent",
    "outdent": "outdent",
    "outdenttasks": "outdent",
    "setlevel": "setLevel",
    "setmeta": "setMeta",
}


def _extract_balanced_object(text: str, start: int) -> str | None:
    if start < 0 or start >= len(text) or text[start] != "{":
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def extract_ops_payload(text: str) -> tuple[str, list[dict[str, Any]]]:
    """Split assistant prose from a trailing/embedded ops JSON block."""
    if not text:
        return "", []
    reply = text.strip()
    ops: list[dict[str, Any]] = []

    # Prefer fenced ```json ... ``` blocks (last wins).
    search_from = 0
    last = None
    while True:
        m = FENCE_RE.search(reply, search_from)
        if not m:
            break
        obj_start = reply.find("{", m.end())
        raw = _extract_balanced_object(reply, obj_start) if obj_start >= 0 else None
        end_fence = reply.find("```", (obj_start if obj_start >= 0 else m.end()))
        if raw is not None:
            last = (m.start(), end_fence + 3 if end_fence >= 0 else obj_start + len(raw), raw)
            search_from = (end_fence + 3) if end_fence >= 0 else (obj_start + len(raw))
        else:
            search_from = m.end()

    if last:
        start, end, raw = last
        reply = (reply[:start] + reply[end:]).strip()
        try:
            data = json.loads(raw)
            if isinstance(data, dict) and isinstance(data.get("ops"), list):
                ops = [o for o in data["ops"] if isinstance(o, dict)]
            elif isinstance(data, list):
                ops = [o for o in data if isinstance(o, dict)]
        except (ValueError, TypeError):
            ops = []
        return reply, ops

    # Bare trailing {"ops": ...}
    brace = reply.rfind('{"ops"')
    if brace >= 0:
        raw = _extract_balanced_object(reply, brace)
        if raw:
            try:
                data = json.loads(raw)
                if isinstance(data, dict) and isinstance(data.get("ops"), list):
                    ops = [o for o in data["ops"] if isinstance(o, dict)]
                    reply = reply[:brace].strip()
            except (ValueError, TypeError):
                pass
    return reply, ops


def _parse_ref(value: Any) -> tuple[str, int | str] | None:
    """Return ('id', int) or ('temp', str) or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return ("id", value)
    if isinstance(value, float) and value == int(value):
        return ("id", int(value))
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if TEMP_ID_RE.match(s):
            return ("temp", s)
        try:
            return ("id", int(s))
        except ValueError:
            return None
    return None


def _ref_known(kind: str, ref: int | str, ids: set[int], temps: set[str]) -> bool:
    if kind == "id":
        return int(ref) in ids
    return str(ref) in temps


def _clean_temp_id(raw: Any, temps: set[str]) -> tuple[str | None, str | None]:
    """Return (tempId, error_reason)."""
    if raw is None or raw is False:
        return None, None
    if not isinstance(raw, str) or not TEMP_ID_RE.match(raw.strip()):
        return None, "invalid tempId"
    tid = raw.strip()
    if tid in temps:
        return None, "duplicate tempId %s" % tid
    return tid, None


def _canon_op(name: Any) -> str:
    key = str(name or "").strip().replace("-", "").replace("_", "").replace(" ", "").lower()
    return _OP_CANON.get(key, "")


def _repair_raw(raw: dict[str, Any]) -> dict[str, Any]:
    out = dict(raw)
    canon = _canon_op(out.get("op"))
    if canon:
        out["op"] = canon
    return out


def validate_ops(ops: list[dict[str, Any]], doc: dict[str, Any]) -> dict[str, Any]:
    """Return {ops, rejected}. Unusable/repairable-bad ops are dropped silently.

    rejected is only filled when nothing remains to apply.
    """
    tasks = doc.get("tasks") or []
    ids = {int(t["id"]) for t in tasks if isinstance(t, dict) and "id" in t}
    names: set[str] = set()
    outline_rows: list[dict[str, Any]] = []
    for t in tasks:
        if not isinstance(t, dict) or "id" not in t:
            continue
        n = (t.get("name") or "").strip().casefold()
        if n:
            names.add(n)
        outline_rows.append({"key": int(t["id"]), "level": max(0, int(t.get("level") or 0))})
    parents = _outline_parents(outline_rows)
    # Stack mirrors _outline_parents so temp inserts can append in O(depth), not O(n).
    outline_stack: list[tuple[int, Any]] = []
    for row in outline_rows:
        level = max(0, int(row.get("level") or 0))
        key = row["key"]
        while outline_stack and outline_stack[-1][0] >= level:
            outline_stack.pop()
        outline_stack.append((level, key))
    level_by_id: dict[int, int] = {
        int(t["id"]): max(0, int(t.get("level") or 0))
        for t in tasks
        if isinstance(t, dict) and "id" in t
    }
    temps: set[str] = set()
    clean: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []

    def drop(raw: Any, reason: str) -> None:
        dropped.append({"op": raw, "reason": reason})

    def append_outline(key: Any, level: int) -> None:
        level = max(0, level)
        while outline_stack and outline_stack[-1][0] >= level:
            outline_stack.pop()
        parents[key] = outline_stack[-1][1] if outline_stack else None
        outline_stack.append((level, key))
        outline_rows.append({"key": key, "level": level})

    for raw in ops:
        if not isinstance(raw, dict):
            drop(raw, "not an object")
            continue
        raw = _repair_raw(raw)
        op = raw.get("op") or ""
        if op == "insert":
            fallback = outline_rows[-1]["key"] if outline_rows else None
            item, reason = _clean_insert(raw, ids, temps, names, fallback)
            if item:
                clean.append(item)
                if item.get("tempId"):
                    temps.add(item["tempId"])
                    append_outline(item["tempId"], int(item.get("level") or 0))
                names.add(item["name"].casefold())
            else:
                drop(raw, reason or "invalid insert")
        elif op == "patch":
            items, reason = _expand_patch(raw, ids, level_by_id)
            if items:
                for item in items:
                    clean.append(item)
                    if item.get("op") == "setLevel":
                        level_by_id[int(item["id"])] = int(item["level"])
            else:
                drop(raw, reason or "invalid patch or unknown id")
        elif op == "delete":
            item = _clean_delete(raw, ids)
            if item:
                clean.append(item)
            else:
                drop(raw, "invalid delete or unknown ids")
        elif op == "link":
            item, reason = _clean_link(raw, ids, temps, parents)
            if item:
                clean.append(item)
            else:
                drop(raw, reason or "invalid link")
        elif op == "unlink":
            item, reason = _clean_unlink(raw, ids, temps)
            if item:
                clean.append(item)
            else:
                drop(raw, reason or "invalid unlink")
        elif op == "indent":
            item, reason = _clean_shift_levels(raw, ids, +1)
            if item:
                clean.append(item)
            else:
                drop(raw, reason or "invalid indent")
        elif op == "outdent":
            item, reason = _clean_shift_levels(raw, ids, -1)
            if item:
                clean.append(item)
            else:
                drop(raw, reason or "invalid outdent")
        elif op == "setLevel":
            item, reason = _clean_set_level(raw, ids, level_by_id)
            if item:
                clean.append(item)
                level_by_id[int(item["id"])] = int(item["level"])
            else:
                drop(raw, reason or "invalid setLevel")
        elif op == "setMeta":
            item = _clean_meta(raw, ids)
            if item:
                clean.append(item)
            else:
                drop(raw, "invalid setMeta or unknown id")
        else:
            drop(raw, "unknown op %s" % (raw.get("op") or "(empty)"))

    kept = simulate_apply(doc, clean)
    return {"ops": kept, "rejected": []}


def _outline_parents(rows: list[dict[str, Any]]) -> dict[Any, Any]:
    """Map each row key to its outline parent key (or None)."""
    stack: list[tuple[int, Any]] = []
    parents: dict[Any, Any] = {}
    for row in rows:
        level = max(0, int(row.get("level") or 0))
        key = row["key"]
        while stack and stack[-1][0] >= level:
            stack.pop()
        parents[key] = stack[-1][1] if stack else None
        stack.append((level, key))
    return parents


def _outline_related(parents: dict[Any, Any], a: Any, b: Any) -> bool:
    cur = parents.get(b)
    while cur is not None:
        if cur == a:
            return True
        cur = parents.get(cur)
    cur = parents.get(a)
    while cur is not None:
        if cur == b:
            return True
        cur = parents.get(cur)
    return False


def _clean_insert(
    raw: dict[str, Any],
    ids: set[int],
    temps: set[str],
    names: set[str],
    fallback_after: Any = None,
) -> tuple[dict[str, Any] | None, str | None]:
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        return None, "insert requires a name"
    cleaned_name = name.strip()[:200]
    key = cleaned_name.casefold()
    if key in names:
        return None, "duplicate name %r - use link/patch on existing id" % cleaned_name
    level = int(raw.get("level") or 0)
    if level < 0:
        level = 0
    temp_id, temp_err = _clean_temp_id(raw.get("tempId"), temps)
    if temp_err:
        return None, temp_err

    item: dict[str, Any] = {
        "op": "insert",
        "level": level,
        "name": cleaned_name,
        "duration": max(0, int(raw.get("duration") or 1)),
        "milestone": bool(raw.get("milestone")),
        "notes": str(raw.get("notes") or "")[:2000],
    }
    if temp_id:
        item["tempId"] = temp_id

    if raw.get("atStart"):
        item["atStart"] = True
    elif "afterId" in raw and raw.get("afterId") is not None:
        parsed = _parse_ref(raw.get("afterId"))
        placed = False
        if parsed:
            kind, ref = parsed
            if _ref_known(kind, ref, ids, temps):
                item["afterId"] = ref
                placed = True
        if not placed:
            if fallback_after is not None:
                item["afterId"] = fallback_after
            else:
                item["atStart"] = True
    else:
        if fallback_after is not None:
            item["afterId"] = fallback_after
        else:
            item["atStart"] = True

    meta = raw.get("meta")
    if isinstance(meta, dict):
        item["meta"] = {str(k)[:40]: str(v)[:200] for k, v in list(meta.items())[:20]}
    if item["milestone"]:
        item["duration"] = 0
    return item, None


def _expand_patch(
    raw: dict[str, Any],
    ids: set[int],
    level_by_id: dict[int, int],
) -> tuple[list[dict[str, Any]] | None, str | None]:
    """Turn a patch into zero or more ops. fields.level becomes setLevel."""
    try:
        tid = int(raw["id"])
    except (KeyError, TypeError, ValueError):
        return None, "patch requires id"
    if tid not in ids:
        return None, "unknown id %s" % raw.get("id")
    fields_in = raw.get("fields")
    if not isinstance(fields_in, dict):
        return None, "patch requires fields"

    out: list[dict[str, Any]] = []
    if "level" in fields_in:
        try:
            level = max(0, int(fields_in["level"]))
        except (TypeError, ValueError):
            return None, "invalid level"
        current = level_by_id.get(tid, 0)
        out.append(
            {
                "op": "setLevel",
                "id": tid,
                "level": level,
                "delta": level - current,
            }
        )

    fields: dict[str, Any] = {}
    if "name" in fields_in and isinstance(fields_in["name"], str):
        fields["name"] = fields_in["name"].strip()[:200]
    if "duration" in fields_in:
        try:
            fields["duration"] = max(0, int(fields_in["duration"]))
        except (TypeError, ValueError):
            pass
    if "pct" in fields_in:
        try:
            fields["pct"] = min(100, max(0, int(fields_in["pct"])))
        except (TypeError, ValueError):
            pass
    if "notes" in fields_in and isinstance(fields_in["notes"], str):
        fields["notes"] = fields_in["notes"][:2000]
    if "milestone" in fields_in:
        fields["milestone"] = bool(fields_in["milestone"])
    if "manual" in fields_in:
        fields["manual"] = bool(fields_in["manual"])
    if "constraint" in fields_in and isinstance(fields_in["constraint"], dict):
        ctype = fields_in["constraint"].get("type")
        if ctype in CONSTRAINT_TYPES:
            date = fields_in["constraint"].get("date")
            fields["constraint"] = {
                "type": ctype,
                "date": date if isinstance(date, str) or date is None else None,
            }
    if fields:
        out.append({"op": "patch", "id": tid, "fields": fields})
    if not out:
        return None, "invalid patch - for hierarchy use setLevel/indent/outdent"
    return out, None


def _clean_delete(raw: dict[str, Any], ids: set[int]) -> dict[str, Any] | None:
    raw_ids = raw.get("ids")
    if not isinstance(raw_ids, list):
        return None
    out = []
    for x in raw_ids:
        try:
            i = int(x)
        except (TypeError, ValueError):
            continue
        if i in ids:
            out.append(i)
    if not out:
        return None
    return {"op": "delete", "ids": out}


def _clean_shift_levels(
    raw: dict[str, Any], ids: set[int], delta: int
) -> tuple[dict[str, Any] | None, str | None]:
    raw_ids = raw.get("ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        return None, "ids required"
    out: list[int] = []
    seen: set[int] = set()
    for x in raw_ids:
        try:
            i = int(x)
        except (TypeError, ValueError):
            continue
        if i not in ids:
            return None, "unknown id %s" % x
        if i not in seen:
            seen.add(i)
            out.append(i)
    if not out:
        return None, "ids required"
    name = "indent" if delta > 0 else "outdent"
    return {"op": name, "ids": out}, None


def _clean_set_level(
    raw: dict[str, Any],
    ids: set[int],
    level_by_id: dict[int, int],
) -> tuple[dict[str, Any] | None, str | None]:
    try:
        tid = int(raw["id"])
    except (KeyError, TypeError, ValueError):
        return None, "setLevel requires id"
    if tid not in ids:
        return None, "unknown id %s" % raw.get("id")
    try:
        level = int(raw.get("level"))
    except (TypeError, ValueError):
        return None, "setLevel requires level"
    if level < 0:
        level = 0
    current = level_by_id.get(tid, 0)
    if level == current:
        return {"op": "setLevel", "id": tid, "level": level, "delta": 0}, None
    return {"op": "setLevel", "id": tid, "level": level, "delta": level - current}, None


def _clean_link(
    raw: dict[str, Any],
    ids: set[int],
    temps: set[str],
    parents: dict[Any, Any] | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    parsed_from = _parse_ref(raw.get("from"))
    parsed_to = _parse_ref(raw.get("to"))
    if not parsed_from or not parsed_to:
        return None, "link requires from and to"
    fk, frm = parsed_from
    tk, to = parsed_to
    if not _ref_known(fk, frm, ids, temps):
        return None, "unknown from %s" % frm
    if not _ref_known(tk, to, ids, temps):
        return None, "unknown to %s" % to
    if frm == to:
        return None, "self-link"
    if parents and _outline_related(parents, frm, to):
        return None, "cannot link summary to its descendant (or reverse)"
    typ = raw.get("type") or "FS"
    if typ not in LINK_TYPES:
        typ = "FS"
    try:
        lag = int(raw.get("lag") or 0)
    except (TypeError, ValueError):
        lag = 0
    return {"op": "link", "from": frm, "to": to, "type": typ, "lag": lag}, None


def _clean_unlink(
    raw: dict[str, Any], ids: set[int], temps: set[str]
) -> tuple[dict[str, Any] | None, str | None]:
    parsed_from = _parse_ref(raw.get("from"))
    parsed_to = _parse_ref(raw.get("to"))
    if not parsed_from or not parsed_to:
        return None, "unlink requires from and to"
    fk, frm = parsed_from
    tk, to = parsed_to
    if not _ref_known(fk, frm, ids, temps):
        return None, "unknown from %s" % frm
    if not _ref_known(tk, to, ids, temps):
        return None, "unknown to %s" % to
    return {"op": "unlink", "from": frm, "to": to}, None


def _clean_meta(raw: dict[str, Any], ids: set[int]) -> dict[str, Any] | None:
    try:
        tid = int(raw["id"])
    except (KeyError, TypeError, ValueError):
        return None
    if tid not in ids:
        return None
    key = raw.get("key")
    if not isinstance(key, str) or not key.strip():
        return None
    value = raw.get("value")
    if value is None:
        value = ""
    return {"op": "setMeta", "id": tid, "key": key.strip()[:40], "value": str(value)[:200]}


def simulate_apply(doc: dict[str, Any], ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only ops that would succeed under the same rules as the chat Apply path."""
    tasks: list[dict[str, Any]] = [
        {"id": int(t["id"]), "level": max(0, int(t.get("level") or 0)), "name": t.get("name") or ""}
        for t in (doc.get("tasks") or [])
        if isinstance(t, dict) and "id" in t
    ]
    links: list[tuple[Any, Any]] = []
    for link in doc.get("links") or []:
        if isinstance(link, dict) and "from" in link and "to" in link:
            links.append((link["from"], link["to"]))
    next_id = max([t["id"] for t in tasks], default=0) + 1
    aliases: dict[str, int] = {}
    kept: list[dict[str, Any]] = []
    id_index: dict[int, int] = {t["id"]: i for i, t in enumerate(tasks)}
    parents_cache: dict[Any, Any] | None = None

    def resolve(ref: Any) -> int | None:
        if isinstance(ref, str) and ref in aliases:
            return aliases[ref]
        if isinstance(ref, bool):
            return None
        if isinstance(ref, int):
            return ref
        if isinstance(ref, str) and ref.isdigit():
            return int(ref)
        return None

    def rebuild_index() -> None:
        id_index.clear()
        for i, t in enumerate(tasks):
            id_index[t["id"]] = i

    def index_of(tid: int) -> int:
        return id_index.get(tid, -1)

    def subtree_end(i: int) -> int:
        level = tasks[i]["level"]
        j = i + 1
        while j < len(tasks) and tasks[j]["level"] > level:
            j += 1
        return j

    def parents_map() -> dict[Any, Any]:
        nonlocal parents_cache
        if parents_cache is None:
            parents_cache = _outline_parents(
                [{"key": t["id"], "level": t["level"]} for t in tasks]
            )
        return parents_cache

    def invalidate_parents() -> None:
        nonlocal parents_cache
        parents_cache = None

    def shift_levels(ids: list[int], delta: int) -> bool:
        # Mutates levels only when at least one block applies; otherwise no-op.
        # Callers must not snapshot/deepcopy for rollback.
        rows = []
        for tid in ids:
            i = index_of(tid)
            if i >= 0:
                rows.append(i)
        rows.sort()
        blocks = []
        covered = -1
        for i in rows:
            if i < covered:
                continue
            blocks.append(i)
            covered = subtree_end(i)
        if not blocks:
            return False
        touched = False
        for i in blocks:
            end = subtree_end(i)
            if delta > 0:
                if i == 0 or tasks[i - 1]["level"] < tasks[i]["level"]:
                    continue
            elif tasks[i]["level"] == 0:
                continue
            for k in range(i, end):
                tasks[k]["level"] = max(0, tasks[k]["level"] + delta)
            touched = True
        if touched:
            invalidate_parents()
        return touched

    for op in ops:
        kind = op.get("op")
        if kind == "insert":
            at = 0
            if not op.get("atStart"):
                after = resolve(op.get("afterId"))
                idx = index_of(after) if after is not None else -1
                if idx < 0:
                    continue
                at = idx + 1
            at = max(0, min(at, len(tasks)))
            max_level = tasks[at - 1]["level"] + 1 if at > 0 else 0
            lvl = max(0, min(int(op.get("level") or 0), max_level))
            tid = next_id
            next_id += 1
            tasks.insert(at, {"id": tid, "level": lvl, "name": op.get("name") or ""})
            rebuild_index()
            invalidate_parents()
            if op.get("tempId"):
                aliases[str(op["tempId"])] = tid
            kept.append(op)
        elif kind == "patch":
            tid = resolve(op.get("id"))
            if tid is None or index_of(tid) < 0:
                continue
            kept.append(op)
        elif kind == "delete":
            raw_ids = [resolve(x) for x in (op.get("ids") or [])]
            ids = [i for i in raw_ids if i is not None and index_of(i) >= 0]
            if not ids:
                continue
            drop = set()
            rows = sorted(index_of(i) for i in ids if index_of(i) >= 0)
            covered = -1
            blocks = []
            for i in rows:
                if i < covered:
                    continue
                blocks.append(i)
                covered = subtree_end(i)
            for i in blocks:
                for t in tasks[i : subtree_end(i)]:
                    drop.add(t["id"])
            if not drop or len(drop) >= len(tasks):
                continue
            tasks[:] = [t for t in tasks if t["id"] not in drop]
            links[:] = [ln for ln in links if ln[0] not in drop and ln[1] not in drop]
            rebuild_index()
            invalidate_parents()
            kept.append(op)
        elif kind == "link":
            frm = resolve(op.get("from"))
            to = resolve(op.get("to"))
            if frm is None or to is None or frm == to:
                continue
            if index_of(frm) < 0 or index_of(to) < 0:
                continue
            if _outline_related(parents_map(), frm, to):
                continue
            if (frm, to) in links:
                continue
            links.append((frm, to))
            kept.append(op)
        elif kind == "unlink":
            frm = resolve(op.get("from"))
            to = resolve(op.get("to"))
            if frm is None or to is None:
                continue
            links[:] = [ln for ln in links if not (ln[0] == frm and ln[1] == to)]
            kept.append(op)
        elif kind == "indent":
            ids = [resolve(x) for x in (op.get("ids") or [])]
            ids = [i for i in ids if i is not None]
            if not ids or not shift_levels(ids, 1):
                continue
            kept.append(op)
        elif kind == "outdent":
            ids = [resolve(x) for x in (op.get("ids") or [])]
            ids = [i for i in ids if i is not None]
            if not ids or not shift_levels(ids, -1):
                continue
            kept.append(op)
        elif kind == "setLevel":
            tid = resolve(op.get("id"))
            if tid is None or index_of(tid) < 0:
                continue
            want = max(0, int(op.get("level") or 0))
            cur = tasks[index_of(tid)]["level"]
            delta = want - cur
            if delta == 0:
                continue
            if not shift_levels([tid], delta):
                continue
            kept.append(op)
        elif kind == "setMeta":
            tid = resolve(op.get("id"))
            if tid is None or index_of(tid) < 0:
                continue
            kept.append(op)
        else:
            continue
    return kept

