<img width="1504" height="783" alt="image" src="https://github.com/user-attachments/assets/b85c269c-9ab3-40a8-a747-2ff0eefa64d1" />

# AgentsUI

A local command center for every Claude Code and Codex session on this machine.
Sessions are cards grouped into project lanes; click one to open the real agent
terminal in the dock, with several live at once.

    python3 agentsui.py        # then open http://localhost:7878

No dependencies - Python standard library, with xterm.js vendored in `vendor/`.
Set `AGENTSUI_PORT` to use a different port. Binds to 127.0.0.1 only.

## The board

Sessions active in the last week are grouped into lanes, one per project, most
recently active first. Older ones stay off the board until you press the
`N older` count in the toolbar; nothing is deleted.
Each card is a compact overview: a status band (Working / Needs input / Error /
Idle), the session title and model, one block saying what it is doing right now
- the running tool while it works, what it said when it is waiting on you - and
mono fact rows for directory, branch, tty and subagents.

- **Colour is identity.** Black ground; each project gets a pink, blue, or purple hue that tints
  its lane and the card marks, so the fleet reads as a spectrum. Status is the
  card border and band: blue working, purple needs input, pink error.
- **Click a card** to open it in the dock. **x** on the band stows it. The count
  in the toolbar reveals stowed cards, and `restore all` puts them back. Only an
  id is written to `~/.claude/agentsui.json` - transcripts are never touched.
- **Pan** by dragging the background or scrolling; **zoom** with ctrl/cmd+scroll,
  the +/- buttons, `fit`, or the percentage to return to 100%.

## The dock

The right-hand panel where you actually work with a session. It sits outside the
canvas transform, so it is always full size regardless of zoom.

- **Terminal** spawns a real `claude --resume <session-id>` on a pty and streams
  it over a WebSocket - slash commands and their autocomplete, permission prompts,
  shift+tab mode cycling, everything. As many live at once as you like; each
  open one is a chip in the dock's tab bar, and switching between them never
  reconnects or drops scrollback (each xterm lives in a container the client
  owns and moves).
- **Transcript** shows the full log, refreshed in place as the session writes.
- **+ terminal** (toolbar, the `+` chip, or `+ terminal` on a lane) starts a
  fresh session: pick Claude Code, Codex, or a plain shell, and a folder - lanes
  pre-fill their own folder, and the field suggests every folder seen on the
  board. New terminals show up as cards immediately; a plain
  shell (for sshing in or running anything by hand) also has a card while running.

Two things worth knowing:

- It cannot attach to a terminal that already exists. ttys022 and friends are
  owned by their own terminal emulators and there is no way in without something
  like tmux. Opening a session here starts a *new* process continuing it.
- So if one of your own terminal windows is already running that session, the
  dock refuses to spawn and names the tty, offering `open anyway` or the
  transcript instead. A second copy is legal - both processes append to the same
  transcript - but only one of them holds Remote Control for the conversation,
  and the other prints a notice saying so.
- Spawned terminals do not inherit this server's `CLAUDE_CODE_*` session markers.
  Left in place, `CLAUDE_CODE_CHILD_SESSION` turns off transcript saving and the
  new session would never appear on the board.

Terminals belong to the server and survive page reloads or a disconnected browser.
New terminals (including plain shells) appear on the board immediately. Click a
card to reconnect to the same process; the last 2 MiB of output is replayed. The
selected terminal is reopened after reload. The panel's × only hides the panel;
the × on a terminal chip ends that terminal and its child processes. Server
shutdown still ends hosted terminals.

## Agents

Two sources feed the board, and they mix freely inside a lane:

- **Claude Code** - `~/.claude/projects/*/<session>.jsonl`, plus subagents under
  each session. Resumed with `claude --resume <id>`.
