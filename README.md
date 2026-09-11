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

- **Colour is identity.** Black ground; each project gets a pastel hue that tints
  its lane and the card marks, so the fleet reads as a spectrum. Status is the
  card border and band: mint working, peach needs input, pink error.
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
  shift+tab mode cycling, everything. Up to six live at once; each open one is a
  chip in the dock's tab bar, and switching between them never reconnects or
  drops scrollback (each xterm lives in a container the client owns and moves).
- **Transcript** shows the full log, refreshed in place as the session writes.
- **+ terminal** (toolbar, the `+` chip, or `+ terminal` on a lane) starts a
  fresh session: pick Claude Code, Codex, or a plain shell, and a folder - lanes
  pre-fill their own folder, and the field suggests every folder seen on the
  board. Claude/Codex show up as a card once they write a transcript; a plain
  shell (for sshing in or running anything by hand) runs in the dock and is not
  tracked as a card.

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

Terminals are hung up from their chip, and on server shutdown.

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
the native binary on one tty; the rail shows it once. Codex's desktop app and
`app-server` processes have no tty and are not listed.

## The rail

The rail lists live `claude` **processes** (from `ps`), which is a different set
from the **sessions** on the board - the board includes dormant transcripts, the
rail only what is running right now. They will not line up one-to-one.

Rows are split into your own terminal windows and the ones AgentsUI spawned
(tagged `here`), since `ps` cannot tell them apart on its own. Each row is tinted
with its project hue to match the lane it belongs to. Clicking a hosted row
focuses that terminal in the dock; clicking one of your own windows opens its
transcript, since there is no way to attach to it.

Each row is paired with the session it is most likely writing by matching process
start time against session start time; the CLI does not hold its transcript open,
so the pairing is inferred.

## Layout

    agentsui.py        transcript scanning, process discovery, HTTP + JSON API
    term.py         pty spawning and a minimal WebSocket implementation
    ui.html         shell and stylesheet
    app.js          state polling, board rendering, the dock
    canvas.js       pan / zoom
    cards.js        lane and card markup (pure string renderers)
    termclient.js   the multi-terminal xterm manager
    vendor/         xterm.js 5.5.0 and the fit addon

Transcripts under `~/.claude/projects` are append-only, so `agentsui.py` keeps a
byte offset per file and parses only what is new. A cold scan of 84MB takes about
half a second; refreshes are a few hundredths.

## API

    GET  /api/state              sessions, subagents, terminals, hosted ptys, build stamp
    GET  /api/session?file=PATH  one transcript, with its message timeline
    GET  /ws/term?file=PATH      websocket: resume that session on a pty
    GET  /ws/term?cwd=DIR        websocket: a new session in that directory
    POST /api/hide               {id, hidden}
    POST /api/unhide-all

`/ws/term` rejects cross-origin requests. Browsers allow cross-origin websockets,
so without that check any page you visited could open a terminal here.
