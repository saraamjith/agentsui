#!/usr/bin/env python3
"""AgentsUI - a local console for the Claude Code sessions on this machine.

Reads the append-only transcripts under ~/.claude/projects and the live `claude`
processes from `ps`, and serves both as JSON to a browser dashboard.
Standard library only.
"""

import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlparse, parse_qs

import term
from cluster import CLUSTERS

HOME = Path.home()
PROJECTS = HOME / ".claude" / "projects"
# Claude Code writes <pid>.json here for each live process, naming the session
# it is on (kept current across /resume).
LIVE_REGISTRY = HOME / ".claude" / "sessions"
# The session this server was launched from. Opening a terminal on it would run
# a second claude on the same transcript and corrupt it, so the UI locks it.
SELF_SESSION = os.environ.get("CLAUDE_CODE_SESSION_ID")
CODEX_SESSIONS = HOME / ".codex" / "sessions"

# How each agent continues a recorded session on a pty.
RESUME = {
    "claude": lambda sid: ["claude", "--resume", sid],
    "codex": lambda sid: ["codex", "resume", sid],
}
# How a fresh session/terminal is started. "shell" is a plain login shell,
# for sshing in or running anything by hand; it has no transcript to resume.
NEW = {
    "claude": ["claude"],
    "codex": ["codex"],
    "shell": [os.environ.get("SHELL", "/bin/bash"), "-l"],
}
HERE = Path(__file__).resolve().parent

# A transcript touched this recently is treated as actively streaming.
LIVE_WINDOW = 90
# Where the "hidden from view" list lives. Transcripts are never touched.
PREFS = HOME / ".claude" / "agentsui.json"
LEGACY_PREFS = HOME / ".claude" / "fleetview.json"
# Where the vendored xterm build lives.
VENDOR = HERE / "vendor"
STATIC = ("ui.html", "app.js", "cards.js", "canvas.js", "termclient.js", "cluster.js")
# Browsers ask for /favicon.ico whatever the page says; hand them the PNG.
ICONS = {"/favicon.svg": "favicon.svg", "/favicon.png": "favicon.png", "/favicon.ico": "favicon.png"}


def build_stamp():
    """Changes whenever a front-end file does, so an open tab knows to reload."""
    newest = 0.0
    for name in STATIC:
        try:
            newest = max(newest, (HERE / name).stat().st_mtime)
        except OSError:
            pass
    return int(newest)
# Keep this many recent events per session for the activity feed.
EVENT_TAIL = 120
# Sessions untouched for longer than this are kept off the board by default.
ACTIVE_WINDOW = 7 * 86400


