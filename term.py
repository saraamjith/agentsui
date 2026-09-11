"""PTY-backed terminals exposed over a minimal WebSocket.

Runs a real `claude` process on a pseudo-terminal so the browser gets the
native interface - slash commands, autocomplete, permission prompts and all -
rather than a one-shot prompt. Standard library only.
"""

import base64
import fcntl
import hashlib
import json
import os
import pty
import select
import signal
import struct
import termios
import threading
import time
import uuid

# Markers that identify the Claude Code session this server was started from.
# A terminal we spawn must not inherit them: CLAUDE_CODE_CHILD_SESSION in
# particular turns off transcript saving, which would make the new session
# invisible to this console.
INHERITED = (
    "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_EXECPATH", "CLAUDE_EFFORT",
    "CLAUDE_PID", "CLAUDECODE",
)

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x1, 0x2, 0x8, 0x9, 0xA


# --- websocket wire format --------------------------------------------------

def accept_key(key):
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()


def frame(payload, opcode=OP_BINARY):
    """Server-to-client frame. Never masked, per RFC 6455."""
    n = len(payload)
    head = bytes([0x80 | opcode])
    if n < 126:
        head += bytes([n])
    elif n < 1 << 16:
        head += bytes([126]) + struct.pack(">H", n)
    else:
        head += bytes([127]) + struct.pack(">Q", n)
    return head + payload


class FrameReader:
    """Accumulates bytes and yields whole frames as they complete."""

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data):
        self.buf += data

    def pop(self):
        b = self.buf
        if len(b) < 2:
            return None
        opcode = b[0] & 0x0F
        masked = b[1] & 0x80
        length = b[1] & 0x7F
        i = 2
        if length == 126:
            if len(b) < 4:
                return None
            length = struct.unpack(">H", bytes(b[2:4]))[0]
            i = 4
        elif length == 127:
            if len(b) < 10:
                return None
            length = struct.unpack(">Q", bytes(b[2:10]))[0]
            i = 10
        key = b""
        if masked:
            if len(b) < i + 4:
                return None
            key = bytes(b[i:i + 4])
            i += 4
        if len(b) < i + length:
            return None
        payload = bytearray(b[i:i + length])
        if masked:
            for j in range(length):
                payload[j] ^= key[j % 4]
        del b[:i + length]
        return opcode, bytes(payload)


# --- pseudo-terminal --------------------------------------------------------

def set_size(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def spawn(argv, cwd, rows=40, cols=120):
    """Fork a child on a new pty. Returns (pid, master_fd)."""
    pid, fd = pty.fork()
    if pid == 0:                                   # child
        try:
            os.chdir(cwd or os.path.expanduser("~"))
            for name in INHERITED:
                os.environ.pop(name, None)
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLUMNS"] = str(cols)
            os.environ["LINES"] = str(rows)
            os.execvp(argv[0], argv)
        except BaseException:
            os._exit(127)
    set_size(fd, rows, cols)
    return pid, fd


class HostedTerminal:
    """A PTY owned by the server, independently of browser connections."""

    def __init__(self, argv, cwd, label, agent, client_id, session):
        self.pid, self.fd = spawn(argv, cwd)
        self.info = {
            "id": "t-" + uuid.uuid4().hex, "label": label, "cwd": cwd,
            "pid": self.pid, "started": time.time(), "agent": agent,
            "clientId": client_id, "session": session,
        }
        self.info["clientId"] = client_id or self.info["id"]
        self.lock = threading.Lock()
        self.output = bytearray()
        self.offset = 0
        self.stopping = threading.Event()
        self.finished = threading.Event()
        self.thread = threading.Thread(target=self._read, daemon=True)

    def _read(self):
        try:
            while not self.stopping.is_set():
                if not select.select([self.fd], [], [], .1)[0]:
                    continue
                data = os.read(self.fd, 65536)
                if not data:
                    break
                with self.lock:
                    self.output.extend(data)
                    excess = len(self.output) - 2 * 1024 * 1024
                    if excess > 0:
                        del self.output[:excess]
                        self.offset += excess
        except OSError:
            pass
        finally:
            try:
                _reap(self.pid, self.fd)
            finally:
                self.finished.set()
                REGISTRY.drop(self.info["id"])

    def read_since(self, cursor):
        with self.lock:
            start = max(0, cursor - self.offset)
            return self.offset + len(self.output), bytes(self.output[start:])

    def stop(self):
        self.stopping.set()
        self.thread.join(timeout=5)


class Terminals:
    def __init__(self):
        self.live = {}
        self.lock = threading.Lock()

    def open(self, argv, cwd, label, agent, client_id=None, session=None):
        with self.lock:
            for entry in self.live.values():
                if ((client_id and entry.info["clientId"] == client_id) or
                        (session and entry.info["session"] == session)):
                    return entry
            if len(self.live) >= 6:
                raise ValueError("too many terminals open (6)")
            entry = HostedTerminal(argv, cwd, label, agent, client_id, session)
            self.live[entry.info["id"]] = entry
            entry.thread.start()
            return entry

    def get(self, key):
        with self.lock:
            return self.live.get(key)

    def drop(self, key):
        with self.lock:
            self.live.pop(key, None)

    def listing(self):
        with self.lock:
            return [dict(entry.info) for entry in self.live.values()]

    def shutdown(self):
        with self.lock:
            entries = list(self.live.values())
        for entry in entries:
            entry.stopping.set()
        for entry in entries:
            entry.thread.join(timeout=5)


REGISTRY = Terminals()


def serve(handler, argv=None, cwd=None, label=None, agent=None,
          client_id=None, session=None, terminal_id=None):
    """Connect a browser to a persistent PTY; socket loss only detaches it."""
    key = handler.headers.get("Sec-WebSocket-Key")
    if not key:
        handler.send_error(400, "expected a websocket upgrade")
        return
    origin = handler.headers.get("Origin")
    if origin and origin not in handler.allowed_origins():
        handler.send_error(403, "origin not allowed")
        return
    if terminal_id:
        entry = REGISTRY.get(terminal_id)
        if entry is None:
            handler.send_error(404, "terminal has ended")
            return
    else:
        try:
            entry = REGISTRY.open(argv, cwd, label, agent, client_id, session)
        except ValueError as exc:
            handler.send_error(409, str(exc))
            return

    handler.wfile.write((
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_key(key)}\r\n\r\n"
    ).encode())
    handler.wfile.flush()
    sock = handler.connection
    sock.sendall(frame(json.dumps({"t": "ready", "terminal": entry.info}).encode(), OP_TEXT))
    try:
        _relay(sock, entry, FrameReader())
    except OSError:
        pass  # Browser reload/network loss must not terminate the PTY.


