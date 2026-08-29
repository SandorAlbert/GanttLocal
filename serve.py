"""Local-only static file server + JSON project store for GanttLocal.

Standard library only. Binds to 127.0.0.1 so Windows Firewall never prompts.

    python serve.py [port] [--auto-exit] [--app-window] [--no-browser]

--auto-exit   stop the server once the last app window is gone
--app-window  open a plain window without tabs or address bar, if a
              Chromium based browser is installed
"""

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
BACKUP_DIR = os.path.join(DATA_DIR, ".backups")
BACKUPS_KEPT = 10
MAX_BODY = 32 * 1024 * 1024
MAX_ASSISTANT_BODY = 4 * 1024 * 1024

NAME_RE = re.compile(r"^[A-Za-z0-9 _.\-]{1,64}$")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

_write_lock = threading.Lock()
_static_cache_lock = threading.Lock()
_static_cache = {}  # abs path -> (mtime, bytes)
_export_shell_lock = threading.Lock()
_export_shell = None  # (mtime_sig, html_with_placeholder)
_EXPORT_VIEW_MARK = "/*__GANTT_VIEW__*/"

# Each open app window holds one /api/session connection. Counting them is how
# the server knows whether anybody is still using it. A timer-based heartbeat
# would not work: browsers throttle timers in windows that are not in front.
_clients_lock = threading.Lock()
_clients = 0
_ever_connected = False
IDLE_GRACE = 5.0        # seconds after the last window closes, survives a reload
STARTUP_GRACE = 60.0    # give up if no window ever connects

AUTO_EXIT = False
SERVER = None


def project_path(name):
    """Absolute path for a project name, or None if the name is unsafe."""
    if not NAME_RE.match(name or ""):
        return None
    return os.path.join(DATA_DIR, name + ".json")


def assistant_project_dir(name):
    if not NAME_RE.match(name or ""):
        return None
    return os.path.join(DATA_DIR, ".assistant", name)


def rename_project(old_name, new_name):
    """Rename project file and matching assistant folder. Raises ValueError on conflict."""
    if old_name == new_name:
        return
    old_path = project_path(old_name)
    new_path = project_path(new_name)
    if not old_path or not new_path:
        raise ValueError("invalid name")
    if not os.path.exists(old_path):
        raise ValueError("project not found")
    if os.path.exists(new_path):
        raise ValueError("a project named %s already exists" % new_name)
    os.replace(old_path, new_path)
    old_assist = assistant_project_dir(old_name)
    new_assist = assistant_project_dir(new_name)
    if old_assist and os.path.isdir(old_assist):
        if new_assist and os.path.exists(new_assist):
            raise ValueError("assistant data already exists for %s" % new_name)
        os.makedirs(os.path.dirname(new_assist), exist_ok=True)
        os.replace(old_assist, new_assist)


def prune_backups(name):
    prefix = name + "."
    try:
        entries = [f for f in os.listdir(BACKUP_DIR) if f.startswith(prefix)]
    except OSError:
        return
    entries.sort()
    for stale in entries[:-BACKUPS_KEPT]:
        try:
            os.remove(os.path.join(BACKUP_DIR, stale))
        except OSError:
            pass


def write_project(name, raw):
    """Atomic write plus a rolling backup of the previous contents.

    Backups use a rename (no full-file copy). If the new write fails after the
    rename, the previous file is moved back into place.
    """
    path = project_path(name)
    with _write_lock:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        moved_to = None
        if os.path.exists(path):
            stamp = time.strftime("%Y%m%d-%H%M%S")
            backup = os.path.join(BACKUP_DIR, "%s.%s.json" % (name, stamp))
            if not os.path.exists(backup):
                os.replace(path, backup)
                moved_to = backup
            prune_backups(name)
        tmp = path + ".tmp"
        try:
            with open(tmp, "wb") as fh:
                fh.write(raw)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        except Exception:
            if moved_to and not os.path.exists(path) and os.path.exists(moved_to):
                try:
                    os.replace(moved_to, path)
                except OSError:
                    pass
            raise
    return os.path.getmtime(path)


