import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import agentsui


def row(sid, cwd, first, agent="claude"):
    return {"id": sid, "agent": agent, "cwd": cwd, "agentId": None, "firstTs": first,
            "mtime": first, "title": sid + " title", "streaming": False, "age": 0}


def terminal(pid, cwd, uptime, agent="claude"):
    return {"pid": pid, "agent": agent, "cwd": cwd, "uptime": uptime}


class AttachSessionsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        patcher = patch.object(agentsui, "LIVE_REGISTRY", Path(self.dir.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.dir.cleanup)

    def register(self, pid, sid):
        (Path(self.dir.name) / f"{pid}.json").write_text(json.dumps({"pid": pid, "sessionId": sid}))

    def test_registered_session_wins_when_the_session_moved_directory(self):
        # claude started in the project root, then the session cd'd into code/.
        now = time.time()
        rows = [row("a", "/p/code", now - 3600)]
        terms = [terminal(1, "/p", 7200)]
        self.register(1, "a")
        agentsui.attach_sessions(terms, rows)
        self.assertEqual(terms[0]["session"], "a")
        self.assertEqual(terms[0]["title"], "a title")

    def test_two_processes_can_share_a_registered_session(self):
        now = time.time()
        rows = [row("a", "/p", now - 3600)]
        terms = [terminal(1, "/p", 7200), terminal(2, "/p", 60)]
        self.register(1, "a")
        self.register(2, "a")
        agentsui.attach_sessions(terms, rows)
        self.assertEqual([t["session"] for t in terms], ["a", "a"])

    def test_guesses_skip_registered_sessions(self):
        now = time.time()
        rows = [row("a", "/p", now - 100), row("b", "/p", now - 50)]
        terms = [terminal(1, "/p", 200), terminal(2, "/p", 150)]
        self.register(2, "a")
        agentsui.attach_sessions(terms, rows)
        self.assertEqual([t["session"] for t in terms], ["b", "a"])

    def test_unregistered_terminal_falls_back_to_start_time(self):
        now = time.time()
        rows = [row("old", "/p", now - 9000), row("new", "/p", now - 50)]
        terms = [terminal(1, "/p", 60)]
        agentsui.attach_sessions(terms, rows)
        self.assertEqual(terms[0]["session"], "new")


if __name__ == "__main__":
    unittest.main()
