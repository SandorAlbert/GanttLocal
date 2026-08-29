#!/usr/bin/env python3
"""Install optional Chat dependencies without using .cmd files.

Usage (from the GanttLocal project root):

    python tools/install_assistant.py          # CPU wheel
    python tools/install_assistant.py vulkan   # Vulkan GPU wheel (NVIDIA/AMD/Intel)
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQ = ROOT / "requirements.txt"
REQ_FALLBACK = ROOT / "llm" / "requirements-assistant.txt"
VULKAN_INDEX = "https://abetlen.github.io/llama-cpp-python/whl/vulkan"


def run(args: list[str]) -> None:
    print("+", " ".join(args), flush=True)
    subprocess.check_call(args)


def try_run(args: list[str]) -> bool:
    print("+", " ".join(args), flush=True)
    return subprocess.call(args) == 0


def main() -> int:
    mode = (sys.argv[1] if len(sys.argv) > 1 else "cpu").strip().lower()
    if mode in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    if mode not in ("cpu", "vulkan"):
        print("Unknown mode %r. Use: cpu | vulkan" % mode, file=sys.stderr)
        return 2

    py = sys.executable
    req = REQ if REQ.is_file() else REQ_FALLBACK
    try:
        try_run([py, "-m", "ensurepip", "--upgrade"])
        run([py, "-m", "pip", "install", "--upgrade", "pip"])
        run([py, "-m", "pip", "install", "-r", str(req)])
        if mode == "vulkan":
            run(
                [
                    py,
                    "-m",
                    "pip",
                    "install",
                    "llama-cpp-python",
                    "--force-reinstall",
                    "--no-cache-dir",
                    "--extra-index-url",
                    VULKAN_INDEX,
                ]
            )
    except subprocess.CalledProcessError as exc:
        print("Install failed (exit %s). See llm/README.md" % exc.returncode, file=sys.stderr)
        return exc.returncode or 1

    print()
    if mode == "cpu":
        print("Done. Place llm/models/chat.gguf, then restart GanttLocal.")
    else:
        print("Done. In GanttLocal: Settings > Assistant > Use GPU. Restart if the server was already running.")

    try:
        sys.path.insert(0, str(ROOT))
        from assistant import service

        print(json.dumps(service.get_status(), indent=2))
    except Exception as exc:  # noqa: BLE001
        print("Installed, but status check failed:", exc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