def read_file_cached(full):
    """Read file bytes; reuse an in-process cache when mtime is unchanged."""
    mtime = os.path.getmtime(full)
    with _static_cache_lock:
        hit = _static_cache.get(full)
        if hit is not None and hit[0] == mtime:
            return hit[1]
    with open(full, "rb") as fh:
        body = fh.read()
    with _static_cache_lock:
        _static_cache[full] = (mtime, body)
    return body


def assistant_service():
    """Lazy import so the core app runs without llama-cpp-python.

    Returns the service module, or (None, error) on import failure.
    """
    try:
        from assistant import service as svc

        return svc
    except Exception as exc:  # noqa: BLE001
        return (None, str(exc))


# --- view-only HTML export -----------------------------------------------

_MODULE_FILES = (
    ("schedule", "js/schedule.js"),
    ("model", "js/model.js"),
    ("timeline", "js/timeline.js"),
    ("grid", "js/grid.js"),
    ("store", "js/store.js"),
    ("markdown", "js/markdown.js"),
    ("chat", "js/chat.js"),
    ("app", "js/app.js"),
)

_IMPORT_RE = re.compile(
    r"^import\s+\{([^}]+)\}\s+from\s+['\"]\./([^'\"]+)['\"]\s*;\s*$",
    re.M,
)
_EXPORT_NAME_RE = re.compile(
    r"^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)",
    re.M,
)
_EXPORT_PREFIX_RE = re.compile(r"^export\s+", re.M)


def _read_text(rel):
    return read_file_cached(os.path.join(ROOT, rel)).decode("utf-8")


def _module_key(spec):
    return os.path.splitext(os.path.basename(spec.replace("\\", "/")))[0]


def wrap_module(name, source):
    """Turn one ES module into an IIFE that reads/writes the M registry."""
    imports = []

    def take_import(match):
        imports.append((match.group(1).strip(), _module_key(match.group(2))))
        return ""

    body = _IMPORT_RE.sub(take_import, source)
    exports = _EXPORT_NAME_RE.findall(body)
    body = _EXPORT_PREFIX_RE.sub("", body)
    if re.search(r"^import\s", body, re.M):
        raise ValueError("unhandled import in %s.js" % name)
    if re.search(r"^export\s", body, re.M):
        raise ValueError("unhandled export in %s.js" % name)
    prelude = "".join(
        "  const { %s } = M.%s;\n" % (names, mod) for names, mod in imports
    )
    ret = ("\n  return { %s };" % ", ".join(exports)) if exports else ""
    return "M.%s = (function () {\n%s%s%s\n})();\n" % (name, prelude, body, ret)


def _safe_inline(text, closer):
    """Stop an inline </script> or </style> in source from breaking the page."""
    needle = "</" + closer
    return re.sub(re.escape(needle), "<\\/" + closer, text, flags=re.I)


def _export_asset_sig():
    paths = [os.path.join(ROOT, "styles.css"), os.path.join(ROOT, "index.html")]
    paths.extend(os.path.join(ROOT, rel) for _, rel in _MODULE_FILES)
    return tuple(os.path.getmtime(p) for p in paths)


