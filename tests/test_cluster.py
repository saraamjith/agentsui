import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import cluster


def done(code=0, out="", err=""):
    return subprocess.CompletedProcess([], code, out, err)


class ClusterTests(unittest.TestCase):
    def setUp(self):
        self.gpu = cluster.Cluster("gpu.example", {"gpus": "kgpus --color", "jobs": "squeue"})
        # Run fetches inline so the test can look at the result straight away.
        patcher = patch.object(cluster.threading, "Thread",
                               lambda target, daemon: type("T", (), {"start": lambda self: target()})())
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_with(self, *results):
        calls = []

        def fake(argv, **kw):
            calls.append(argv)
            if "-O" in argv:
                return done(0 if results[0] != "down" else 255)
            return results[1][argv[-1]]
        with patch.object(cluster.subprocess, "run", fake):
            state = self.gpu.state()
        return state, calls

    def test_nothing_runs_without_a_master(self):
        state, calls = self.run_with("down", {})
        self.assertFalse(state["connected"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1:], ["-O", "check", "gpu.example"])

    def test_fetches_over_batch_mode_when_connected(self):
        state, calls = self.run_with("up", {"kgpus --color": done(out="GPUS"), "squeue": done(out="JOBS")})
        self.assertTrue(state["connected"])
        self.assertEqual(state["output"], {"gpus": "GPUS", "jobs": "JOBS"})
        self.assertFalse(state["errors"])
        self.assertIn("BatchMode=yes", calls[1])

    def test_waits_for_the_interval_before_fetching_again(self):
        self.run_with("up", {"kgpus --color": done(out="A"), "squeue": done(out="B")})
        self.gpu._checked = (0, False)
        _, calls = self.run_with("up", {})
        self.assertEqual(len(calls), 1)               # only the master check
        self.gpu.attempted = time.time() - cluster.EVERY - 1
        self.gpu._checked = (0, False)
        state, calls = self.run_with("up", {"kgpus --color": done(out="C"), "squeue": done(out="D")})
        self.assertEqual(state["output"]["gpus"], "C")

    def test_failure_keeps_the_last_listing_and_retries_sooner(self):
        self.run_with("up", {"kgpus --color": done(out="GOOD"), "squeue": done(out="J")})
        good = self.gpu.fetched
        self.gpu.attempted = time.time() - cluster.EVERY - 1
        self.gpu._checked = (0, False)
        state, _ = self.run_with("up", {"kgpus --color": done(1, err="ssh: mux\nkgpus: boom"),
                                        "squeue": done(out="J2")})
        self.assertEqual(state["output"]["gpus"], "GOOD")
        self.assertEqual(state["errors"], {"gpus": "kgpus: boom"})
        self.assertEqual(state["fetched"], good)
        self.gpu.attempted = time.time() - cluster.RETRY - 1
        self.assertTrue(self.gpu.due())

    def test_state_names_the_cluster_and_its_counted_partitions(self):
        lab = cluster.Cluster("login.example", {}, name="lab", count=("lab-shared",))
        with patch.object(cluster.subprocess, "run", lambda argv, **kw: done(255)):
            state = lab.state()
        self.assertEqual((state["name"], state["count"]), ("lab", ["lab-shared"]))
        self.assertEqual(self.gpu.name, "gpu")

    def test_refresh_is_ignored_while_a_fetch_runs(self):
        self.gpu.fetching = True
        self.assertFalse(self.gpu.refresh())


class LoadTests(unittest.TestCase):
    def test_reads_clusters_from_json_and_skips_bad_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "clusters.json"
            path.write_text(json.dumps([
                {"name": "lab", "host": "login.example", "gpus": "gpus", "jobs": "squeue", "count": ["shared"]},
                {"host": "gpu.example", "jobs": "squeue"},
                {"name": "no host"}, "junk",
            ]))
            found = cluster.load(path)
        self.assertEqual([(c.name, c.host, c.commands, c.count) for c in found], [
            ("lab", "login.example", {"gpus": "gpus", "jobs": "squeue"}, ("shared",)),
            ("gpu", "gpu.example", {"jobs": "squeue"}, ()),
        ])

    def test_missing_or_broken_file_means_no_clusters(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(cluster.load(Path(tmp) / "none.json"), ())
            bad = Path(tmp) / "bad.json"
            bad.write_text("{not json")
            self.assertEqual(cluster.load(bad), ())


if __name__ == "__main__":
    unittest.main()
