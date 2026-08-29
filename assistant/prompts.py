"""System and user prompt builders for GanttLocal chat."""

from __future__ import annotations

from typing import Any


SYSTEM = """/no_think
You are a planning assistant for GanttLocal, a local Gantt-chart scheduler.
Always write one very short sentence that states your decision: what you will change, or that you will change nothing. Do this even if the user asks you not to do anything. Never reply with empty text or with JSON only.
Then, if there are edits, end with one JSON block: {"ops":[ ... ]}
If nothing to change, still write the sentence; omit the ops block or use {"ops":[]}.
Questions, ideas, or reviews: answer in that sentence (or a few short bullets). Do not emit insert/link ops that rebuild work already in the snapshot.

Ops (use these names):
- insert: {"op":"insert","tempId":"n1","afterId":<id|tempId>,"level":<int>,"name":"...","duration":<days>}
  New rows always get tempId. First row: "atStart":true instead of afterId.
- patch: {"op":"patch","id":<id>,"fields":{"name":"...","duration":5,"pct":0,"notes":"..."}}
  Do not use patch for hierarchy. (fields.level is rewritten to setLevel if sent.)
- delete: {"op":"delete","ids":[<id>,...]}
- link: {"op":"link","from":<id|tempId>,"to":<id|tempId>,"type":"FS","lag":0}
- unlink: {"op":"unlink","from":<id|tempId>,"to":<id|tempId>}
- indent: {"op":"indent","ids":[<id>,...]}  nest under the row above
- outdent: {"op":"outdent","ids":[<id>,...]}  promote one level
- setLevel: {"op":"setLevel","id":<id>,"level":<int>}
- setMeta: {"op":"setMeta","id":<id>,"key":"...","value":"..."}

Rules:
- Starts come from FS links (ASAP). Link leaf tasks only, never a summary to its child.
- New plans: insert with WBS levels plus FS links via tempId. Never invent numeric ids.
- Existing tasks: never re-insert the same name. Use link/patch/indent/outdent/setLevel/delete.
- Be brief. One short sentence, then ops if any.

Example new plan:
Adding a 2-step Design → Build plan.
```json
{"ops":[
  {"op":"insert","tempId":"p1","atStart":true,"level":0,"name":"Phase A","duration":0},
  {"op":"insert","tempId":"a1","afterId":"p1","level":1,"name":"Design","duration":5},
  {"op":"insert","tempId":"a2","afterId":"a1","level":1,"name":"Build","duration":10},
  {"op":"link","from":"a1","to":"a2","type":"FS","lag":0}
]}
```

Example indent/outdent existing ids:
Outdent 2–5 and nest 6 under 5.
```json
{"ops":[
  {"op":"outdent","ids":[2,3,4,5]},
  {"op":"indent","ids":[6]}
]}
```
"""


def _outline_parent_ids(tasks: list[Any]) -> dict[Any, Any]:
    stack: list[tuple[int, Any]] = []
    parents: dict[Any, Any] = {}
    for t in tasks:
        if not isinstance(t, dict) or "id" not in t:
            continue
        level = max(0, int(t.get("level") or 0))
        tid = t.get("id")
        while stack and stack[-1][0] >= level:
            stack.pop()
        parents[tid] = stack[-1][1] if stack else None
        stack.append((level, tid))
    return parents


def _preds_for_ids(links: list[Any], keep: set[Any]) -> dict[Any, list[str]]:
    """Predecessor bits only for task ids that appear in the compact snapshot."""
    if not keep:
        return {}
    preds: dict[Any, list[str]] = {}
    for link in links:
        if not isinstance(link, dict):
            continue
        to = link.get("to")
        if to not in keep:
            continue
        frm = link.get("from")
        if frm is None:
            continue
        typ = link.get("type") or "FS"
        preds.setdefault(to, []).append("%s%s" % (frm, typ))
    return preds


def compact_project(doc: dict[str, Any], limit: int = 200) -> str:
    tasks_raw = doc.get("tasks") or []
    links_raw = doc.get("links") or []
    tasks = tasks_raw if isinstance(tasks_raw, list) else []
    links = links_raw if isinstance(links_raw, list) else []
    # Outline parents for the shown prefix only (same parents as a full walk).
    shown = tasks[:limit]
    parents = _outline_parent_ids(shown)
    shown_ids: set[Any] = set()
    for t in shown:
        if isinstance(t, dict) and "id" in t:
            shown_ids.add(t["id"])
    preds = _preds_for_ids(links, shown_ids)
    lines = [
        "Project: %s" % (doc.get("name") or ""),
        "Scheduler: starts come from predecessors (ASAP). Without links, all tasks share the project start; FS links stagger starts.",
        "Outline: level 0 is top; parent is the nearest shallower row above. Use indent/outdent/setLevel to change hierarchy (not patch).",
        "Tasks (id | level | parent | days | pred | name):",
    ]
    for t in shown:
        if not isinstance(t, dict):
            continue
        tid = t.get("id")
        parent = parents.get(tid)
        parent_s = "none" if parent is None else str(parent)
        pred_bits = preds.get(tid)
        pred = ",".join(pred_bits) if pred_bits else "none"
        # Bound replace work; keep first-120 display same as replace-then-slice for typical names.
        name = (t.get("name") or "")[:120].replace("\n", " ")
        lines.append(
            "%s | L%s | %s | %sd | %s | %s"
            % (tid, t.get("level", 0), parent_s, t.get("duration", 0), pred, name)
        )
    n_tasks = len(tasks)
    if n_tasks > limit:
        lines.append("... %d more tasks omitted" % (n_tasks - limit))
    lines.append("Links (from -> to type lag):")
    if not links:
        lines.append("(none - all tasks start together)")
    else:
        link_limit = 300
        for link in links[:link_limit]:
            if not isinstance(link, dict):
                continue
            lines.append(
                "%s -> %s %s %+dd"
                % (link.get("from"), link.get("to"), link.get("type", "FS"), int(link.get("lag") or 0))
            )
        n_links = len(links)
        if n_links > link_limit:
            lines.append("... %d more links omitted" % (n_links - link_limit))
    return "\n".join(lines)


def build_user_message(user_text: str, doc: dict[str, Any]) -> str:
    return "\n".join(
        [
            compact_project(doc),
            "",
            "User request:",
            (user_text or "").strip(),
        ]
    )


def history_messages(history: list[dict[str, Any]], cap: int = 12) -> list[dict[str, str]]:
    """Map stored chat turns to llama chat roles (skip system noise)."""
    out: list[dict[str, str]] = []
    for item in history[-cap:]:
        role = item.get("role")
        content = item.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            out.append({"role": role, "content": content})
    return out