def _build_export_shell():
    """HTML shell with a marker where the project snapshot is injected."""
    css = _safe_inline(_read_text("styles.css"), "style")
    parts = [_EXPORT_VIEW_MARK + "\n", "const M = {};\n"]
    for mod_name, rel in _MODULE_FILES:
        parts.append(wrap_module(mod_name, _read_text(rel)))
        parts.append("\n")
    js = _safe_inline("".join(parts), "script")

    html = _read_text("index.html")
    html = re.sub(
        r'<meta http-equiv="Content-Security-Policy" content="[^"]*">',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
        'script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; '
        "base-uri 'none'; form-action 'none'\">",
        html,
        count=1,
    )
    html = html.replace("<body>", '<body class="view-only">', 1)
    html = html.replace(
        '<link rel="stylesheet" href="styles.css">',
        "<style>\n%s\n</style>" % css,
        1,
    )
    html = html.replace(
        '<script type="module" src="js/app.js"></script>',
        "<script>\n%s\n</script>" % js,
        1,
    )
    if 'src="js/app.js"' in html or 'href="styles.css"' in html:
        raise ValueError("export template still points at external files")
    if _EXPORT_VIEW_MARK not in html:
        raise ValueError("export shell missing view marker")
    return html


def _cached_export_shell():
    global _export_shell
    sig = _export_asset_sig()
    with _export_shell_lock:
        if _export_shell is not None and _export_shell[0] == sig:
            return _export_shell[1]
    shell = _build_export_shell()
    with _export_shell_lock:
        _export_shell = (sig, shell)
    return shell