def iso_to_epoch(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None


def text_of(content):
    """Flatten an Anthropic message content field to plain text."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    out = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            out.append(block.get("text", ""))
    return "\n".join(out)


class Transcript:
    """One .jsonl transcript, parsed incrementally as it grows."""

    agent = "claude"

    def __init__(self, path, parent_session=None, agent_id=None):
        self.path = Path(path)
        self.parent_session = parent_session
        self.agent_id = agent_id
        self.meta = {}
        self.offset = 0
        self.mtime = 0.0
        self.size = 0
        self._reset()
        if agent_id:
            meta_path = self.path.with_suffix(".meta.json")
            try:
                self.meta = json.loads(meta_path.read_text())
            except (OSError, ValueError):
                self.meta = {}

    def _reset(self):
        self.session_id = None
        self.title = None
        self.last_prompt = None
        self.cwd = None
        self.branch = None
        self.version = None
        self.model = None
        self.effort = None
        self.first_ts = None
        self.last_ts = None
        self.n_user = 0
        self.n_assistant = 0
        self.n_tools = 0
        self.n_errors = 0
        self.tool_counts = {}
        self.events = []
        self.timeline = []
        self.last_assistant_text = None
        self.pending_tools = {}

    # -- parsing -----------------------------------------------------------

    def refresh(self):
        """Read whatever has been appended since the last call."""
        try:
            st = self.path.stat()
        except OSError:
            return False
        if st.st_mtime == self.mtime and st.st_size == self.size:
            return False
        if st.st_size < self.size:  # rotated or rewritten
            self.offset = 0
            self._reset()
        try:
            with self.path.open("rb") as fh:
                fh.seek(self.offset)
                data = fh.read()
        except OSError:
            return False
        cut = data.rfind(b"\n")
        if cut == -1:
            self.mtime = st.st_mtime
            return False
        for raw in data[: cut + 1].split(b"\n"):
            if raw.strip():
                self._ingest(raw)
        self.offset += cut + 1
        self.mtime = st.st_mtime
        self.size = st.st_size
        if len(self.events) > EVENT_TAIL:
            self.events = self.events[-EVENT_TAIL:]
        return True

    def _ingest(self, raw):
        try:
            rec = json.loads(raw)
        except ValueError:
            return
        kind = rec.get("type")

        sid = rec.get("sessionId") or rec.get("session_id")
        if sid and not self.session_id:
            self.session_id = sid
        for field, attr in (("cwd", "cwd"), ("gitBranch", "branch"), ("version", "version")):
            val = rec.get(field)
            if val:
                setattr(self, attr, val)

        ts = iso_to_epoch(rec.get("timestamp"))
        if ts:
            if self.first_ts is None:
                self.first_ts = ts
            self.last_ts = ts

        if kind == "ai-title":
            self.title = rec.get("aiTitle") or self.title
        elif kind == "last-prompt":
            self.last_prompt = rec.get("lastPrompt") or self.last_prompt
        elif kind == "user":
            self._ingest_user(rec, ts)
        elif kind == "assistant":
            self._ingest_assistant(rec, ts)

    def _ingest_user(self, rec, ts):
        msg = rec.get("message") or {}
        content = msg.get("content")
        # A user record carrying tool_result blocks is a tool returning, not a person.
        if isinstance(content, list) and any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content
        ):
            for block in content:
                if not (isinstance(block, dict) and block.get("type") == "tool_result"):
                    continue
                name = self.pending_tools.pop(block.get("tool_use_id"), "tool")
                if block.get("is_error"):
                    self.n_errors += 1
                    self._event(ts, "error", name)
            return
        body = text_of(content).strip()
        if not body:
            return
        self.n_user += 1
        if rec.get("isMeta"):
            return
        self.last_prompt = body
        self._event(ts, "prompt", body[:400])
        self._timeline(ts, "user", body[:4000])

    def _ingest_assistant(self, rec, ts):
        msg = rec.get("message") or {}
        model = msg.get("model")
        if model and not model.startswith("<"):  # skip <synthetic> error records
            self.model = model
        self.effort = rec.get("effort") or self.effort
        self.n_assistant += 1
        content = msg.get("content") or []
        said = text_of(content).strip()
        if said:
            self.last_assistant_text = said
            self._timeline(ts, "assistant", said[:4000])
        for block in content:
            if not (isinstance(block, dict) and block.get("type") == "tool_use"):
                continue
            name = block.get("name", "tool")
            self.n_tools += 1
            self.tool_counts[name] = self.tool_counts.get(name, 0) + 1
            self.pending_tools[block.get("id")] = name
            self._event(ts, "tool", name, detail=self._tool_detail(name, block.get("input")))
            self._timeline(ts, "tool", name, detail=self._tool_detail(name, block.get("input")))

    @staticmethod
    def _tool_detail(name, params):
        if not isinstance(params, dict):
            return ""
        for key in ("description", "command", "file_path", "pattern", "prompt", "query", "url"):
            val = params.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip().replace("\n", " ")[:180]
        return ""

    def _event(self, ts, kind, label, detail=""):
        self.events.append({"t": ts, "kind": kind, "label": label, "detail": detail})

    def _timeline(self, ts, role, body, detail=""):
        self.timeline.append({"t": ts, "role": role, "body": body, "detail": detail})

    # -- views -------------------------------------------------------------

    @property
    def age(self):
        return time.time() - self.mtime if self.mtime else None

    @property
    def streaming(self):
        return self.age is not None and self.age < LIVE_WINDOW

    def pulse(self, buckets=40, span=1800):
        """Tool/message counts bucketed over the recent past, for a sparkline."""
        now = time.time()
        width = span / buckets
        bins = [0] * buckets
        for ev in self.events:
            if not ev["t"]:
                continue
            delta = now - ev["t"]
            if 0 <= delta < span:
                bins[buckets - 1 - int(delta / width)] += 1
        return bins

    def status(self):
        """working / waiting / error / idle - what the session needs from you."""
        age = self.age
        recent = [e for e in self.events[-6:]]
        if any(e["kind"] == "error" for e in recent) and age is not None and age < 600:
            return "error"
        if self.streaming:
            return "working"
        if age is None:
            return "idle"
        # A session whose last move was speech rather than a tool call has
        # handed the turn back to you.
        last = self.timeline[-1] if self.timeline else None
        if last and last["role"] == "assistant" and age < 86400:
            return "waiting"
        return "idle"

    def summary(self):
        top = sorted(self.tool_counts.items(), key=lambda kv: -kv[1])[:5]
        return {
            "id": self.session_id or self.path.stem,
            "agent": self.agent,
            "file": str(self.path),
            "agentId": self.agent_id,
            "parent": self.parent_session,
            "agentType": self.meta.get("agentType"),
            "task": self.meta.get("description"),
            "title": self.title,
            "lastPrompt": self.last_prompt,
            "lastSaid": (self.last_assistant_text or "")[:600],
            "cwd": self.cwd,
            "project": Path(self.cwd).name if self.cwd else None,
            "branch": self.branch,
            "version": self.version,
            "model": self.model,
            "effort": self.effort,
            "firstTs": self.first_ts,
            "lastTs": self.last_ts,
            "mtime": self.mtime,
            "age": self.age,
            "streaming": self.streaming,
            "status": self.status(),
            "nUser": self.n_user,
            "nAssistant": self.n_assistant,
            "nTools": self.n_tools,
            "nErrors": self.n_errors,
            "topTools": top,
            "pulse": self.pulse(),
            "events": self.events[-14:],
        }


class CodexTranscript(Transcript):
    """A Codex CLI rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)."""

    agent = "codex"
    # Codex stores AGENTS.md, environment blocks and its compaction placeholder
    # as user messages; none of those are prompts a person typed.
    INJECTED = ("<", "# AGENTS.md", "Earlier messages are available")

    def _ingest(self, raw):
        try:
            rec = json.loads(raw)
        except ValueError:
            return
        kind = rec.get("type")
        p = rec.get("payload") or {}
        ts = iso_to_epoch(rec.get("timestamp"))
        if ts:
            if self.first_ts is None:
                self.first_ts = ts
            self.last_ts = ts

        if kind == "session_meta":
            self.session_id = p.get("session_id") or p.get("id") or self.session_id
            self.cwd = p.get("cwd") or self.cwd
            self.version = p.get("cli_version") or self.version
        elif kind == "turn_context":
            self.cwd = p.get("cwd") or self.cwd
            self.model = p.get("model") or self.model
        elif kind == "response_item":
            self._item(p, ts)
        elif kind == "event_msg" and p.get("type") == "task_complete":
            said = (p.get("last_agent_message") or "").strip()
            if said:
                self.last_assistant_text = said

    def _item(self, p, ts):
        kind = p.get("type")
        if kind == "message":
            text = "\n".join(
                c.get("text", "") for c in (p.get("content") or [])
                if isinstance(c, dict) and c.get("type") in ("input_text", "output_text")
            ).strip()
            if not text:
                return
            if p.get("role") == "user":
                if text.startswith(self.INJECTED):
                    return
                self.n_user += 1
                self.last_prompt = text
                if not self.title:
                    self.title = text.replace("\n", " ")[:60]
                self._event(ts, "prompt", text[:400])
                self._timeline(ts, "user", text[:4000])
            elif p.get("role") == "assistant":
                self.n_assistant += 1
                self.last_assistant_text = text
                self._timeline(ts, "assistant", text[:4000])
        elif kind in ("function_call", "custom_tool_call"):
            name = p.get("name") or "tool"
            self.n_tools += 1
            self.tool_counts[name] = self.tool_counts.get(name, 0) + 1
            self.pending_tools[p.get("call_id")] = name
            args = p.get("arguments") if kind == "function_call" else p.get("input")
            detail = self._codex_detail(args)
            self._event(ts, "tool", name, detail=detail)
            self._timeline(ts, "tool", name, detail=detail)
        elif kind in ("function_call_output", "custom_tool_call_output"):
            self.pending_tools.pop(p.get("call_id"), None)

    @staticmethod
    def _codex_detail(args):
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                return args.strip().replace("\n", " ")[:180]
        if isinstance(args, dict):
            return Transcript._tool_detail("", args) or json.dumps(args)[:180]
        return ""


ETIME = re.compile(r"^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$")


def etime_seconds(text):
    m = ETIME.match(text.strip())
    if not m:
        return None
    days, hours, mins, secs = (int(g) if g else 0 for g in m.groups())
    return days * 86400 + hours * 3600 + mins * 60 + secs


def scan_terminals():
    """Live `claude` CLI processes, with the directory each one is working in."""
    try:
        out = subprocess.run(
            ["ps", "-eo", "pid=,pgid=,tty=,etime=,command="],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []

    procs = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid, pgid, tty, etime, command = parts
        agent = agent_of(command)
        if not agent:
            continue
        if tty in ("??", "-"):  # not attached to a terminal
            continue
        procs.append({
            "pid": int(pid),
            "pgid": int(pgid),
            "tty": tty,
            "agent": agent,
            "uptime": etime_seconds(etime),
            "command": command.strip(),
        })

    # A Codex TUI is a node wrapper plus the native binary on one tty; show
    # it once, as the binary.
    seen = {}
    for p in procs:
        key = (p["agent"], p["tty"])
        if key not in seen or (p["agent"] == "codex" and p["pid"] > seen[key]["pid"]):
            seen[key] = p
    procs = list(seen.values())

    if procs:
        cwds = process_cwds([p["pid"] for p in procs])
        for p in procs:
            p["cwd"] = cwds.get(p["pid"])
            p["project"] = Path(p["cwd"]).name if p.get("cwd") else None
    procs.sort(key=lambda p: p["tty"])
    return procs


def agent_of(command):
    """Which agent a `ps` command line is, or None."""
    argv = command.split()
    if not argv:
        return None
    exe = os.path.basename(argv[0])
    if exe == "claude":
        return "claude"
    if exe == "codex":
        return "codex"
    if exe == "node" and len(argv) > 1 and os.path.basename(argv[1]) == "codex":
        return "codex"
    return None


def process_cwds(pids):
    """Map pid -> working directory in one lsof call."""
    if not pids:
        return {}
    try:
        out = subprocess.run(
            ["lsof", "-a", "-p", ",".join(str(p) for p in pids), "-d", "cwd", "-Fpn"],
            capture_output=True, text=True, timeout=8,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    found, current = {}, None
    for line in out.splitlines():
        if line.startswith("p"):
            current = int(line[1:])
        elif line.startswith("n") and current is not None:
            found.setdefault(current, line[1:])
    return found


class Prefs:
    """Small on-disk preference file. Holds the hidden-session list and custom titles."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.data = {"hidden": [], "layout": {}, "titles": {}}
        for source in (path, LEGACY_PREFS):      # carry the pre-rename file forward
            try:
                self.data.update(json.loads(source.read_text()))
                break
            except (OSError, ValueError):
                continue

    @property
    def hidden(self):
        return set(self.data.get("hidden", []))

    def hide(self, sid, value):
        with self.lock:
            current = set(self.data.get("hidden", []))
            current.add(sid) if value else current.discard(sid)
            self.data["hidden"] = sorted(current)
            self._flush()
        return sorted(current)

    @property
    def titles(self):
        return dict(self.data.get("titles", {}))

    def rename(self, sid, title):
        """A custom card title; an empty title goes back to the transcript's own."""
        with self.lock:
            titles = self.data.setdefault("titles", {})
            title = " ".join(str(title or "").split())[:120]
            if title:
                titles[sid] = title
            else:
                titles.pop(sid, None)
            self._flush()
        return title

    @property
    def layout(self):
        return self.data.get("layout", {})

    def place(self, sid, box):
        with self.lock:
            layout = self.data.setdefault("layout", {})
            layout[sid] = {k: int(box[k]) for k in ("x", "y", "w", "h") if k in box}
            self._flush()
        return layout[sid]

    def _flush(self):
        try:
            self.path.write_text(json.dumps(self.data, indent=1))
        except OSError:
            pass

    def clear(self):
        with self.lock:
            self.data["hidden"] = []
            self._flush()


