"""Paths and knobs for the local GGUF assistant."""

from __future__ import annotations

import json
import os
from typing import Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
ASSISTANT_DIR = os.path.join(DATA_DIR, ".assistant")
MODELS_DIR = os.path.join(ROOT, "llm", "models")
SETTINGS_PATH = os.path.join(ROOT, "llm", "settings.json")
CHAT_GGUF = os.path.join(MODELS_DIR, "chat.gguf")

N_CTX = int(os.environ.get("GANTT_LLM_N_CTX", "4096"))
N_THREADS = int(os.environ.get("GANTT_LLM_THREADS", str(max(1, (os.cpu_count() or 4) - 1))))
CHAT_MAX_TOKENS = int(os.environ.get("GANTT_LLM_MAX_TOKENS", "1024"))
CHAT_HISTORY_CAP = 40

_DEFAULT_SETTINGS = {"gpuEnabled": True, "nGpuLayers": -1}

# (mtime | None for defaults/env, settings dict)
_settings_cache: tuple[float | None, dict[str, Any]] | None = None


def project_assistant_dir(name: str) -> str:
    return os.path.join(ASSISTANT_DIR, name)


def ensure_project_dirs(name: str) -> str:
    base = project_assistant_dir(name)
    os.makedirs(base, exist_ok=True)
    return base


def _clamp_layers(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return -1
    if n < -1:
        return -1
    if n > 999:
        return 999
    return n


def load_settings() -> dict[str, Any]:
    """Load app-level assistant settings. File wins over env when present."""
    global _settings_cache
    if os.path.isfile(SETTINGS_PATH):
        try:
            mtime = os.path.getmtime(SETTINGS_PATH)
        except OSError:
            mtime = None
        if _settings_cache is not None and _settings_cache[0] == mtime:
            return dict(_settings_cache[1])
        try:
            with open(SETTINGS_PATH, "rb") as fh:
                raw = json.loads(fh.read())
            if not isinstance(raw, dict):
                raw = {}
        except (OSError, ValueError):
            raw = {}
        result = {
            "gpuEnabled": bool(raw.get("gpuEnabled", True)),
            "nGpuLayers": _clamp_layers(raw.get("nGpuLayers", -1)),
        }
        _settings_cache = (mtime, result)
        return dict(result)

    if _settings_cache is not None and _settings_cache[0] is None:
        return dict(_settings_cache[1])

    env_layers = os.environ.get("GANTT_LLM_GPU_LAYERS")
    if env_layers is not None and str(env_layers).strip() != "":
        layers = _clamp_layers(env_layers)
        result = {"gpuEnabled": layers != 0, "nGpuLayers": -1 if layers == 0 else layers}
    else:
        result = dict(_DEFAULT_SETTINGS)
    _settings_cache = (None, result)
    return dict(result)


def save_settings(settings: dict[str, Any]) -> dict[str, Any]:
    global _settings_cache
    cleaned = {
        "gpuEnabled": bool(settings.get("gpuEnabled", True)),
        "nGpuLayers": _clamp_layers(settings.get("nGpuLayers", -1)),
    }
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    tmp = SETTINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cleaned, fh, indent=1)
        fh.write("\n")
    os.replace(tmp, SETTINGS_PATH)
    try:
        mtime = os.path.getmtime(SETTINGS_PATH)
    except OSError:
        mtime = None
    _settings_cache = (mtime, cleaned)
    return dict(cleaned)


def effective_n_gpu_layers() -> int:
    settings = load_settings()
    if not settings.get("gpuEnabled"):
        return 0
    return _clamp_layers(settings.get("nGpuLayers", -1))
