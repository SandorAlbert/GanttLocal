"""High-level assistant handlers used by serve.py."""

from __future__ import annotations

from typing import Any, Iterator

from . import llm
from . import chat_store
from . import config


# Bumped on Clear Chat so an in-flight generation cannot rewrite history.
_chat_epoch: dict[str, int] = {}


def _chat_epoch_of(name: str) -> int:
    return _chat_epoch.get(name, 0)


def _bump_chat_epoch(name: str) -> int:
    n = _chat_epoch_of(name) + 1
    _chat_epoch[name] = n
    return n


def get_status() -> dict[str, Any]:
    return llm.status()


def get_settings() -> dict[str, Any]:
    settings = config.load_settings()
    st = llm.status()
    return {
        "gpuEnabled": settings.get("gpuEnabled"),
        "nGpuLayers": settings.get("nGpuLayers"),
        "gpuOffloadSupported": st.get("gpuOffloadSupported"),
        "gpuHint": st.get("gpuHint"),
        "effectiveNGpuLayers": st.get("effectiveNGpuLayers"),
        "ready": st.get("ready"),
    }


def update_settings(payload: dict[str, Any]) -> dict[str, Any]:
    current = config.load_settings()
    if "gpuEnabled" in payload:
        current["gpuEnabled"] = bool(payload.get("gpuEnabled"))
    if "nGpuLayers" in payload:
        current["nGpuLayers"] = config._clamp_layers(payload.get("nGpuLayers"))
    saved = config.save_settings(current)
    llm.unload_models()
    st = llm.status()
    return {
        "gpuEnabled": saved.get("gpuEnabled"),
        "nGpuLayers": saved.get("nGpuLayers"),
        "gpuOffloadSupported": st.get("gpuOffloadSupported"),
        "gpuHint": st.get("gpuHint"),
        "effectiveNGpuLayers": st.get("effectiveNGpuLayers"),
        "ready": st.get("ready"),
    }


def get_chat(name: str) -> dict[str, Any]:
    return {"messages": chat_store.load_chat(name)}


def clear_chat(name: str) -> dict[str, Any]:
    _bump_chat_epoch(name)
    chat_store.clear_chat(name)
    return {"ok": True}


def chat_stream(name: str, message: str, project: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Yield SSE payload dicts: status?, token*, done | error."""
    st = llm.status()
    if not st.get("ready"):
        yield {"type": "error", "error": st.get("error") or "Assistant is not ready"}
        return
    text = (message or "").strip()
    if not text:
        yield {"type": "error", "error": "Empty message"}
        return
    if not isinstance(project, dict) or not isinstance(project.get("tasks"), list):
        yield {"type": "error", "error": "Invalid project snapshot"}
        return

    epoch = _chat_epoch_of(name)

    def cancelled() -> bool:
        return _chat_epoch_of(name) != epoch

    history = chat_store.load_chat(name)
    done: dict[str, Any] | None = None
    try:
        for event in llm.chat_completion_agent_stream(
            name, text, project, history, cancelled=cancelled
        ):
            if cancelled():
                return
            et = event.get("type")
            if et in ("token", "status", "usage"):
                yield event
            elif et == "done":
                done = event
            elif et == "error":
                yield event
                return
    except Exception as exc:  # noqa: BLE001
        if cancelled():
            return
        yield {"type": "error", "error": str(exc)}
        return

    if cancelled():
        return
    if not done:
        yield {"type": "error", "error": "Model returned no output"}
        return

    reply = (done.get("reply") or "").strip()
    ops = done.get("ops") or []
    rejected = done.get("rejected") or []
    if not reply:
        reply = llm._decision_summary(ops)
    history.append({"role": "user", "content": text})
    history.append(
        {
            "role": "assistant",
            "content": reply,
            "ops": ops,
            "rejected": rejected,
            "status": "proposed" if ops else "ok",
        }
    )
    if cancelled():
        return
    chat_store.save_chat(name, history)
    if cancelled():
        return
    yield {
        "type": "done",
        "reply": reply,
        "ops": ops,
        "rejected": rejected,
        "usage": done.get("usage"),
        "messages": chat_store.load_chat(name),
    }


def estimate_context(name: str, message: str, project: dict[str, Any]) -> dict[str, Any]:
    """Return context token usage for the current draft + history."""
    if not isinstance(project, dict) or not isinstance(project.get("tasks"), list):
        raise ValueError("Invalid project snapshot")
    history = chat_store.load_chat(name)
    return llm.estimate_context_usage(name, message or "", project, history)


def mark_ops_status(name: str, status: str, errors: list[str] | None = None) -> dict[str, Any]:
    """Mark the latest assistant message with ops as applied/rejected/partial."""
    history = chat_store.load_chat(name)
    for i in range(len(history) - 1, -1, -1):
        msg = history[i]
        if msg.get("role") == "assistant" and (
            msg.get("ops") or msg.get("rejected") or msg.get("status") == "proposed"
        ):
            msg["status"] = status
            if errors:
                msg["applyErrors"] = list(errors)[:40]
            elif "applyErrors" in msg:
                del msg["applyErrors"]
            break
    chat_store.save_chat(name, history)
    return {"messages": history}