PREFS_STORE = Prefs(PREFS)


class Board:
    """Keeps the parsed transcripts warm and refreshes them on demand."""

    def __init__(self):
        self.transcripts = {}
        self.lock = threading.Lock()

    def _discover(self):
        for project in sorted(PROJECTS.glob("*")):
            if not project.is_dir():
                continue
            for path in project.glob("*.jsonl"):
                self.transcripts.setdefault(str(path), Transcript(path))
                sub = project / path.stem / "subagents"
                if not sub.is_dir():
                    continue
                for agent in sub.glob("agent-*.jsonl"):
                    self.transcripts.setdefault(
                        str(agent),
                        Transcript(agent, parent_session=path.stem,
                                   agent_id=agent.stem.replace("agent-", "")),
                    )
        if CODEX_SESSIONS.is_dir():
            for path in CODEX_SESSIONS.rglob("rollout-*.jsonl"):
                self.transcripts.setdefault(str(path), CodexTranscript(path))

    def refresh(self):
        with self.lock:
            self._discover()
            for t in self.transcripts.values():
                t.refresh()

    def state(self):
        self.refresh()
        with self.lock:
            rows = [t.summary() for t in self.transcripts.values() if t.last_ts]
        terminals = scan_terminals()
        attach_sessions(terminals, rows)
        hosted = term.REGISTRY.listing()
        by_pid = {entry["pid"]: entry for entry in hosted}
        for item in terminals:
            owner = by_pid.get(item.get("pgid")) or by_pid.get(item["pid"])
            item["hosted"] = bool(owner)
            if owner:
                item["session"] = owner["clientId"]
        # A hosted terminal is visible immediately, even before a transcript
        # exists (and plain shells never create a transcript).
        claimed = set()
        for entry in hosted:
            source = next((r for r in rows if r["id"] == entry["session"]), None)
            if source is None and entry["agent"] != "shell":
                candidates = [r for r in rows if r["agent"] == entry["agent"]
                              and r["cwd"] == entry["cwd"] and not r["agentId"]
                              and r["id"] not in claimed
                              and (r["firstTs"] or 0) >= entry["started"] - 1]
                if candidates:
                    source = min(candidates, key=lambda r: r["firstTs"])
                    live = term.REGISTRY.get(entry["id"])
                    if live:
                        live.info["session"] = source["id"]
            if source:
                claimed.add(source["id"])
                rows = [r for r in rows if r["id"] != source["id"]]
            card = dict(source or {})
            card.update({
                "id": entry["clientId"], "terminalId": entry["id"],
                "sessionId": source["id"] if source else None,
                "agent": entry["agent"], "cwd": entry["cwd"],
                "project": Path(entry["cwd"]).name, "agentId": None,
                "title": (source or {}).get("title") or entry["label"],
                "mtime": max((source or {}).get("mtime") or 0, entry["started"]),
                "age": 0, "status": (source or {}).get("status", "idle"),
                "hosted": True,
            })
            rows.append(card)
            if not any(t.get("pgid") == entry["pid"] or t["pid"] == entry["pid"] for t in terminals):
                terminals.append({"pid": entry["pid"], "tty": "pty", "agent": entry["agent"],
                                  "hosted": True, "session": entry["clientId"],
                                  "cwd": entry["cwd"], "project": card["project"],
                                  "title": card["title"], "uptime": time.time() - entry["started"]})
        rows.sort(key=lambda r: r["mtime"] or 0, reverse=True)
        hidden = PREFS_STORE.hidden
        titles = PREFS_STORE.titles
        cutoff = time.time() - ACTIVE_WINDOW
        for row in rows:
            row["hidden"] = row["id"] in hidden
            row["renamed"] = row["id"] in titles
            if row["renamed"]:
                row["title"] = titles[row["id"]]
            row["stale"] = not row.get("hosted") and (row["mtime"] or 0) < cutoff
        return {
            "now": time.time(),
            "sessions": [r for r in rows if not r["agentId"]],
            "subagents": [r for r in rows if r["agentId"]],
            "terminals": terminals,
            "hosted": term.REGISTRY.listing(),
            "layout": PREFS_STORE.layout,
            "build": build_stamp(),
            "self": SELF_SESSION,
            "host": os.uname().nodename,
            "clusters": [c.state() for c in CLUSTERS],
        }

    def detail(self, path):
        with self.lock:
            t = self.transcripts.get(path)
        if not t:
            return None
        t.refresh()
        data = t.summary()
        data["timeline"] = t.timeline[-300:]
        data["allTools"] = sorted(t.tool_counts.items(), key=lambda kv: -kv[1])
        return data


