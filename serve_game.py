#!/usr/bin/env python3
"""ASHEN OATH - local static server.

Serves ONLY this project folder, bound to loopback (127.0.0.1), on the first
free port from a small range, then opens the browser once the server is ready.
Standard library only: no Flask, no third-party packages, nothing is installed.

Usage:  python serve_game.py [--port N] [--no-browser]
Stop:   Ctrl+C in this window (or just close the window).
"""
import argparse
import http.server
import os
import socket
import sys
import threading
import urllib.parse
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
PORT_RANGE = range(8765, 8790)

# Files that are part of the tooling, not of the web app.
HIDDEN_SUFFIXES = (".py", ".cmd", ".bat", ".ps1", ".pyc")


class GameHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".task": "application/octet-stream",
        ".md": "text/plain; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        raw = self.path.split("?", 1)[0].split("#", 1)[0]
        path = urllib.parse.unquote(raw)
        # Windows: «file.py.», «file.py » и потоки NTFS «file:stream» ведут к тому же файлу.
        segments = [seg.rstrip(". ") for seg in path.replace("\\", "/").split("/")]
        bad = ":" in path or any(seg.startswith(".") for seg in segments if seg)
        name = segments[-1] if segments else ""
        if bad or name.lower().endswith(HIDDEN_SUFFIXES):
            self.send_error(404, "Not found")
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404, "Directory listing disabled")
        return None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        # Camera for this origin only; microphone and geolocation are not used.
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("ASHEN_VERBOSE"):
            super().log_message(fmt, *args)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # never share a port with another process


def bind(port_hint):
    ports = [port_hint] if port_hint else list(PORT_RANGE) + [0]
    last_err = None
    for port in ports:
        try:
            return Server((HOST, port), GameHandler)
        except OSError as err:
            last_err = err
    raise SystemExit(f"Could not open a local port: {last_err}")


def main():
    parser = argparse.ArgumentParser(description="ASHEN OATH local server")
    parser.add_argument("--port", type=int, default=0, help="fixed port (default: first free 8765-8789)")
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser")
    args = parser.parse_args()

    if sys.version_info < (3, 7):
        raise SystemExit("Python 3.7+ is required.")
    if not os.path.isfile(os.path.join(ROOT, "index.html")):
        raise SystemExit(f"index.html not found next to serve_game.py ({ROOT}). Unpack the whole archive.")

    httpd = bind(args.port)
    port = httpd.server_address[1]
    url = f"http://{HOST}:{port}/"

    # The socket is already listening; start serving, then open the browser.
    thread = threading.Thread(target=httpd.serve_forever, name="ashen-http", daemon=True)
    thread.start()
    try:
        with socket.create_connection((HOST, port), timeout=3):
            pass
    except OSError as err:
        raise SystemExit(f"Server did not start: {err}")

    print("=" * 60)
    print(" ASHEN OATH is running")
    print(f" Open in Chrome or Edge:  {url}")
    print(" Folder served:", ROOT)
    print(" Only this computer can connect (127.0.0.1).")
    print(" Keep this window open while playing. Ctrl+C to stop.")
    print("=" * 60, flush=True)

    if not args.no_browser:
        try:
            webbrowser.open(url, new=2)
        except Exception as err:  # noqa: BLE001 - never fail because of the browser
            print(f"Could not open the browser automatically ({err}). Open {url} manually.")

    try:
        while thread.is_alive():
            thread.join(0.5)
    except KeyboardInterrupt:
        print("\nStopping server...")
    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    main()
