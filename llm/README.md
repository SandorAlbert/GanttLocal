# Local assistant models

The optional Chat dock uses GGUF weights loaded in-process by `llama-cpp-python`.
The rest of GanttLocal still runs with the Python standard library only.

## Files

Place these under `llm/models/`:

| File | Role |
|------|------|
| `chat.gguf` | Instruct chat model (e.g. Qwen3-14B Q4_K_M) |
| `settings.json` | Created by the app: GPU on/off and layer count |

### Chat model (recommended for AMD RX 6800 / 16 GB VRAM)

**Qwen3-14B Q4_K_M** (GGUF):

https://huggingface.co/bartowski/Qwen_Qwen3-14B-GGUF/resolve/main/Qwen_Qwen3-14B-Q4_K_M.gguf

Download and save as:

```text
llm/models/chat.gguf
```

A 32B model is too heavy for 16 GB VRAM with a useful context; 14B Q4_K_M is the intended fit.

Qwen3 thinking mode is disabled in the chat template (`enable_thinking=false`) and with `/no_think` in the system prompt, so replies go straight to ops instead of a reasoning block.

## Install Python deps (Windows)

PyPI often has **no** Windows binary for `llama-cpp-python`, so a plain
`pip install llama-cpp-python` tries to compile and fails without Visual Studio
(`nmake` / `CMAKE_C_COMPILER` errors).

If your company blocks `.cmd` files, use **Python or pip only** (from the GanttLocal folder):

### CPU (default)

```bat
python tools/install_assistant.py
```

Same thing with pip:

```bat
python -m pip install -r llm/requirements-assistant.txt
```

Expect CPU-only inference (a 14B Q4 model will be slow).

### GPU via Vulkan (NVIDIA / AMD / Intel)

```bat
python tools/install_assistant.py vulkan
```

Or:

```bat
python -m pip install llama-cpp-python --force-reinstall --no-cache-dir --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/vulkan
```

Then in GanttLocal: **Settings → Assistant → Use GPU** (layers `-1` = all). The next chat
message reloads the model with offload. Restart the app after switching wheels.

If GPU is enabled but status says the wheel has no offload, you still have the CPU
package — run the Vulkan install again.

### If you must build from source

Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
with the **Desktop development with C++** workload, then:

```bat
python -m pip install llama-cpp-python --no-binary llama-cpp-python
```

For a Vulkan source build: `CMAKE_ARGS="-DGGML_VULKAN=on"`.

## Check

```bat
python -c "from assistant import service; print(service.get_status())"
```

`ready` should be `true` when `chat.gguf` is present and `llama_cpp` imports.
`gpuOffloadSupported` should be `true` after the Vulkan wheel. Replies stream
token-by-token over SSE.