def registered_session(pid):
    """The session Claude Code says this process is on, or None."""
    try:
        return json.loads((LIVE_REGISTRY / f"{pid}.json").read_text()).get("sessionId")
    except (OSError, ValueError, AttributeError):
        return None


def attach_sessions(terminals, rows):
    """Find which transcript each live terminal is writing.

    A claude process that registered itself under ~/.claude/sessions says so
    directly. For the rest (Codex, older CLIs) the CLI does not hold its
    transcript open, so pair each terminal with the session that started
    closest after the process did - a session cannot predate the terminal it
    runs in. Falls back to the freshest session in the same directory. That is
    only a guess.
    """
    now = time.time()
    by_id = {row["id"]: row for row in rows}
    by_cwd = {}
    for row in rows:
        if row["agentId"] or not row["cwd"]:
            continue
        by_cwd.setdefault((row["agent"], row["cwd"]), []).append(row)
    for sessions in by_cwd.values():
        sessions.sort(key=lambda r: r["mtime"] or 0, reverse=True)

    def pair(term, sid):
        term["session"] = sid
        row = by_id.get(sid)
        if row:
            term["title"] = row["title"]
            term["streaming"] = row["streaming"]
            term["age"] = row["age"]

    # Registered sessions first, so guesses never claim them. Two processes
    # can be on one session, and the cwd is where claude started, which the
    # transcript's cwd stops matching once the session cds elsewhere.
    taken, unknown = set(), []
    for term in terminals:
        sid = registered_session(term["pid"]) if term["agent"] == "claude" else None
        if sid:
            pair(term, sid)
            taken.add(sid)
        else:
            unknown.append(term)

    # Longest-running terminals choose first; their windows are least ambiguous.
    for term in sorted(unknown, key=lambda t: -(t.get("uptime") or 0)):
        term["session"] = None
        started = now - term["uptime"] if term.get("uptime") else None
        free = [c for c in by_cwd.get((term["agent"], term.get("cwd")), []) if c["id"] not in taken]
        if not free:
            continue
        pick = None
        if started is not None:
            after = [c for c in free if c["firstTs"] and c["firstTs"] >= started - 120]
            if after:
                pick = min(after, key=lambda c: c["firstTs"] - started)
        pick = pick or free[0]
        taken.add(pick["id"])
        pair(term, pick["id"])


