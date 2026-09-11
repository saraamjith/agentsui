// AgentsCards -- pure HTML-string renderers for the AgentsUI board.
// Sessions are grouped into lanes by project; each card is a compact overview.
// No DOM access, no listeners: app.js delegates using data-id / data-act hooks.
(function () {
  "use strict";

  var STATUS = { working: "Working", waiting: "Needs input", error: "Error", idle: "Idle" };
  // Pastel rainbow, one hue per project so a fleet reads as a spectrum.
  var HUES = ["#FFADAD", "#FFD6A5", "#FDFFB6", "#CAFFBF", "#9BF6FF", "#A0C4FF", "#BDB2FF", "#FFC6FF"];

  function esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function trunc(str, n) {
    str = String(str == null ? "" : str).replace(/\s+/g, " ").trim();
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  }
  function ago(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return "--";
    var s = Math.max(0, seconds);
    if (s < 45) return "now";
    if (s < 3600) return Math.round(s / 60) + "m";
    if (s < 86400) return Math.round(s / 3600) + "h";
    return Math.round(s / 86400) + "d";
  }
  function hueFor(name) {
    var h = 0, s = String(name || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return HUES[h % HUES.length];
  }
  function statusOf(session) {
    var key = session && STATUS.hasOwnProperty(session.status) ? session.status : "idle";
    return { key: key, label: STATUS[key], cls: "s-" + key };
  }
  function toolName(label) {
    var m = /^mcp__[^_]+(?:-[^_]+)*__(.+)$/.exec(label || "");
    return m ? m[1] : (label || "tool");
  }

  // The one thing the card says about what the agent is doing.
  function taskOf(s) {
    var events = (Array.isArray(s.events) ? s.events : []).slice()
      .sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
    var last = events[0];
    if (s.status === "working" && last && last.kind === "tool") {
      return { tag: toolName(last.label), text: last.detail || "" };
    }
    if (s.status === "waiting" && s.lastSaid) return { tag: "said", text: s.lastSaid };
    if (s.lastPrompt) return { tag: "you asked", text: s.lastPrompt };
    if (s.lastSaid) return { tag: "said", text: s.lastSaid };
    return { tag: "", text: "Nothing recorded yet." };
  }

  function card(s, opts) {
    opts = opts || {};
    var st = statusOf(s);
    var task = taskOf(s);
    var when = s.streaming ? "now" : ago(s.age) + " ago";
    var kids = opts.kids || [];
    var busy = kids.filter(function (k) { return k.streaming; }).length;
    var facts = [];
    if (s.cwd) facts.push('<div class="fact"><span class="glyph">&#9707;</span>' + esc(trunc(s.cwd.replace(/^\/Users\/[^/]+/, "~"), 40)) + "</div>");
    if (s.branch && s.branch !== "HEAD") facts.push('<div class="fact"><span class="glyph">&#8916;</span>' + esc(trunc(s.branch, 40)) + "</div>");
    if (opts.terminal) facts.push('<div class="fact"><span class="glyph">&#9645;</span>' + esc(opts.terminal.tty) + " &middot; pid " + opts.terminal.pid + "</div>");
    if (kids.length) facts.push('<div class="fact"><span class="glyph">&#10070;</span>' + kids.length + " subagent" + (kids.length === 1 ? "" : "s") + (busy ? ", " + busy + " running" : "") + "</div>");

    return (
      '<article class="card ' + st.cls + (opts.selected ? " sel" : "") + (opts.open ? " open" : "") +
      '" data-id="' + esc(s.id) + '" data-file="' + esc(s.file) + '" tabindex="0" role="button">' +
      '<div class="band"><span class="pip"></span><span class="band-label">' + st.label + "</span>" +
      '<span class="band-when">' + esc(when) + "</span>" +
      '<button class="hide" data-act="hide" title="Hide this card" aria-label="Hide this card">&times;</button></div>' +
      '<div class="ident"><span class="mark mark-' + esc(s.agent || "claude") + '">' +
      (opts.open ? "&#9646;" : (s.agent === "codex" ? "&#11041;" : "&#10022;")) + "</span>" +
      '<div class="ident-text"><h3 class="name" data-act="rename" title="Double-click to rename">' + esc(trunc(s.title || s.lastPrompt || "untitled session", 60)) + "</h3>" +
      '<div class="sub"><span class="agent-name">' + esc(s.agent === "shell" ? "Shell" : s.agent === "codex" ? "Codex" : "Claude Code") +
      "</span> &middot; " + esc(String(s.model || (s.agent === "shell" ? "shell" : s.agent === "codex" ? "codex" : "claude")).replace(/^claude-/, "")) +
      (opts.tty ? ' &middot; <span class="on-tty">' + esc(opts.tty) + "</span>" : "") +
      (s.nErrors ? ' &middot; <span class="bad">' + s.nErrors + " failed</span>" : "") + "</div></div></div>" +
      '<div class="task">' + (task.tag ? '<div class="task-tag">' + esc(task.tag) + "</div>" : "") +
      '<div class="task-text">' + esc(trunc(task.text, 120)) + "</div></div>" +
      '<div class="facts">' + facts.join("") + "</div>" +
      "</article>"
    );
  }

  // Lanes: one per project, most recently active first.
  function board(state, opts) {
    opts = opts || {};
    var rows = state.sessions.filter(function (r) {
      return (opts.showHidden || !r.hidden) && (opts.showStale || !r.stale);
    });
    var lanes = {};
    rows.forEach(function (r) {
      var key = r.project || "(no directory)";
      (lanes[key] = lanes[key] || []).push(r);
    });
    var names = Object.keys(lanes).sort(function (a, b) {
      var la = Math.max.apply(null, lanes[a].map(function (r) { return r.mtime || 0; }));
      var lb = Math.max.apply(null, lanes[b].map(function (r) { return r.mtime || 0; }));
      return lb - la;
    });
    if (!names.length) return "";
    return names.map(function (name) {
      var list = lanes[name].slice().sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); });
      var hue = hueFor(name === "(no directory)" ? "" : name);
      var working = list.filter(function (r) { return r.status === "working"; }).length;
      var waiting = list.filter(function (r) { return r.status === "waiting"; }).length;
      var note = [];
      if (working) note.push(working + " working");
      if (waiting) note.push(waiting + " need input");
      return (
        '<section class="lane" style="--hue:' + hue + '" data-lane="' + esc(name) + '">' +
        '<header class="lane-head"><h2 class="lane-name">' + esc(name) + "</h2>" +
        '<span class="lane-note">' + list.length + " session" + (list.length === 1 ? "" : "s") +
        (note.length ? " &middot; " + note.join(" &middot; ") : "") + "</span>" +
        (list[0].cwd ? '<button class="lane-new" data-new="' + esc(list[0].cwd) + '" title="Start a new terminal in ' +
          esc(list[0].cwd) + '">+ terminal</button>' : "") + "</header>" +
        '<div class="lane-cards">' + list.map(function (r) {
          return card(r, {
            kids: state.subagents.filter(function (k) { return k.parent === r.id; }),
            terminal: state.terminals.find(function (t) { return t.session === r.id; }) || null,
            tty: (state.terminals.find(function (t) { return t.session === r.id && !t.hosted; }) || {}).tty || null,
            selected: opts.selected === r.id,
            open: opts.open && opts.open.indexOf(r.id) >= 0,
          });
        }).join("") + "</div></section>"
      );
    }).join("");
  }

  window.AgentsCards = { board: board, card: card, statusOf: statusOf, hueFor: hueFor, ago: ago, esc: esc };
})();
