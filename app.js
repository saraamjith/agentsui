/* AgentsUI - board of lanes on the left, one big terminal/transcript dock on the right. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const layer = $("layer"), stage = $("stage"), dock = $("dock"), host = $("termHost");

  let state = null, showHidden = false, showStale = false, selected = null, tab = "term", stamp = null;
  let boardSig = "", railSig = "", logMtime = 0;

  // ---- board -------------------------------------------------------------

  function renderBoard(s) {
    const html = AgentsCards.board(s, { showHidden, showStale, selected, open: AgentsTerms.ids() });
    const empty = !html;
    $("nudge").hidden = !empty;
    if (empty) {
      $("nudge").textContent = s.sessions.length
        ? "Nothing active this week. The toolbar can show older or hidden sessions."
        : "No sessions yet. Start Claude Code or Codex in any directory and a card appears here.";
    }
    if (html === boardSig) return;
    boardSig = html;
    layer.innerHTML = html;
  }

  // ---- dock --------------------------------------------------------------

  // Sessions started from here have no transcript yet, so they live in
  // `drafts` until the agent writes one and a real card appears.
  const drafts = new Map();
  const row = (id) => (state && state.sessions.find((r) => r.id === id)) || drafts.get(id);

  // A terminal window you own that is already running this session. Spawning
  // another `claude --resume` on it makes a second process on one conversation:
  // both append to the same transcript, and only one gets Remote Control.
  const externalTerminal = (id) =>
    (state && state.terminals.find((t) => t.session === id && !t.hosted)) || null;

  // Why a session cannot get a dock terminal, or "" if it can. Running a second
  // process on a live session corrupts its shared transcript.
  function lockedReason(id) {
    if (state && id === state.self) return "This session is running AgentsUI itself.";
    const ext = externalTerminal(id);
    if (ext) return "Already running in " + ext.tty + ".";
    return "";
  }
  const hooks = {
    onStatus(id, status, message) {
      if (id !== selected) return;
      note(message || "", status === "error" ? "bad" : status === "closed" ? "" : "");
    },
    onClose(id) {
      drafts.delete(id);
      renderTabs();
      if (state) renderBoard(state);
      if (id === selected) note("Terminal ended - click the card again to start another.", "");
    },
  };

  function note(text, cls) {
    const el = $("note");
    el.className = "dock-note" + (cls ? " " + cls : "");
    el.textContent = text;
  }

  $("note").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-log]") && selected) openPanel(selected, "log");
  });

  function openForm(dir) {
    selected = null;
    dock.classList.add("open");
    host.hidden = true; $("log").hidden = true;
    note("", "");
    const form = $("newForm");
    form.hidden = false;
    const dirs = [...new Set((state ? state.sessions : []).map((r) => r.cwd).filter(Boolean))];
    $("dirList").innerHTML = dirs.map((d) => '<option value="' + AgentsCards.esc(d) + '">').join("");
    $("newDir").value = dir || $("newDir").value || "~";
    newHint();
    renderTabs();
    $("newDir").focus();
  }

  function newHint() {
    $("newHint").textContent = $("newAgent").value === "shell"
      ? "Runs a plain login shell on a pty in that folder - ssh in, run anything by hand. It is not tracked as a session card."
      : "Runs the real CLI on a pty in that folder. The session shows up as a card once it writes its first transcript.";
  }

  function startDraft(agent, dir) {
    dir = dir.trim();
    if (!dir) return;
    const id = "new-" + Date.now().toString(36);
    const name = dir.replace(/\/+$/, "").split("/").pop() || dir;
    const title = agent === "shell" ? "shell in " + name : "new " + agent + " in " + name;
    drafts.set(id, { id, agent, newIn: dir, cwd: dir, project: name, title });
    $("newForm").hidden = true;
    openPanel(id, "term");
  }

  function openPanel(id, which) {
    const r = row(id);
    if (!r) return;
    $("newForm").hidden = true;
    if (!r.newIn && which === "term" && lockedReason(id)) which = "log";
    if (r.agentId) { note("Subagent transcripts cannot be resumed.", "bad"); return; }
    selected = id;
    tab = which || "term";
    dock.classList.add("open");
    dock.style.setProperty("--hue", AgentsCards.hueFor(r.project || r.cwd));
    showTab();
    renderTabs();
    if (state) renderBoard(state);
  }

  function showTab() {
    const r = row(selected);
    host.hidden = tab !== "term";
    $("log").hidden = tab !== "log";
    if (!r) return;
    if (tab === "term") {
      const lock = r.newIn ? "" : lockedReason(r.id);
      if (lock && !AgentsTerms.has(r.id)) {
        // Cannot safely run a terminal here - show the transcript instead.
        tab = "log";
        host.hidden = true; $("log").hidden = false;
        renderTabs();
        note(lock + " Open it in that terminal, or read the transcript here.", "warn");
        loadLog(r.file, false);
        return;
      }
      // One host, many live terminals: move the chosen one in, park the rest.
      host.replaceChildren();
      AgentsTerms.open(host, r, hooks);
      note(r.newIn ? (r.agent === "shell"
            ? "Shell in " + r.newIn + " - runs until you close it, not tracked as a card."
            : "New " + r.agent + " session in " + r.newIn + " - its card appears once it writes a transcript.") : "", "");
      setTimeout(() => AgentsTerms.refit(r.id), 220);   // after the dock finishes widening
    } else {
      note("", "");
      loadLog(r.file, false);
    }
  }

  function renderTabs() {
    const ids = AgentsTerms.ids();
    const chip = (id, label, on, closable) => {
      const r = row(id);
      const st = r ? AgentsCards.statusOf(r) : { cls: "s-idle" };
      const hue = r ? AgentsCards.hueFor(r.project || r.cwd) : "#BDB2FF";
      return '<button class="chip ' + st.cls + (on ? " on" : "") + '" data-open="' + AgentsCards.esc(id) +
        '" style="--hue:' + hue + '" title="' + AgentsCards.esc(label) + '">' +
        '<span class="pip"></span><span class="t">' + AgentsCards.esc(label) + "</span>" +
        (closable ? '<span class="x" data-kill="' + AgentsCards.esc(id) + '" title="End this terminal">&times;</span>' : "") +
        "</button>";
    };
    let html = ids.map((id) => {
      const r = row(id);
      return chip(id, r ? (r.title || r.project || id.slice(0, 8)) : id.slice(0, 8), id === selected && tab === "term", true);
    }).join("");
    // The selected session gets a Terminal tab, unless it is locked (running
    // elsewhere) - then a terminal here would corrupt its transcript.
    if (selected && ids.indexOf(selected) < 0) {
      const cur0 = row(selected);
      const lock = cur0 && !cur0.newIn ? lockedReason(selected) : "";
      if (lock) html += '<span class="chip locked" title="' + AgentsCards.esc(lock) + '">terminal locked</span>';
      else html += chip(selected, "Terminal", tab === "term", false);
    }
    const cur = row(selected);
    if (cur && !cur.newIn) {
      html += '<button class="chip chip-log' + (tab === "log" ? " on" : "") + '" data-log="1">Transcript</button>';
    }
    html += '<button class="chip chip-plus' + (!$("newForm").hidden ? " on" : "") + '" data-new="" title="Start a new terminal">+</button>';
    $("tabs").innerHTML = html + '<button class="dock-close" id="dockClose" aria-label="Close panel">&times;</button>';
  }

  async function loadLog(file, refresh) {
    const log = $("log");
    if (!refresh) { log.innerHTML = '<p class="blank">Reading transcript…</p>'; delete log.dataset.html; }
    const d = await fetch("/api/session?file=" + encodeURIComponent(file)).then((r) => r.json()).catch(() => null);
    if (!d || !row(selected) || row(selected).file !== file) return;
    logMtime = d.mtime || 0;
    const keep = log.scrollTop;
    const html = (d.timeline || []).slice().reverse().map((t) => {
      if (t.role === "tool") {
        return '<div class="turn tool"><span class="tool-name">' + AgentsCards.esc(t.body) +
          '</span><span class="tool-arg">' + AgentsCards.esc(t.detail) + "</span></div>";
      }
      return '<div class="turn ' + t.role + '"><div class="turn-who">' + (t.role === "user" ? "you" : "claude") +
        '</div><div class="turn-body">' + AgentsCards.esc(t.body) + "</div></div>";
    }).join("") || '<p class="blank">Nothing recorded in this transcript yet.</p>';
    if (log.dataset.html !== html) {
      log.dataset.html = html;
      log.innerHTML = html;
      log.scrollTop = refresh ? keep : 0;
    }
  }

  function closePanel() {
    dock.classList.remove("open");
    selected = null;
    if (state) renderBoard(state);
  }

  // ---- rail / tally --------------------------------------------------------

  function renderRail(terms) {
    const rail = $("rail");
    $("railHead").innerHTML = '<b>Live processes</b>' + terms.length +
      " running &middot; " + (state ? state.sessions.filter((r) => !r.stale).length : 0) + " sessions this week";
    if (!terms.length) {
      const html = '<p class="rail-empty">No claude processes running.</p>';
      if (html !== railSig) { railSig = html; rail.innerHTML = html; }
      return;
    }
    // Terminals this app spawned look identical to real windows in `ps`,
    // so they get their own group rather than sitting among them.
    const mine = terms.filter((t) => t.hosted);
    const theirs = terms.filter((t) => !t.hosted);
    const group = (label, list) => !list.length ? "" :
      '<div class="rail-group">' + label + "</div>" + list.map(termRow).join("");
    const html = group("your terminal windows", theirs) + group("opened here", mine);
    if (html === railSig) return;
    railSig = html;
    rail.innerHTML = html;
  }

  function termRow(t) {
    const band = t.streaming ? "live" : (t.age != null && t.age < 3600 ? "warm" : "");
    const hue = AgentsCards.hueFor(t.project || t.cwd);
    return '<button class="term" data-sess="' + AgentsCards.esc(t.session || "") +
      '" data-hosted="' + (t.hosted ? 1 : 0) + '" style="--hue:' + hue + '">' +
      '<div class="term-top"><span class="dot ' + band + '"></span>' +
      '<span class="term-tty">' + AgentsCards.esc(t.tty) + "</span>" +
      '<span class="term-agent">' + (t.agent === "codex" ? "codex" : "claude") + "</span>" +
      '<span class="term-pid">' + t.pid + "</span></div>" +
      '<div class="term-proj">' + AgentsCards.esc(t.project || t.cwd || "?") +
      (t.hosted ? '<span class="tag">here</span>' : "") + "</div>" +
      '<div class="term-what">' + AgentsCards.esc(t.title || "up " + AgentsCards.ago(t.uptime)) +
      "</div></button>";
  }

  function renderTally(s) {
    const working = s.sessions.filter((r) => r.status === "working").length;
    const waiting = s.sessions.filter((r) => r.status === "waiting").length;
    const recent = s.sessions.filter((r) => !r.stale);
    const codex = recent.filter((r) => r.agent === "codex").length;
    const stale = s.sessions.length - recent.length;
    $("tally").innerHTML =
      "<span><b>" + s.terminals.length + "</b> terminals</span><span><b>" + recent.length + "</b> this week" +
      (codex ? " <i>(" + codex + " codex)</i>" : "") + "</span>" +
      "<span><b>" + s.subagents.length + "</b> subagents</span>" +
      (waiting ? '<span style="color:var(--warm)"><b style="color:var(--warm)">' + waiting + "</b> need input</span>" : "") +
      '<span><span class="beacon ' + (working ? "on" : "") + '"></span> <b>' + working + "</b> working</span>";
    const hidden = s.sessions.filter((r) => r.hidden).length;
    const btn = $("showHidden");
    btn.hidden = !hidden;
    btn.textContent = showHidden ? "hide stowed" : hidden + " hidden";
    btn.classList.toggle("on", showHidden);
    $("restore").hidden = !(hidden && showHidden);
    $("restore").textContent = "restore all " + hidden;
    const older = $("showStale");
    older.hidden = !stale;
    older.textContent = showStale ? "this week only" : stale + " older";
    older.classList.toggle("on", showStale);
  }

  // ---- plumbing ----------------------------------------------------------

  const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).catch(() => {});

  function draw(s) {
    if (stamp == null) stamp = s.build;
    else if (s.build !== stamp) { location.reload(); return; }   // front-end changed on disk
    state = s;
    $("host").textContent = s.host;
    renderTally(s);
    renderRail(s.terminals);
    renderBoard(s);
    if (selected) renderTabs();
  }

  async function poll() {
    try {
      const s = await fetch("/api/state").then((r) => r.json());
      draw(s);
      const r = row(selected);
      if (r && tab === "log" && (r.mtime || 0) > logMtime) loadLog(r.file, true);
    } catch (e) { /* next poll */ }
  }

  // ---- events ------------------------------------------------------------

  layer.addEventListener("click", (ev) => {
    const lane = ev.target.closest("[data-new]");
    if (lane) { ev.stopPropagation(); openForm(lane.dataset.new); return; }
    const hide = ev.target.closest("[data-act='hide']");
    const card = ev.target.closest(".card");
    if (!card) return;
    const id = card.dataset.id;
    if (hide) {
      ev.stopPropagation();
      const r = row(id);
      const next = !(r && r.hidden);
      if (r) r.hidden = next;
      post("/api/hide", { id, hidden: next });
      renderTally(state); renderBoard(state);
      return;
    }
    openPanel(id);
  });
  layer.addEventListener("keydown", (ev) => {
    const card = ev.target.closest(".card");
    if (!card || (ev.key !== "Enter" && ev.key !== " ")) return;
    ev.preventDefault();
    openPanel(card.dataset.id);
  });

  $("tabs").addEventListener("click", (ev) => {
    const plus = ev.target.closest("[data-new]");
    if (plus) { openForm(); return; }
    const kill = ev.target.closest("[data-kill]");
    if (kill) { ev.stopPropagation(); AgentsTerms.close(kill.dataset.kill); renderTabs(); if (state) renderBoard(state); return; }
    const open = ev.target.closest("[data-open]");
    if (open) return openPanel(open.dataset.open, "term");
    if (ev.target.closest("[data-log]")) { if (selected) openPanel(selected, "log"); return; }
    if (ev.target.closest("#dockClose")) closePanel();
  });

  // ---- dock resize: drag the left edge; width persists across reloads -------
  const DOCK_W_KEY = "agentsui.dockWidth", DOCK_MIN = 360, DOCK_MARGIN = 320;
  (() => {
    const grip = $("dockGrip");
    if (!grip) return;
    let startX = 0, startW = 0;
    const clampW = (w) => Math.max(DOCK_MIN, Math.min(w, innerWidth - DOCK_MARGIN));
    try {
      const saved = parseInt(localStorage.getItem(DOCK_W_KEY), 10);
      if (saved > 0) dock.style.setProperty("--dock-w", clampW(saved) + "px");
    } catch (e) { /* storage unavailable */ }
    grip.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || !dock.classList.contains("open")) return;
      startX = ev.clientX; startW = dock.getBoundingClientRect().width;
      dock.classList.add("dragging");
      grip.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    grip.addEventListener("pointermove", (ev) => {
      if (!dock.classList.contains("dragging")) return;
      dock.style.setProperty("--dock-w", clampW(startW + (startX - ev.clientX)) + "px");
    });
    const end = (ev) => {
      if (!dock.classList.contains("dragging")) return;
      dock.classList.remove("dragging");
      try { grip.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
      try { localStorage.setItem(DOCK_W_KEY, String(Math.round(dock.getBoundingClientRect().width))); } catch (e) { /* noop */ }
      AgentsTerms.refitAll();
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    grip.addEventListener("dblclick", () => {
      dock.style.removeProperty("--dock-w");
      try { localStorage.removeItem(DOCK_W_KEY); } catch (e) { /* noop */ }
      setTimeout(() => AgentsTerms.refitAll(), 220);
    });
  })();

  $("rail").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-sess]");
    if (btn && btn.dataset.sess) openPanel(btn.dataset.sess, btn.dataset.hosted === "1" ? "term" : "log");
  });

  addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (document.activeElement && document.activeElement.closest(".term-host")) return;
    if (dock.classList.contains("open")) closePanel();
  });

  $("newTerm").onclick = () => openForm();
  $("newAgent").onchange = newHint;
  $("newForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    startDraft($("newAgent").value, $("newDir").value);
  });
  $("newCancel").onclick = () => { $("newForm").hidden = true; if (!selected) closePanel(); else renderTabs(); };
  $("fit").onclick = () => AgentsCanvas.fit();
  $("zoomIn").onclick = () => AgentsCanvas.zoomBy(1.2);
  $("zoomOut").onclick = () => AgentsCanvas.zoomBy(1 / 1.2);
  $("zoomPct").onclick = () => AgentsCanvas.zoomTo(1);
  $("showHidden").onclick = () => { showHidden = !showHidden; renderTally(state); renderBoard(state); };
  $("showStale").onclick = () => { showStale = !showStale; renderTally(state); renderBoard(state); };
  $("restore").onclick = async () => {
    state.sessions.forEach((r) => { r.hidden = false; });
    showHidden = false;
    renderTally(state); renderBoard(state);
    await post("/api/unhide-all");
  };

  AgentsCanvas.init({ stage, layer, onPlace() {} });
  const showZoom = (t) => { $("zoomPct").textContent = Math.round(t.k * 100) + "%"; };
  AgentsCanvas.onChange(showZoom);
  showZoom(AgentsCanvas.transform());

  poll();
  setInterval(poll, 3000);
})();
