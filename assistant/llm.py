"""Lazy singleton for the chat GGUF model via llama-cpp-python."""

from __future__ import annotations

import os
import re
import threading
from typing import Any

from . import config
from .ops import extract_ops_payload, validate_ops
from .prompts import SYSTEM, build_user_message, history_messages

_THINK_RE = re.compile(r"<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE)

_lock = threading.Lock()
_chat = None
_chat_error: str | None = None


def _import_llama():
    try:
        from llama_cpp import Llama  # type: ignore

        return Llama, None
    except Exception as exc:  # noqa: BLE001
        return None, (
            "llama-cpp-python is not installed (%s). See llm/requirements-assistant.txt and llm/README.md."
            % exc
        )


def _gpu_offload_supported() -> bool:
    try:
        from llama_cpp import llama_supports_gpu_offload  # type: ignore

        fn = llama_supports_gpu_offload
        return bool(fn() if callable(fn) else fn)
    except Exception:  # noqa: BLE001
        return False


def unload_models() -> None:
    """Drop cached Llama instances so the next load picks up new settings."""
    global _chat, _chat_error
    with _lock:
        _chat = None
        _chat_error = None


def status() -> dict[str, Any]:
    chat_ok = os.path.isfile(config.CHAT_GGUF)
    Llama, import_err = _import_llama()
    ready = bool(Llama) and chat_ok
    err = None
    if import_err:
        err = import_err
    elif not chat_ok:
        err = "Missing llm/models/chat.gguf — see llm/README.md."

    settings = config.load_settings()
    gpu_enabled = bool(settings.get("gpuEnabled"))
    n_layers = config._clamp_layers(settings.get("nGpuLayers", -1))
    gpu_ok = _gpu_offload_supported() if Llama else False
    gpu_hint = None
    if gpu_enabled and Llama and not gpu_ok:
        gpu_hint = (
            "GPU is enabled in Settings, but this llama-cpp-python build cannot offload. "
            "Install the Vulkan wheel: python tools/install_assistant.py vulkan — then restart GanttLocal."
        )
    elif gpu_enabled and gpu_ok:
        gpu_hint = "GPU offload active (%s layers)." % (
            "all" if config.effective_n_gpu_layers() < 0 else config.effective_n_gpu_layers()
        )
    elif not gpu_enabled:
        gpu_hint = "CPU mode. Enable GPU in Settings after: python tools/install_assistant.py vulkan"

    return {
        "ready": ready,
        "chatModel": config.CHAT_GGUF if chat_ok else None,
        "error": err,
        "nGpuLayers": n_layers,
        "gpuEnabled": gpu_enabled,
        "gpuOffloadSupported": gpu_ok,
        "gpuHint": gpu_hint,
        "effectiveNGpuLayers": config.effective_n_gpu_layers(),
        "nCtx": config.N_CTX,
    }


def get_chat():
    global _chat, _chat_error
    with _lock:
        if _chat is not None:
            return _chat
        if _chat_error:
            raise RuntimeError(_chat_error)
        Llama, import_err = _import_llama()
        if import_err:
            _chat_error = import_err
            raise RuntimeError(_chat_error)
        if not os.path.isfile(config.CHAT_GGUF):
            _chat_error = "Missing llm/models/chat.gguf"
            raise RuntimeError(_chat_error)
        try:
            _chat = Llama(
                model_path=config.CHAT_GGUF,
                n_ctx=config.N_CTX,
                n_threads=config.N_THREADS,
                n_gpu_layers=config.effective_n_gpu_layers(),
                verbose=False,
            )
            _disable_thinking(_chat)
        except Exception as exc:  # noqa: BLE001
            _chat_error = "Failed to load chat.gguf: %s" % exc
            raise RuntimeError(_chat_error) from exc
        return _chat


def _disable_thinking(model) -> None:
    """Force Qwen3 chat templates to use enable_thinking=False."""
    base = getattr(model, "chat_handler", None)
    if base is None:
        handlers = getattr(model, "_chat_handlers", None) or {}
        base = handlers.get(getattr(model, "chat_format", None))
    if base is None:
        try:
            from llama_cpp import llama_chat_format  # type: ignore

            base = llama_chat_format.get_chat_completion_handler(model.chat_format)
        except Exception:  # noqa: BLE001
            return

    def chat_handler(*args, **kwargs):
        kwargs["enable_thinking"] = False
        return base(*args, **kwargs)

    model.chat_handler = chat_handler


def _strip_think(text: str) -> str:
    if not text:
        return ""
    out = _THINK_RE.sub("", text)
    cut = out.lower().find("<think>")
    if cut >= 0:
        out = out[:cut]
    return out.strip()


def _decision_summary(ops: list[dict[str, Any]]) -> str:
    if not ops:
        return "No schedule changes."
    counts: dict[str, int] = {}
    for op in ops:
        key = str(op.get("op") or "edit")
        counts[key] = counts.get(key, 0) + 1
    bits = []
    for key, n in counts.items():
        bits.append("%s ×%d" % (key, n) if n > 1 else key)
    return "Will apply: %s." % ", ".join(bits)


def _stream_delta_text(chunk) -> str:
    choice = chunk["choices"][0] if isinstance(chunk, dict) else chunk.choices[0]
    delta = choice.get("delta") if isinstance(choice, dict) else getattr(choice, "delta", None)
    if delta is None:
        return ""
    text = delta.get("content") if isinstance(delta, dict) else getattr(delta, "content", None)
    return text or ""


def _completion_stream(model, messages: list[dict[str, str]]):
    """Yield content deltas from a streaming chat completion."""
    stream = model.create_chat_completion(
        messages=messages,
        temperature=0.15,
        max_tokens=config.CHAT_MAX_TOKENS,
        stream=True,
    )
    for chunk in stream:
        text = _stream_delta_text(chunk)
        if text:
            yield text


def _char_token_est(text: str) -> int:
    """Cheap fallback when the model tokenizer is unavailable."""
    if not text:
        return 0
    return max(1, (len(text) + 3) // 4)


def _tokenize_len(model, text: str) -> int:
    if not text:
        return 0
    try:
        # Single encode + tokenize; avoid per-message round-trips at call sites.
        return len(model.tokenize(text.encode("utf-8"), add_bos=False))
    except Exception:  # noqa: BLE001
        return _char_token_est(text)


def _usage_dict(used: int, n_ctx: int) -> dict[str, Any]:
    used = min(max(0, used), n_ctx) if n_ctx else 0
    pct = int(round(100.0 * used / n_ctx)) if n_ctx else 0
    return {"used": used, "max": n_ctx, "pct": min(100, pct)}


def usage_for_messages(messages: list[dict[str, str]], model=None) -> dict[str, Any]:
    """Estimate prompt tokens vs context window."""
    n_ctx = config.N_CTX
    n_msg = max(1, len(messages))
    overhead = 4 * n_msg
    if model is not None:
        # One tokenizer call for all contents (UI estimate; role markup ≈ overhead).
        parts: list[str] = []
        for msg in messages:
            content = msg.get("content") or ""
            if content:
                parts.append(content)
        used = (_tokenize_len(model, "\n".join(parts)) if parts else 0) + overhead
    else:
        used = overhead
        for msg in messages:
            content = msg.get("content") or ""
            used += _char_token_est(content) if content else 1
    return _usage_dict(used, n_ctx)


def extend_usage(base: dict[str, Any], text: str, model=None) -> dict[str, Any]:
    """Add tokens for one more message without re-tokenizing prior prompt text."""
    n_ctx = int(base.get("max") or config.N_CTX)
    add = (_tokenize_len(model, text) if model is not None else _char_token_est(text)) + 4
    return _usage_dict(int(base.get("used") or 0) + add, n_ctx)


def build_prompt_messages(
    project_name: str,
    user_text: str,
    doc: dict[str, Any],
    history: list[dict[str, Any]],
) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = [{"role": "system", "content": SYSTEM}]
    messages.extend(history_messages(history))
    messages.append(
        {
            "role": "user",
            "content": build_user_message(user_text or "", doc),
        }
    )
    return messages


def estimate_context_usage(
    project_name: str,
    user_text: str,
    doc: dict[str, Any],
    history: list[dict[str, Any]],
) -> dict[str, Any]:
    """Token usage for the next prompt; uses the chat model tokenizer when loaded."""
    messages = build_prompt_messages(project_name, user_text, doc, history)
    model = None
    global _chat
    with _lock:
        model = _chat
    if model is None:
        return usage_for_messages(messages, model=None)
    return usage_for_messages(messages, model=model)


def chat_completion_agent_stream(
    project_name: str,
    user_text: str,
    doc: dict[str, Any],
    history: list[dict[str, Any]],
    cancelled=None,
):
    """Stream one chat completion, then yield a done event with validated ops.

    cancelled: optional callable returning True when the turn was invalidated
    (e.g. Clear Chat). Stops generation without a done event.
    """

    def _cancelled() -> bool:
        return bool(cancelled and cancelled())

    model = get_chat()
    messages = build_prompt_messages(project_name, user_text, doc, history)
    if _cancelled():
        return
    prompt_usage = usage_for_messages(messages, model=model)
    yield {"type": "usage", **prompt_usage}
    yield {"type": "status", "text": "Thinking…"}

    parts: list[str] = []
    for delta in _completion_stream(model, messages):
        if _cancelled():
            return
        parts.append(delta)
        yield {"type": "token", "text": delta}

    if _cancelled():
        return
    content = _strip_think("".join(parts).strip())
    reply, raw_ops = extract_ops_payload(content)
    validated = validate_ops(raw_ops, doc)
    if not (reply or "").strip():
        reply = _decision_summary(validated.get("ops") or [])
    usage = extend_usage(prompt_usage, content, model=model)
    if _cancelled():
        return
    yield {
        "type": "done",
        "reply": reply,
        "ops": validated.get("ops") or [],
        "rejected": validated.get("rejected") or [],
        "raw": content,
        "usage": usage,
    }