def _relay(sock, entry, reader):
    cursor = 0
    while True:
        cursor, data = entry.read_since(cursor)
        if data:
            sock.sendall(frame(data))
        if entry.finished.is_set():
            sock.sendall(frame(json.dumps({"t": "ended"}).encode(), OP_TEXT))
            sock.sendall(frame(b"", OP_CLOSE))
            return
        if not select.select([sock], [], [], .05)[0]:
            continue
        chunk = sock.recv(65536)
        if not chunk:
            return
        reader.feed(chunk)
        while True:
            got = reader.pop()
            if not got:
                break
            opcode, payload = got
            if opcode == OP_CLOSE:
                sock.sendall(frame(b"", OP_CLOSE))
                return
            if opcode == OP_PING:
                sock.sendall(frame(payload, OP_PONG))
            elif opcode == OP_TEXT:
                try:
                    msg = json.loads(payload)
                except ValueError:
                    continue
                if msg.get("t") == "close":
                    entry.stop()
                    return
                if not _control(entry.fd, payload):
                    return


def _control(fd, payload):
    """Handle one client message. Returns False to hang up."""
    try:
        msg = json.loads(payload)
    except ValueError:
        return True
    kind = msg.get("t")
    if kind == "in":
        try:
            os.write(fd, msg.get("d", "").encode())
        except OSError:
            return False
    elif kind == "size":
        set_size(fd, int(msg.get("rows", 40)), int(msg.get("cols", 120)))
    return True


def _stop_group(pid):
    # pty.fork() makes the child a session/process-group leader. Codex's
    # Node launcher starts a native child in that group; waiting only for
    # the launcher can leave the native child holding the conversation lock.
    launcher_reaped = False
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            # The connection can close before the forked child calls setsid.
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                break
        except PermissionError:
            # macOS can report EPERM for a group containing only zombies.
            # Keep waiting so they can be reaped before escalating again.
            pass
        for _ in range(20):
            try:
                launcher_reaped = bool(os.waitpid(pid, os.WNOHANG)[0])
            except ChildProcessError:
                launcher_reaped = True
            try:
                os.killpg(pid, 0)
            except ProcessLookupError:
                if launcher_reaped:
                    break
            except PermissionError:
                pass
            time.sleep(0.05)
        else:
            continue
        break
    # Reap the launcher even when it was already a zombie on entry.
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


def _reap(pid, fd):
    try:
        _stop_group(pid)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