BOARD = Board()


class Rejected(Exception):
    """A terminal request the server will not run, with the reason to show."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Plan(NamedTuple):
    argv: list
    cwd: str
    label: str
    agent: str
    session: str


MEMORY_NOTE = """\
Shared memory: this project's persistent memory is the folder {dir}. Claude Code \
sessions read and write the same folder, so it is how you and they remember \
things across sessions. At the start of a task, read {dir}/MEMORY.md (an index, \
one line per memory) and open the memory files relevant to the task. When you \
learn something worth keeping - who the user is, guidance or corrections on how \
to work, project context that the code and git history do not record, pointers \
to external resources - save one fact per file in that folder, starting with \
frontmatter:
---
name: <short-kebab-case-slug>
description: <one-line summary>
metadata:
  type: user | feedback | project | reference
---
then add a one-line pointer `- [Title](file.md) - hook` to MEMORY.md. Update an \
existing memory instead of writing a duplicate, and delete one that turns out to \
be wrong."""


HISTORY_NOTE = """\
Session history: earlier Claude Code and Codex sessions on this project can be \
read, whichever agent ran them. `python3 {script} sessions` lists them newest \
first (id, agent, date, title); `python3 {script} session <id>` prints one as a \
readable conversation (an id prefix is enough). Look there when the user refers \
to earlier work, or before redoing something that may already have been tried."""


def project_root(cwd):
    """The repository root containing cwd, or cwd itself outside git."""
    try:
        root = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                              capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        root = ""
    return root or os.path.realpath(cwd)


def slug(path):
    """How Claude Code names a folder under ~/.claude/projects."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def memory_dir(cwd):
    """Claude Code's memory folder for the project containing cwd.

    Claude keys it by the repository root (or the folder itself outside git).
    """
    return PROJECTS / slug(project_root(cwd)) / "memory"


