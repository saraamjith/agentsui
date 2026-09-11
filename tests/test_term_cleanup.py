"""Closing a PTY must release locks held by children of a CLI launcher."""
import fcntl
import os
import select
import signal
import sys
import tempfile
import unittest

import term


class CleanupTests(unittest.TestCase):
    def test_close_releases_child_lock_after_launcher_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            lock_path = os.path.join(directory, 'conversation.lock')
            script = r'''
import fcntl, os, signal, sys, time
if os.fork():
    while True:
        time.sleep(1)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(sys.argv[1], 'w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    print('LOCKED', flush=True)
    while True:
        time.sleep(1)
'''
            pid, fd = term.spawn([sys.executable, '-u', '-c', script, lock_path], directory)
            try:
                self.assertTrue(select.select([fd], [], [], 5)[0], 'child failed to start')
                self.assertIn(b'LOCKED', os.read(fd, 4096))
                with open(lock_path, 'r') as lock:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    term._reap(pid, fd)
                    fd = None
                    # The launcher exits on HUP; its child ignores HUP/TERM.
                    # This only succeeds if cleanup reaches the native child.
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(ChildProcessError):
                    os.waitpid(pid, os.WNOHANG)
            finally:
                if fd is not None:
                    os.killpg(pid, signal.SIGKILL)
                    term._reap(pid, fd)

    def test_close_immediately_after_spawn(self):
        pid, fd = term.spawn([sys.executable, '-c', 'import time; time.sleep(60)'], None)
        term._reap(pid, fd)
        with self.assertRaises(ChildProcessError):
            os.waitpid(pid, os.WNOHANG)


if __name__ == '__main__':
    unittest.main()