def build_export_html(name, doc):
    """One self-contained view-only page. `doc` is a parsed project object."""
    view = "window.GANTT_VIEW = { name: %s, doc: %s };" % (
        json.dumps(name),
        json.dumps(doc, ensure_ascii=False).replace("<", "\\u003c"),
    )
    html = _cached_export_shell().replace(_EXPORT_VIEW_MARK, view, 1)
    return html.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "GanttLocal"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # --- helpers ---------------------------------------------------------

    def loopback_only(self):
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self.send_error(403, "Loopback only")
            return False
        return True

    def send_payload(self, body, ctype, status=200, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_payload(
            json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8", status
        )

    # --- routes ----------------------------------------------------------

    def do_GET(self):
        if not self.loopback_only():
            return
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            self.api_get(url)
        else:
            self.static(url.path)

    do_HEAD = do_GET

    def do_PUT(self):
        if not self.loopback_only():
            return
        url = urlparse(self.path)
        if url.path.startswith("/api/assistant/"):
            self.api_assistant(url, "PUT")
            return
        if url.path != "/api/project":
            self.send_error(404, "Not found")
            return
        name = (parse_qs(url.query).get("name") or [""])[0]
        if not project_path(name):
            self.send_json({"error": "invalid name"}, 400)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self.send_json({"error": "bad length"}, 400)
            return
        raw = self.rfile.read(length)
        try:
            json.loads(raw)
        except (ValueError, UnicodeDecodeError, TypeError):
            self.send_json({"error": "body is not valid JSON"}, 400)
            return
        # Refuse to clobber a file that changed on disk since the client read it.
        expected = self.headers.get("X-If-Mtime")
        path = project_path(name)
        if expected and os.path.exists(path):
            try:
                if abs(os.path.getmtime(path) - float(expected)) > 0.002:
                    self.send_json(
                        {"error": "stale", "mtime": os.path.getmtime(path)}, 409
                    )
                    return
            except ValueError:
                pass
        os.makedirs(DATA_DIR, exist_ok=True)
        try:
            mtime = write_project(name, raw)
        except OSError as exc:
            self.send_json({"error": str(exc)}, 500)
            return
        self.send_json({"ok": True, "mtime": mtime})

    def do_POST(self):
        if not self.loopback_only():
            return
        url = urlparse(self.path)
        if url.path.startswith("/api/assistant/"):
            self.api_assistant(url, "POST")
            return
        if url.path == "/api/project/rename":
            qs = parse_qs(url.query)
            old_name = (qs.get("name") or qs.get("from") or [""])[0]
            new_name = (qs.get("newName") or qs.get("to") or [""])[0]
            try:
                rename_project(old_name, new_name)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except OSError as exc:
                self.send_json({"error": str(exc)}, 500)
                return
            self.send_json({"ok": True, "name": new_name})
            return
        self.send_error(404, "Not found")

    def do_DELETE(self):
        if not self.loopback_only():
            return
        url = urlparse(self.path)
        if url.path.startswith("/api/assistant/"):
            self.api_assistant(url, "DELETE")
            return
        if url.path != "/api/project":
            self.send_error(404, "Not found")
            return
        name = (parse_qs(url.query).get("name") or [""])[0]
        path = project_path(name)
        if not path:
            self.send_json({"error": "invalid name"}, 400)
            return
        if os.path.exists(path):
            try:
                os.makedirs(BACKUP_DIR, exist_ok=True)
                stamp = time.strftime("%Y%m%d-%H%M%S")
                os.replace(path, os.path.join(BACKUP_DIR, "%s.%s.deleted.json" % (name, stamp)))
            except OSError as exc:
                self.send_json({"error": str(exc)}, 500)
                return
        self.send_json({"ok": True})

    def read_body(self, limit=MAX_BODY):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > limit:
            return None
        return self.rfile.read(length)

    def api_assistant(self, url, method):
        loaded = assistant_service()
        if isinstance(loaded, tuple):
            self.send_json(
                {
                    "error": loaded[1],
                    "hint": "pip install -r llm/requirements-assistant.txt and see llm/README.md",
                },
                503,
            )
            return
        svc = loaded
        qs = parse_qs(url.query)
        name = (qs.get("name") or [""])[0]
        path = url.path

        if path == "/api/assistant/status" and method == "GET":
            self.send_json(svc.get_status())
            return
        if path == "/api/assistant/settings" and method == "GET":
            self.send_json(svc.get_settings())
            return
        if path == "/api/assistant/settings" and method == "PUT":
            body = self.read_body()
            if body is None:
                self.send_json({"error": "bad length"}, 400)
                return
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                self.send_json({"error": "body is not valid JSON"}, 400)
                return
            if not isinstance(payload, dict):
                self.send_json({"error": "invalid body"}, 400)
                return
            self.send_json(svc.update_settings(payload))
            return

        if path in (
            "/api/assistant/chat",
            "/api/assistant/ops-status",
            "/api/assistant/context",
        ):
            if not project_path(name):
                self.send_json({"error": "invalid name"}, 400)
                return

        try:
            if path == "/api/assistant/context" and method == "POST":
                body = self.read_body(MAX_ASSISTANT_BODY)
                if body is None:
                    self.send_json({"error": "bad length"}, 400)
                    return
                try:
                    payload = json.loads(body)
                except (ValueError, UnicodeDecodeError):
                    self.send_json({"error": "body is not valid JSON"}, 400)
                    return
                message = (payload or {}).get("message") or ""
                project = (payload or {}).get("project")
                try:
                    self.send_json(svc.estimate_context(name, message, project or {}))
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, 400)
                return
            if path == "/api/assistant/chat" and method == "GET":
                self.send_json(svc.get_chat(name))
                return
            if path == "/api/assistant/chat" and method == "DELETE":
                self.send_json(svc.clear_chat(name))
                return
            if path == "/api/assistant/chat" and method == "POST":
                body = self.read_body(MAX_ASSISTANT_BODY)
                if body is None:
                    self.send_json({"error": "bad length"}, 400)
                    return
                try:
                    payload = json.loads(body)
                except (ValueError, UnicodeDecodeError):
                    self.send_json({"error": "body is not valid JSON"}, 400)
                    return
                message = payload.get("message") if isinstance(payload, dict) else None
                project = payload.get("project") if isinstance(payload, dict) else None
                st = svc.get_status()
                if not st.get("ready"):
                    self.send_json(
                        {
                            "error": st.get("error") or "Assistant is not ready",
                            "hint": "See llm/requirements-assistant.txt and llm/README.md",
                        },
                        503,
                    )
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                try:
                    for event in svc.chat_stream(name, message or "", project or {}):
                        line = "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
                        self.wfile.write(line.encode("utf-8"))
                        self.wfile.flush()
                        if event.get("type") in ("done", "error"):
                            break
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                return
            if path == "/api/assistant/ops-status" and method == "POST":
                body = self.read_body()
                if body is None:
                    self.send_json({"error": "bad length"}, 400)
                    return
                try:
                    payload = json.loads(body)
                except (ValueError, UnicodeDecodeError):
                    self.send_json({"error": "body is not valid JSON"}, 400)
                    return
                status = (payload or {}).get("status") or ""
                if status not in ("applied", "applied_partial", "rejected"):
                    self.send_json({"error": "invalid status"}, 400)
                    return
                errors = (payload or {}).get("errors")
                if errors is not None and not isinstance(errors, list):
                    self.send_json({"error": "invalid errors"}, 400)
                    return
                self.send_json(svc.mark_ops_status(name, status, errors))
                return
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 400)
            return
        except Exception as exc:  # noqa: BLE001
            self.send_json({"error": str(exc)}, 500)
            return
        self.send_error(404, "Not found")

    def session(self):
        """Stays open for the lifetime of one app window."""
        global _clients, _ever_connected
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(b": open\n\n")
            self.wfile.flush()
        except OSError:
            return
        with _clients_lock:
            _clients += 1
            _ever_connected = True
        try:
            # Returns empty as soon as the window is gone.
            while self.rfile.read(1):
                pass
        except OSError:
            pass
        finally:
            with _clients_lock:
                _clients -= 1
                last = _clients <= 0
            if last and AUTO_EXIT:
                threading.Thread(target=exit_when_idle, daemon=True).start()

    def api_get(self, url):
        if url.path == "/api/ping":
            self.send_response(204)
            self.send_header("X-GanttLocal", "1")
            self.send_header("X-Gantt", "1")
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if url.path == "/api/session":
            self.session()
            return
        if url.path == "/api/projects":
            os.makedirs(DATA_DIR, exist_ok=True)
            names = []
            for entry in sorted(os.listdir(DATA_DIR)):
                if entry.endswith(".json") and NAME_RE.match(entry[:-5]):
                    names.append(entry[:-5])
            self.send_json({"projects": names})
            return
        if url.path == "/api/project":
            name = (parse_qs(url.query).get("name") or [""])[0]
            path = project_path(name)
            if not path:
                self.send_json({"error": "invalid name"}, 400)
                return
            if not os.path.exists(path):
                self.send_json({"error": "not found"}, 404)
                return
            with open(path, "rb") as fh:
                raw = fh.read()
            self.send_payload(
                raw,
                "application/json; charset=utf-8",
                extra={"X-Mtime": "%.6f" % os.path.getmtime(path)},
            )
            return
        if url.path == "/api/export-html":
            name = (parse_qs(url.query).get("name") or [""])[0]
            path = project_path(name)
            if not path:
                self.send_json({"error": "invalid name"}, 400)
                return
            if not os.path.exists(path):
                self.send_json({"error": "not found"}, 404)
                return
            try:
                with open(path, "rb") as fh:
                    doc = json.loads(fh.read())
                body = build_export_html(name, doc)
            except (ValueError, OSError, UnicodeDecodeError) as exc:
                self.send_json({"error": str(exc)}, 500)
                return
            filename = name + ".html"
            self.send_payload(
                body,
                "application/octet-stream",
                extra={
                    "Content-Disposition": 'attachment; filename="%s"' % filename
                },
            )
            return
        if url.path.startswith("/api/assistant/"):
            self.api_assistant(url, "GET")
            return
        self.send_error(404, "Not found")

    def static(self, path):
        rel = path.lstrip("/")
        if rel == "":
            rel = "index.html"
        full = os.path.normpath(os.path.join(ROOT, rel))
        if not full.startswith(ROOT + os.sep) or os.path.isdir(full):
            self.send_error(403, "Forbidden")
            return
        if not os.path.exists(full):
            self.send_error(404, "Not found")
            return
        ext = os.path.splitext(full)[1].lower()
        if ext not in MIME:
            self.send_error(404, "Not found")
            return
        try:
            body = read_file_cached(full)
        except OSError:
            self.send_error(404, "Not found")
            return
        self.send_payload(body, MIME[ext])


