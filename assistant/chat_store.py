"""Per-project chat history storage."""

from __future__ import annotations

import json
import os
from typing import Any

from . import config


def _chat_path(name: str) -> str:
    return os.path.join(config.ensure_project_dirs(name), "chat.json")


def _strip_citations(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    dirty = False
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if "citations" in msg:
            dirty = True
            msg = dict(msg)
            del msg["citations"]
        cleaned.append(msg)
    return cleaned if dirty or len(cleaned) != len(messages) else messages


def load_chat(name: str) -> list[dict[str, Any]]:
    path = _chat_path(name)
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "rb") as fh:
            data = json.loads(fh.read())
        if not isinstance(data, list):
            return []
        cleaned = _strip_citations(data)
        if cleaned is not data:
            save_chat(name, cleaned)
        return cleaned
    except (OSError, ValueError):
        return []


def save_chat(name: str, messages: list[dict[str, Any]]) -> None:
    path = _chat_path(name)
    capped = _strip_citations(messages[-config.CHAT_HISTORY_CAP :])
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(capped, fh, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def clear_chat(name: str) -> None:
    save_chat(name, [])
