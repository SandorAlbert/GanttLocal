"""Evaluate repair + local GGUF ops against scheduling fixtures.

Usage (from project root):
  python tools/eval_assistant.py            # repair tests + chat.gguf fixtures
  python tools/eval_assistant.py --repair-only
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Callable

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from assistant.ops import simulate_apply, validate_ops  # noqa: E402


def _task(tid: int, level: int, name: str, duration: int = 1) -> dict[str, Any]:
    return {"id": tid, "level": level, "name": name, "duration": duration}


def _doc(tasks: list[dict[str, Any]], links: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"name": "Eval", "tasks": tasks, "links": links or []}


def _ops(validated: dict[str, Any]) -> list[str]:
    return [str(o.get("op")) for o in (validated.get("ops") or [])]


def _fail(msg: str) -> str:
    return msg


def expect_kinds(validated: dict[str, Any], kinds: set[str], min_ops: int = 1) -> str | None:
    ops = validated.get("ops") or []
    rejected = validated.get("rejected") or []
    if rejected:
        return "rejected shown to UI: %s" % json.dumps(rejected, default=str)[:400]
    if not ops:
        return "no applyable ops"
    got = {str(o.get("op")) for o in ops}
    missing = kinds - got
    if missing:
        return "missing ops %s (got %s)" % (sorted(missing), [str(o.get("op")) for o in ops])
    if len(ops) < min_ops:
        return "too few ops: %s" % [str(o.get("op")) for o in ops]
    return None


def repair_cases() -> list[tuple[str, dict[str, Any], list[dict[str, Any]], Callable]]:
    empty = _doc([])
    flat = _doc([_task(i, 0, "Task %d" % i, 2) for i in range(1, 7)])
    nested = _doc(
        [
            _task(1, 0, "Phase", 0),
            _task(2, 1, "Design", 5),
            _task(3, 1, "Build", 10),
            _task(4, 1, "Test", 3),
        ]
    )
    return [
        (
            "repair_patch_level_to_setLevel",
            nested,
            [
                {"op": "patch", "id": 2, "fields": {"level": 0}},
                {"op": "patch", "id": 3, "fields": {"level": 0}},
            ],
            lambda v: expect_kinds(v, {"setLevel"}, 2),
        ),
        (
            "repair_set_level_alias",
            nested,
            [{"op": "set_level", "id": 3, "level": 0}],
            lambda v: expect_kinds(v, {"setLevel"}, 1),
        ),
        (
            "repair_drop_outline_link",
            nested,
            [
                {"op": "link", "from": 1, "to": 2, "type": "FS"},
                {"op": "link", "from": 2, "to": 3, "type": "FS"},
            ],
            lambda v: None
            if (not v.get("rejected") and _ops(v) == ["link"] and v["ops"][0]["from"] == 2)
            else _fail("expected only leaf link, got %s rejected=%s" % (_ops(v), v.get("rejected"))),
        ),
        (
            "repair_drop_duplicate_insert",
            nested,
            [
                {
                    "op": "insert",
                    "tempId": "n1",
                    "afterId": 4,
                    "level": 1,
                    "name": "Build",
                    "duration": 10,
                },
                {"op": "link", "from": 2, "to": 3, "type": "FS"},
            ],
            lambda v: None
            if (not v.get("rejected") and _ops(v) == ["link"])
            else _fail("expected duplicate insert dropped, got %s" % v),
        ),
        (
            "repair_invented_afterId_empty",
            empty,
            [
                {"op": "insert", "tempId": "a", "afterId": 1, "level": 0, "name": "A", "duration": 1},
                {"op": "insert", "tempId": "b", "afterId": 2, "level": 0, "name": "B", "duration": 1},
                {"op": "link", "from": "a", "to": "b", "type": "FS"},
            ],
            lambda v: expect_kinds(v, {"insert", "link"}, 3),
        ),
        (
            "repair_drop_row0_indent",
            flat,
            [
                {"op": "indent", "ids": [1]},
                {"op": "indent", "ids": [2]},
            ],
            lambda v: None
            if (not v.get("rejected") and _ops(v) == ["indent"] and v["ops"][0]["ids"] == [2])
            else _fail("expected only indent #2, got %s rejected=%s" % (_ops(v), v.get("rejected"))),
        ),
        (
            "repair_screenshot_patch_level",
            nested,
            [
                {"op": "patch", "id": 2, "fields": {"level": 0, "name": "Design"}},
                {"op": "patch", "id": 3, "fields": {"level": 0}},
            ],
            lambda v: None
            if (
                not v.get("rejected")
                and "setLevel" in _ops(v)
                and any(o.get("op") == "patch" for o in v["ops"])
            )
            else _fail("screenshot patch.level should become setLevel+patch, got %s" % _ops(v)),
        ),
    ]


def llm_fixtures() -> list[dict[str, Any]]:
    empty = _doc([])
    flat = _doc([_task(i, 0, "Task %d" % i, 2) for i in range(1, 7)])
    leaves = _doc(
        [
            _task(1, 0, "Design", 5),
            _task(2, 0, "Build", 10),
            _task(3, 0, "Test", 3),
        ]
    )
    named = _doc(
        [
            _task(1, 0, "Kickoff", 1),
            _task(2, 0, "Draft", 4),
            _task(3, 0, "Review", 2),
        ]
    )
    return [
        {
            "name": "new_plan_fs",
            "doc": empty,
            "prompt": "Make a 3-task plan with FS links.",
            "check": lambda v: expect_kinds(v, {"insert", "link"}, 4),
        },
        {
            "name": "outdent_indent",
            "doc": flat,
            "prompt": "Outdent tasks 2-5 and indent task 6 under task 5.",
            "check": lambda v: None
            if (not v.get("rejected") and (set(_ops(v)) & {"indent", "outdent", "setLevel"}))
            else _fail("need hierarchy ops, got %s rejected=%s" % (_ops(v), v.get("rejected"))),
        },
        {
            "name": "add_dependencies",
            "doc": leaves,
            "prompt": "Add Finish-to-Start dependencies so work is sequential: Design then Build then Test.",
            "check": lambda v: expect_kinds(v, {"link"}, 1),
        },
        {
            "name": "rename_task_2",
            "doc": named,
            "prompt": "Rename task 2 to 'Write draft'.",
            "check": lambda v: None
            if (
                not v.get("rejected")
                and any(
                    o.get("op") == "patch" and (o.get("fields") or {}).get("name")
                    for o in (v.get("ops") or [])
                )
            )
            else _fail("need patch rename, got %s rejected=%s" % (_ops(v), v.get("rejected"))),
        },
        {
            "name": "delete_task_3",
            "doc": named,
            "prompt": "Delete task 3.",
            "check": lambda v: expect_kinds(v, {"delete"}, 1),
        },
    ]


def run_repair() -> int:
    failed = 0
    for name, doc, ops, check in repair_cases():
        validated = validate_ops(ops, doc)
        sim = simulate_apply(doc, validated.get("ops") or [])
        err = check(validated)
        if err is None and sim != (validated.get("ops") or []):
            err = "simulate_apply mismatch"
        status = "PASS" if err is None else "FAIL"
        if err:
            failed += 1
        print("%s  %s" % (status, name))
        if err:
            print("    %s" % err)
            print("    ops=%s rejected=%s" % (_ops(validated), validated.get("rejected")))
    return failed


def run_llm() -> int:
    from assistant.llm import chat_completion_agent_stream

    failed = 0
    for fx in llm_fixtures():
        print("LLM  %s ..." % fx["name"], flush=True)
        done = None
        for event in chat_completion_agent_stream(fx["doc"].get("name") or "Eval", fx["prompt"], fx["doc"], []):
            if event.get("type") == "done":
                done = event
        if not done:
            print("FAIL  %s  no done event" % fx["name"])
            failed += 1
            continue
        validated = {"ops": done.get("ops") or [], "rejected": done.get("rejected") or []}
        err = fx["check"](validated)
        sim = simulate_apply(fx["doc"], validated["ops"])
        if err is None and sim != validated["ops"]:
            err = "simulate_apply would drop ops"
        status = "PASS" if err is None else "FAIL"
        if err:
            failed += 1
        print("%s  %s  ops=%s rejected=%d" % (status, fx["name"], _ops(validated), len(validated["rejected"])))
        if err:
            print("    %s" % err)
            raw = (done.get("raw") or "")[:800]
            print("    raw: %s" % raw.replace("\n", " | "))
    return failed


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate assistant ops repair and local GGUF fixtures.")
    parser.add_argument("--repair-only", action="store_true", help="Skip chat.gguf fixtures")
    args = parser.parse_args()
    print("== repair ==")
    failed = run_repair()
    if not args.repair_only:
        print("== llm ==")
        failed += run_llm()
    print("%d failed" % failed)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
