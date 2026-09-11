import base64
import http.client
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

import agentsui
import term


class WebSocket:
    def __init__(self, port, query):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=5)
        self.reader = term.FrameReader()
        request = (f'GET /ws/term?{urlencode(query)} HTTP/1.1\r\nHost: localhost:{port}\r\n'
                   'Upgrade: websocket\r\nConnection: Upgrade\r\n'
                   f'Sec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\n'
                   'Sec-WebSocket-Version: 13\r\n\r\n')
        self.sock.sendall(request.encode())
        head = b''
        while b'\r\n\r\n' not in head:
            head += self.sock.recv(4096)
        head, rest = head.split(b'\r\n\r\n', 1)
        assert b'101 Switching' in head, head
        self.reader.feed(rest)
        opcode, payload = self.receive()
        assert opcode == term.OP_TEXT
        self.info = json.loads(payload)['terminal']

    def receive(self):
        while True:
            message = self.reader.pop()
            if message:
                return message
            data = self.sock.recv(65536)
            if not data:
                raise EOFError()
            self.reader.feed(data)

    def until(self, marker):
        output = b''
        while marker not in output:
            opcode, data = self.receive()
            if opcode == term.OP_BINARY:
                output += data
        return output

    def send(self, obj):
        data = json.dumps(obj).encode()
        assert len(data) < 126
        mask = os.urandom(4)
        self.sock.sendall(bytes([0x81, 0x80 | len(data)]) + mask +
                          bytes(c ^ mask[i % 4] for i, c in enumerate(data)))

    def close(self):
        self.sock.close()


class ReconnectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patches = [
            patch.object(agentsui, 'PROJECTS', Path(self.temp.name)),
            patch.object(agentsui, 'CODEX_SESSIONS', Path(self.temp.name)),
            patch.object(agentsui, 'BOARD', agentsui.Board()),
            patch.dict(agentsui.NEW, {'shell': [sys.executable, '-u', '-c',
                       'print("READY", flush=True)\nwhile True:\n print("echo:" + input(), flush=True)']}),
        ]
        for p in self.patches:
            p.start()
        self.server = agentsui.ThreadingHTTPServer(('127.0.0.1', 0), agentsui.Handler)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.sockets = []

    def tearDown(self):
        for ws in self.sockets:
            ws.close()
        term.REGISTRY.shutdown()
        self.server.shutdown()
        self.server.server_close()
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def connect(self, **query):
        ws = WebSocket(self.port, query)
        self.sockets.append(ws)
        return ws

    def request(self, path, body=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        conn.request('GET' if body is None else 'POST', path,
                     body=None if body is None else json.dumps(body),
                     headers={'Content-Type': 'application/json'})
        response = conn.getresponse()
        data = json.loads(response.read())
        self.assertEqual(response.status, 200, data)
        conn.close()
        return data

    def test_new_card_survives_reload_and_explicit_close_ends_process(self):
        ws = self.connect(cwd=self.temp.name, agent='shell', client='new-test')
        ws.until(b'READY')
        pid, key = ws.info['pid'], ws.info['id']
        state = self.request('/api/state')
        card = next(r for r in state['sessions'] if r['id'] == 'new-test')
        self.assertEqual(card['terminalId'], key)
        self.assertEqual(card['agent'], 'shell')
        self.assertFalse(card['stale'])
        ws.close()  # Reload: drop the connection, but keep the terminal.
        state = self.request('/api/state')
        self.assertEqual(state['hosted'][0]['pid'], pid)
        resumed = self.connect(terminal=key)
        self.assertEqual(resumed.info['pid'], pid)
        resumed.until(b'READY')  # Output is replayed.
        resumed.send({'t': 'in', 'd': 'after reload\n'})
        resumed.until(b'echo:after reload')
        self.request('/api/terminal/close', {'id': key})
        self.assertFalse(self.request('/api/state')['hosted'])
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_retry_create_does_not_spawn_duplicate(self):
        args = dict(cwd=self.temp.name, agent='shell', client='same-client')
        first = self.connect(**args)
        first.until(b'READY')
        first.close()
        second = self.connect(**args)
        self.assertEqual(first.info['pid'], second.info['pid'])
        self.assertEqual(len(term.REGISTRY.listing()), 1)
        second.send({'t': 'close'})
        deadline = time.monotonic() + 5
        while term.REGISTRY.listing() and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertFalse(term.REGISTRY.listing())
