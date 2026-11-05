"""GPU and job listings for Slurm clusters, fetched over ssh connections you
already have.

Clusters are listed in a JSON file (see load()); with none configured there is
no cluster panel at all.

Nothing here ever logs in. Login hosts often want a password and 2FA, so a
cluster's panel only appears while an ssh ControlMaster for its host is up
(`ssh -O check`), which is the connection your own `ssh ...` opened, and every
command rides it with BatchMode on so a dropped master fails instead of
prompting.

The output is the real GPU-listing and `squeue` text, colour codes and
all; the browser only turns the escape codes into spans.
"""

import json
import os
from pathlib import Path
import subprocess
import threading
import time

# How often the listings refresh on their own while the master is up.
EVERY = 20 * 60
# After a failed fetch, try again this much sooner than a full interval.
RETRY = 60
# `ssh -O check` is a local socket probe, but the board polls every 3s.
CHECK_TTL = 5


def ssh(host, *args, timeout):
    return subprocess.run(["ssh", *args, host], capture_output=True, text=True,
                          timeout=timeout, stdin=subprocess.DEVNULL)


class Cluster:
    def __init__(self, host, commands, name=None, count=(), every=EVERY):
        self.host, self.commands, self.every = host, commands, every
        self.name = name or host.split(".")[0]
        # Partition prefixes whose jobs the toolbar counts; empty counts all.
        self.count = tuple(count)
        self.lock = threading.Lock()
        self.output = {key: "" for key in commands}
        self.errors = {}
        self.fetched = 0.0        # last time every command succeeded
        self.attempted = 0.0
        self.failed = False
        self.fetching = False
        self._checked = (0.0, False)

    def connected(self):
        at, up = self._checked
        if time.time() - at < CHECK_TTL:
            return up
        try:
            up = ssh(self.host, "-O", "check", timeout=5).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            up = False
        self._checked = (time.time(), up)
        return up

    def _run(self, command):
        try:
            done = subprocess.run(
                ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", self.host, command],
                capture_output=True, text=True, timeout=90, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return None, "timed out"
        except OSError as exc:
            return None, str(exc)
        if done.returncode != 0:
            lines = done.stderr.strip().splitlines()
            return None, lines[-1] if lines else "exit status %d" % done.returncode
        return done.stdout, None

    def _fetch(self):
        results = {key: self._run(command) for key, command in self.commands.items()}
        with self.lock:
            for key, (out, err) in results.items():
                if out is not None:
                    self.output[key] = out     # a failure keeps the last good listing
                    self.errors.pop(key, None)
                else:
                    self.errors[key] = err
            self.failed = bool(self.errors)
            if not self.failed:
                self.fetched = time.time()
            self.fetching = False

    def refresh(self):
        """Start a fetch in the background unless one is already running."""
        with self.lock:
            if self.fetching:
                return False
            self.fetching = True
            self.attempted = time.time()
        threading.Thread(target=self._fetch, daemon=True).start()
        return True

    def due(self):
        wait = RETRY if self.failed else self.every
        return time.time() - self.attempted >= wait

    def state(self):
        up = self.connected()
        if up and not self.fetching and self.due():
            self.refresh()
        with self.lock:
            return {
                "name": self.name, "host": self.host, "count": list(self.count), "connected": up, "fetching": self.fetching,
                "fetched": self.fetched or None, "every": self.every,
                "commands": dict(self.commands), "output": dict(self.output),
                "errors": dict(self.errors),
            }


CONFIG = Path(os.environ.get("AGENTSUI_CLUSTERS", Path.home() / ".claude" / "agentsui-clusters.json"))


def load(path=CONFIG):
    """Clusters from a JSON list such as

        [{"name": "lab", "host": "login.example.edu",
          "gpus": "~/bin/gpus --color", "jobs": "squeue -u \\"$USER\\"",
          "count": ["shared"]}]

    `gpus` and `jobs` are commands run on the host; `count` limits the toolbar's
    running / queued counts to partitions with those prefixes. A missing or
    unreadable file means no clusters.
    """
    try:
        entries = json.loads(Path(path).expanduser().read_text())
    except (OSError, ValueError):
        return ()
    clusters = []
    for e in entries if isinstance(entries, list) else ():
        if not isinstance(e, dict) or not e.get("host"):
            continue
        commands = {key: e[key] for key in ("gpus", "jobs") if e.get(key)}
        clusters.append(Cluster(e["host"], commands, name=e.get("name"), count=e.get("count") or ()))
    return tuple(clusters)


CLUSTERS = load()