- **Codex** - `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Titles come from
  the first prompt a person typed (Codex injects AGENTS.md, environment blocks
  and its compaction placeholder as user messages; those are skipped). Resumed
  with `codex resume <id>`.

Each card says which it is on the line under the title, and the mark differs
(a star for Claude, a hexagon for Codex). A live Codex TUI is a node wrapper plus
the native binary on one tty; it is counted once. Codex's desktop app and
`app-server` processes have no tty and are not listed.

## Shared memory

Claude and Codex terminals opened here share one memory per project: Claude
Code's own auto-memory folder, `~/.claude/projects/<project>/memory/` (keyed by
the repo root). Claude reads its `MEMORY.md` index natively. Codex terminals,
new or resumed, are started with `--sandbox workspace-write` and `--add-dir`
on that folder, so Codex can write there even when its default permissions are
read-only, and a `developer_instructions` override telling it to read the index at
the start of a task and to save memories in Claude's format (one fact per file
with frontmatter, plus a line in `MEMORY.md`). Whatever one agent saves, the
other sees in its next session.

Past sessions are shared too. Either agent can read what the other did before:

    python3 agentsui.py sessions [DIR]       # both agents' sessions in DIR's project, newest first
    python3 agentsui.py session <id> [DIR]   # one of them as a readable conversation

These use the same transcript parsers as the board and read the files directly,
so the server doesn't need to be running. Claude terminals opened here are told
about the commands with `--append-system-prompt`, and Codex terminals through
the same `developer_instructions` as the memory note.

All of this only applies to terminals launched from AgentsUI. Agents in your own
terminal windows don't know about the memory folder or the commands.

## Live processes

Live `claude`/`codex` processes (from `ps`) are a different set from the
**sessions** on the board - the board includes dormant transcripts, `ps` only
what is running right now. Each process is paired with the session it is most
likely writing by matching process start time against session start time (the
CLI does not hold its transcript open, so the pairing is inferred), and that
card shows its tty and pid.

## Clusters

If you use Slurm clusters, each one you list gets a toolbar button showing its
free GPUs and how many of your jobs are running and queued. Click it for a dock
panel with the full output of the GPU and job commands, colours and all. They
refresh every 20 minutes on their own, or now with `refresh`.

List them in `~/.claude/agentsui-clusters.json` (or the file named by
`AGENTSUI_CLUSTERS`):

    [{"name": "lab", "host": "login.example.edu",
      "gpus": "~/bin/gpus --color",
      "jobs": "squeue -u \"$USER\" -o \"%.14i %.24j %.2t %.10M %.5D %P\"",
      "count": ["shared"]}]

`gpus` and `jobs` are commands run on the host. The free counts are read from a
`free` line of `name count` pairs in the GPU output. `count` is optional and
limits the running / queued counts to partitions with those prefixes (a pending
job counts if any partition it may run on matches); keep the partition column
last and unpadded so squeue doesn't cut it short.

Login hosts often want a password and 2FA, so AgentsUI never logs in itself.
It looks for the ssh ControlMaster your own `ssh <host>` opened
(`ssh -O check`) and runs the commands through it with `BatchMode=yes`; no
master, no button. With `ControlMaster auto` and `ControlPersist 3d` in
`~/.ssh/config` the master outlives the shell you typed `ssh` in, so the panel
stays up until it expires. A failed fetch keeps the last good output, says why,
and retries a minute later.

## Layout

    agentsui.py        transcript scanning, process discovery, HTTP + JSON API
    term.py         pty spawning and a minimal WebSocket implementation
    cluster.py      Slurm GPU / job listings over an existing ssh master
    ui.html         shell and stylesheet
    app.js          state polling, board rendering, the dock
    canvas.js       pan / zoom
    cards.js        lane and card markup (pure string renderers)
    termclient.js   the multi-terminal xterm manager
    cluster.js      cluster panel markup: ANSI colours to spans, toolbar summary
    vendor/         xterm.js 5.5.0 and the fit addon

Transcripts under `~/.claude/projects` are append-only, so `agentsui.py` keeps a
byte offset per file and parses only what is new. A cold scan of 84MB takes about
half a second; refreshes are a few hundredths.

## API

    GET  /api/state              sessions, subagents, terminals, hosted ptys, clusters, build stamp
    GET  /api/session?file=PATH  one transcript, with its message timeline
    POST /api/terminal/new       {client, agent, cwd} or {client, file}: start a pty
    POST /api/terminal/close     {id}: end a pty and reap its process group
    GET  /ws/term?terminal=ID    websocket: attach to a pty from /api/terminal/new
    GET  /ws/term?file=PATH      websocket: resume that session on a pty
    GET  /ws/term?cwd=DIR        websocket: a new session in that directory
    POST /api/hide               {id, hidden}
    POST /api/unhide-all
    POST /api/cluster/refresh    {name}: fetch that cluster's listings now

The UI starts terminals with `/api/terminal/new` and then attaches by id. A
websocket the server turns down reports only "error" to the browser - no status
and no body - so a terminal created over the websocket alone can only fail
mutely. Creating it over HTTP is what lets the UI say which of "no such folder",
"unknown agent" or "that session is running AgentsUI itself" it ran into. The
`cwd=`/`file=` websocket forms still work for other clients.

`/ws/term` rejects cross-origin requests. Browsers allow cross-origin websockets,
so without that check any page you visited could open a terminal here.