def shared_memory_args(agent, cwd):
    """Flags that give a new terminal the project's shared memory and history.

    Claude loads its memory folder by itself and only needs to hear about the
    session history. Codex is told where both are and allowed to write to the
    memory folder, so memories either agent saves are seen by both.
    """
    history = HISTORY_NOTE.format(script=HERE / "agentsui.py")
    if agent == "claude":
        return ["--append-system-prompt", history]
    folder = memory_dir(cwd)
    folder.mkdir(parents=True, exist_ok=True)
    note = MEMORY_NOTE.format(dir=folder) + "\n\n" + history
    # --add-dir is rejected under read-only/restricted permission defaults.
    # Select the workspace sandbox explicitly for both new and resumed sessions.
    return ["--sandbox", "workspace-write", "--add-dir", str(folder),
            "-c", "developer_instructions=" + json.dumps(note)]


def project_sessions(cwd):
    """Parsed Claude and Codex sessions (not subagents) run anywhere in cwd's project.

    Claude files a transcript under the slug of the folder it ran in, and a
    rollout's first line names its folder, so only matching files are parsed.
    """
    root = project_root(cwd)
    inside = lambda path: bool(path) and (path == root or path.startswith(root.rstrip("/") + "/"))
    found = []
    for project in PROJECTS.glob(slug(root) + "*"):
        found += [Transcript(path) for path in project.glob("*.jsonl")]
    for path in CODEX_SESSIONS.rglob("rollout-*.jsonl") if CODEX_SESSIONS.is_dir() else ():
        try:
            with path.open() as f:
                first = json.loads(f.readline())
        except (OSError, ValueError):
            continue
        if inside((first.get("payload") or {}).get("cwd")):
            found.append(CodexTranscript(path))
    for t in found:
        t.refresh()
    found = [t for t in found if t.last_ts and inside(t.cwd)]
    return sorted(found, key=lambda t: t.last_ts, reverse=True)