def stop_server():
    if SERVER is not None:
        threading.Thread(target=SERVER.shutdown, daemon=True).start()


def exit_when_idle():
    time.sleep(IDLE_GRACE)
    with _clients_lock:
        if _clients > 0:
            return
    stop_server()


def exit_if_never_opened():
    time.sleep(STARTUP_GRACE)
    with _clients_lock:
        if _ever_connected:
            return
    print("No app window connected, stopping.")
    stop_server()


APP_BROWSERS = (
    r"Microsoft\Edge\Application\msedge.exe",
    r"Google\Chrome\Application\chrome.exe",
    r"BraveSoftware\Brave-Browser\Application\brave.exe",
    r"Vivaldi\Application\vivaldi.exe",
    r"Chromium\Application\chrome.exe",
)


def find_app_browser():
    roots = [
        os.environ.get("ProgramFiles", ""),
        os.environ.get("ProgramFiles(x86)", ""),
        os.environ.get("LOCALAPPDATA", ""),
    ]
    for rel in APP_BROWSERS:
        for root in roots:
            if not root:
                continue
            full = os.path.join(root, rel)
            if os.path.exists(full):
                return full
    return None


def open_window(url, app_window):
    """Opens the app, preferring a plain window over a browser tab."""
    exe = find_app_browser() if app_window else None
    if exe:
        base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
        profile = os.path.join(base, "GanttLocal", "window")
        try:
            os.makedirs(profile, exist_ok=True)
            subprocess.Popen(
                [
                    exe,
                    "--app=" + url,
                    "--user-data-dir=" + profile,
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--window-size=1600,950",
                ],
                close_fds=True,
            )
            return
        except OSError:
            pass
    try:
        webbrowser.open(url)
    except Exception:
        print("Open %s in your browser." % url)


