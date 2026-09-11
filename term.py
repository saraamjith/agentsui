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


class Terminals:
    """Registry of the pty sessions this server is hosting."""

    def __init__(self):
        self.live = {}
        self.lock = threading.Lock()
        self.seq = 0

    def add(self, label, cwd, pid):
        with self.lock:
            self.seq += 1
            key = f"t{self.seq}"
            self.live[key] = {
                "id": key, "label": label, "cwd": cwd, "pid": pid, "started": time.time(),
            }
        return key

    def drop(self, key):
        with self.lock:
            self.live.pop(key, None)

    def listing(self):
        with self.lock:
            return list(self.live.values())


    def shutdown(self):
        """Hang up every hosted terminal, so stopping the server leaves none behind."""
        for entry in self.listing():
            try:
                os.kill(entry["pid"], signal.SIGHUP)
            except OSError:
                pass


REGISTRY = Terminals()


def serve(handler, argv, cwd, label):
    """Upgrade the connection and relay it to a pty until either side closes."""
    key = handler.headers.get("Sec-WebSocket-Key")
    if not key:
        handler.send_error(400, "expected a websocket upgrade")
        return

    # Only this console may open terminals. Browsers allow cross-origin
    # websockets, so without this any page the user visits could spawn one.
    origin = handler.headers.get("Origin")
    if origin and origin not in handler.allowed_origins():
        handler.send_error(403, "origin not allowed")
        return

    handler.wfile.write((
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_key(key)}\r\n\r\n"
    ).encode())
    handler.wfile.flush()

    sock = handler.connection
    pid, fd = spawn(argv, cwd)
    token = REGISTRY.add(label, cwd, pid)
    reader = FrameReader()
    try:
        _relay(sock, fd, reader)
    finally:
        REGISTRY.drop(token)
        _reap(pid, fd)


def _relay(sock, fd, reader):
    while True:
        try:
            ready, _, _ = select.select([sock, fd], [], [], 60)
        except (OSError, ValueError):
            return
        if not ready:
            try:
                sock.sendall(frame(b"", OP_PING))
            except OSError:
                return
            continue

        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return                       # child exited, pty closed
            if not data:
                return
            try:
                sock.sendall(frame(data, OP_BINARY))
            except OSError:
                return

        if sock in ready:
            try:
                chunk = sock.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            reader.feed(chunk)
            while True:
                got = reader.pop()
                if not got:
                    break
                opcode, payload = got
                if opcode == OP_CLOSE:
                    return
                if opcode == OP_PING:
                    try:
                        sock.sendall(frame(payload, OP_PONG))
                    except OSError:
                        return
                    continue
                if opcode != OP_TEXT:
                    continue
                if not _control(fd, payload):
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


def _reap(pid, fd):
    for sig in (signal.SIGHUP, signal.SIGTERM):
        try:
            os.kill(pid, sig)
        except OSError:
            break
        for _ in range(20):
            try:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
            except OSError:
                break
            time.sleep(0.05)
        else:
            continue
        break
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        os.close(fd)
    except OSError:
        pass