def stamp(ts):
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else "?"


def history_main(args):
    """`agentsui.py sessions [DIR]` and `agentsui.py session ID [DIR]`."""
    command, rest = args[0], args[1:]
    if command == "session" and not rest:
        return "usage: agentsui.py session <id> [dir]"
    want = rest.pop(0) if command == "session" else None
    sessions = project_sessions(rest[0] if rest else os.getcwd())
    if want is None:
        for t in sessions:
            title = PREFS_STORE.titles.get(t.session_id) or t.title or "(untitled)"
            print(f"{t.session_id}  {t.agent:<6}  {stamp(t.last_ts)}  {title}")
        return None
    match = [t for t in sessions if (t.session_id or "").startswith(want)]
    if len(match) != 1:
        return f"{len(match)} sessions in this project match {want!r}"
    t = match[0]
    print(f"{t.agent} session {t.session_id} in {t.cwd}, {stamp(t.first_ts)} - {stamp(t.last_ts)}\n")
    for item in t.timeline:
        if item["role"] == "tool":
            print(f"  [{item['body']}] {item['detail']}")
        else:
            print(f"\n{item['role'].upper()} {stamp(item['t'])}\n{item['body']}")
    return None


def plan_terminal(agent, cwd, want):
    """Work out what pty a new-terminal request wants, or say why it cannot run."""
    if agent not in NEW:
        raise Rejected(400, "unknown agent: " + agent)
    cwd = os.path.expanduser(cwd or "")
    argv = list(NEW[agent])
    session = None
    where = os.path.basename(cwd.rstrip("/")) or cwd
    label = ("shell in " if agent == "shell" else "new " + agent + " in ") + where
    if want:
        data = BOARD.detail(want)
        if not data:
            raise Rejected(404, "no such session")
        if data.get("agentId"):
            raise Rejected(400, "subagents cannot be resumed")
        if data["id"] == SELF_SESSION:
            raise Rejected(409, "that session is running AgentsUI itself")
        agent = data.get("agent", "claude")
        if agent not in RESUME:
            raise Rejected(400, "a " + agent + " session cannot be resumed")
        cwd = data.get("cwd") or cwd
        session = data["id"]
        argv = RESUME[agent](session)
        label = data.get("title") or data["id"][:8]
    if not cwd:
        raise Rejected(400, "no working directory")
    if not os.path.isdir(cwd):
        raise Rejected(400, "no such folder: " + cwd)
    if agent in ("claude", "codex"):
        argv += shared_memory_args(agent, cwd)
    return Plan(argv, cwd, label, agent, session)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path in ("/", "/index.html"):
                page = (HERE / "ui.html").read_bytes()
                return self._send(200, page, "text/html; charset=utf-8")
            if url.path == "/api/state":
                payload = json.dumps(BOARD.state()).encode()
                return self._send(200, payload, "application/json")
            if url.path.startswith("/vendor/"):
                return self._static(VENDOR, url.path)
            if url.path.endswith(".js"):
                return self._static(HERE, url.path)
            if url.path in ICONS:
                return self._static(HERE, ICONS[url.path])
            if url.path == "/ws/term":
                return self._terminal(parse_qs(url.query))
            if url.path == "/api/session":
                want = parse_qs(url.query).get("file", [""])[0]
                data = BOARD.detail(want)
                if data is None:
                    return self._send(404, b'{"error":"no such session"}', "application/json")
                return self._send(200, json.dumps(data).encode(), "application/json")
            self._send(404, b"not found", "text/plain")
        except BrokenPipeError:
            pass
        except Exception as exc:  # keep the console up if one read goes wrong
            self._send(500, json.dumps({"error": str(exc)}).encode(), "application/json")

    MIME = {".js": "text/javascript", ".css": "text/css",
            ".svg": "image/svg+xml", ".png": "image/png"}

    def allowed_origins(self):
        host = self.headers.get("Host", "")
        return {f"http://{host}", f"https://{host}"}

    def _static(self, root, path):
        name = os.path.basename(path)      # basename only; no traversal
        target = root / name
        if not target.is_file():
            return self._send(404, b"not found", "text/plain")
        mime = self.MIME.get(target.suffix, "application/octet-stream")
        self._send(200, target.read_bytes(), mime)

    def _terminal(self, query):
        """Attach to a pty, creating one if the request describes a new terminal."""
        terminal_id = query.get("terminal", [""])[0]
        if terminal_id:
            self.close_connection = True
            return term.serve(self, terminal_id=terminal_id)
        try:
            plan = plan_terminal(query.get("agent", ["claude"])[0],
                                 query.get("cwd", [""])[0], query.get("file", [""])[0])
        except Rejected as exc:
            return self.send_error(exc.status, exc.message)
        self.close_connection = True   # the socket is the websocket now
        term.serve(self, plan.argv, plan.cwd, plan.label, plan.agent,
                   query.get("client", [""])[0], plan.session)

    def _new_terminal(self, body):
        """Create a pty over plain HTTP so a refusal can be read and shown.

        A websocket handshake the server turns down hands the browser neither
        the status nor the body, so creating a terminal this way is the only
        way the UI can tell "no such folder" from "unknown agent" instead of
        reporting every refusal as a connection that dropped.
        """
        try:
            plan = plan_terminal(body.get("agent") or "claude",
                                 body.get("cwd") or "", body.get("file") or "")
            entry = term.REGISTRY.open(plan.argv, plan.cwd, plan.label, plan.agent,
                                       body.get("client") or "", plan.session)
        except Rejected as exc:
            return self._fail(exc.status, exc.message)
        except OSError as exc:              # no pty or no process slot left
            return self._fail(500, "could not start a terminal: %s" % exc)
        payload = json.dumps({"ok": True, "terminal": entry.info}).encode()
        return self._send(200, payload, "application/json")

    def _fail(self, code, message):
        self._send(code, json.dumps({"error": message}).encode(), "application/json")

    def do_POST(self):
        url = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            return self._send(400, b'{"error":"bad body"}', "application/json")
        try:
            if url.path == "/api/terminal/new":
                return self._new_terminal(body)
            if url.path == "/api/terminal/close":
                entry = term.REGISTRY.get(body.get("id"))
                if entry:
                    entry.stop()
                return self._send(200, b'{"ok":true}', "application/json")
            if url.path == "/api/hide":
                sid = body.get("id")
                if not sid:
                    return self._send(400, b'{"error":"no id"}', "application/json")
                PREFS_STORE.hide(sid, bool(body.get("hidden", True)))
                return self._send(200, b'{"ok":true}', "application/json")
            if url.path == "/api/title":
                sid = body.get("id")
                if not sid:
                    return self._send(400, b'{"error":"no id"}', "application/json")
                title = PREFS_STORE.rename(sid, body.get("title", ""))
                return self._send(200, json.dumps({"ok": True, "title": title}).encode(), "application/json")
            if url.path == "/api/layout":
                sid = body.get("id")
                if not sid:
                    return self._send(400, b'{"error":"no id"}', "application/json")
                PREFS_STORE.place(sid, body)
                return self._send(200, b'{"ok":true}', "application/json")
            if url.path == "/api/cluster/refresh":
                found = next((c for c in CLUSTERS if c.name == body.get("name")), None)
                started = found and found.connected() and found.refresh()
                return self._send(200, json.dumps({"ok": True, "started": bool(started)}).encode(), "application/json")
            if url.path == "/api/unhide-all":
                PREFS_STORE.clear()
                return self._send(200, b'{"ok":true}', "application/json")
            self._send(404, b'{"error":"not found"}', "application/json")
        except BrokenPipeError:
            pass
        except Exception as exc:
            self._send(500, json.dumps({"error": str(exc)}).encode(), "application/json")


def main():
    port = int(os.environ.get("AGENTSUI_PORT", "7878"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"AgentsUI  ->  http://localhost:{port}")
    print(f"watching    {PROJECTS}")
    print("ctrl-c to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        term.REGISTRY.shutdown()


if __name__ == "__main__":
    if sys.argv[1:2] in (["sessions"], ["session"]):
        sys.exit(history_main(sys.argv[1:]))
    main()