def running_instance(port):
    """True when a GanttLocal server already owns the port."""
    try:
        with socket.create_connection(("127.0.0.1", port), 0.4) as probe:
            probe.sendall(b"GET /api/ping HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            answer = probe.recv(512)
    except OSError:
        return False
    return b"X-GanttLocal: 1" in answer or b"X-Gantt: 1" in answer


def pick_port(preferred):
    for port in range(preferred, preferred + 20):
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", port))
            return port
        except OSError:
            continue
        finally:
            probe.close()
    raise SystemExit("No free port in range %d-%d" % (preferred, preferred + 19))


def main():
    global AUTO_EXIT, SERVER
    preferred = 8765
    app_window = False
    open_browser = True
    for arg in sys.argv[1:]:
        if arg == "--auto-exit":
            AUTO_EXIT = True
        elif arg == "--app-window":
            app_window = True
        elif arg == "--no-browser":
            open_browser = False
        else:
            try:
                preferred = int(arg)
            except ValueError:
                pass

    # A second launch attaches to the window of the server already running.
    if running_instance(preferred):
        url = "http://127.0.0.1:%d/" % preferred
        print("Already running at %s, opening another window." % url)
        if open_browser:
            open_window(url, app_window)
        return

    os.makedirs(DATA_DIR, exist_ok=True)
    port = pick_port(preferred)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    SERVER = httpd
    url = "http://127.0.0.1:%d/" % port
    print("GanttLocal running at %s" % url)
    print("Data folder: %s" % DATA_DIR)
    print("Closing the window stops the server." if AUTO_EXIT else "Press Ctrl+C to stop.")
    if open_browser:
        open_window(url, app_window)
    if AUTO_EXIT:
        threading.Thread(target=exit_if_never_opened, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
