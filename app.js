/* AgentsUI - board of lanes on the left, one big terminal/transcript dock on the right. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const layer = $("layer"), stage = $("stage"), dock = $("dock"), host = $("termHost");

  let state = null, showHidden = false, showStale = false, selected = null, tab = "term", stamp = null;
  let boardSig = "", clusterSig = "", clusterBtnSig = "", logMtime = 0;
  let clusterName = null;   // which cluster the panel shows, while it is open

  // ---- board -------------------------------------------------------------

  function renderBoard(s) {
    const visible = { ...s, sessions: s.sessions.concat(
      [...drafts.values()].filter((d) => !s.sessions.some((r) => r.id === d.id))) };
    const html = AgentsCards.board(visible, { showHidden, showStale, selected, open: AgentsTerms.ids() });
    const empty = !html;
    $("nudge").hidden = !empty;
    if (empty) {
      $("nudge").textContent = s.sessions.length
        ? "Nothing active this week. The toolbar can show older or hidden sessions."
        : "No sessions yet. Start Claude Code or Codex in any directory and a card appears here.";
    }
    if (html === boardSig || layer.querySelector(".name.editing")) return;   // never rip out a title mid-edit
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
    onReady(id, terminal) {
      const r = row(id);
      if (r) r.terminalId = terminal.id;
      poll();
    },
    onStatus(id, status, message) {
      if (id !== selected) return;
      note(message || "", status === "error" ? "bad" : status === "closed" ? "" : "");
    },
    onClose(id, ended) {
      drafts.delete(id);
      renderTabs();
      if (state) renderBoard(state);
      if (id === selected) note(ended ? "Terminal ended." : "Disconnected — click the card to reconnect.", "");
      poll();
    },
    // The pty never started, so the card stays: the message says why, and
    // clicking it tries again once the reason is dealt with.
    onFail(id, message) {
      renderTabs();
      if (state) renderBoard(state);
      if (id === selected) note(message + " Click the card to try again.", "bad");
      poll();
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
    host.hidden = true; $("log").hidden = true; $("cluster").hidden = true;
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
    const open = state && state.hosted ? state.hosted.length : 0;
    const room = open ? " " + open + (open === 1 ? " terminal" : " terminals") + " running." : "";
    $("newHint").textContent = ($("newAgent").value === "shell"
      ? "Runs a plain login shell on a pty in that folder - ssh in, run anything by hand. It appears on the board immediately."
      : "Runs the real CLI on a pty in that folder. The terminal appears on the board immediately and survives page reloads.") + room;
  }

  function startDraft(agent, dir) {
    dir = dir.trim();
    if (!dir) return;
    const id = "new-" + crypto.randomUUID();
    const name = dir.replace(/\/+$/, "").split("/").pop() || dir;
    const title = agent === "shell" ? "shell in " + name : "new " + agent + " in " + name;
    drafts.set(id, { id, agent, newIn: dir, cwd: dir, project: name, title,
      mtime: Date.now() / 1000, age: 0, status: "idle" });
    $("newForm").hidden = true;
    openPanel(id, "term");
    setTimeout(() => {
      const card = layer.querySelector('[data-id="' + CSS.escape(id) + '"]');
      if (!card) return;
      const bounds = card.getBoundingClientRect(), view = stage.getBoundingClientRect();
      const place = AgentsCanvas.transform();
      AgentsCanvas.setTransform(place.x + view.left + view.width / 2 - bounds.left - bounds.width / 2,
        place.y + view.top + view.height / 2 - bounds.top - bounds.height / 2, place.k);
    }, 250);
  }

  function openPanel(id, which) {
    const r = row(id);
    if (!r) return;
    $("newForm").hidden = true;
    if (!r.newIn && which === "term" && lockedReason(id)) which = "log";
    if (r.agentId) { note("Subagent transcripts cannot be resumed.", "bad"); return; }
    selected = id;
    try { sessionStorage.setItem("agentsui.selected", id); } catch (_) {}
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
    $("cluster").hidden = true;
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
      if (!AgentsTerms.open(host, r, hooks)) {
        note("Could not open terminal; close an existing terminal and try again.", "bad");
        return;
      }
      note(r.newIn ? (r.agent === "shell"
            ? "Shell in " + r.newIn + " - keeps running across page reloads."
            : "New " + r.agent + " session in " + r.newIn + " - shown on the board; keeps running across page reloads.") : "", "");
      setTimeout(() => AgentsTerms.refit(r.id), 220);   // after the dock finishes widening
    } else {
      note("", "");
      loadLog(r.file, false);
    }
  }

  function renderTabs() {
    const ids = [...new Set([...AgentsTerms.ids(), ...(state ? state.sessions.filter((r) => r.terminalId).map((r) => r.id) : [])])];
    const chip = (id, label, on, closable) => {
      const r = row(id);
      const st = r ? AgentsCards.statusOf(r) : { cls: "s-idle" };
      const hue = r ? AgentsCards.hueFor(r.project || r.cwd) : "#C4A7FF";
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
    if (cur && cur.file) {
      html += '<button class="chip chip-log' + (tab === "log" ? " on" : "") + '" data-log="1">Transcript</button>';
    }
    for (const c of (state && state.clusters) || []) {
      if (!c.connected) continue;
      html += '<button class="chip' + (clusterShown(c.name) ? " on" : "") + '" data-cluster="' + AgentsCards.esc(c.name) +
        '" style="--hue:#9BC7FF"><span class="t">' + AgentsCards.esc(c.name) + "</span></button>";
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
    const followLatest = !refresh || log.scrollHeight - log.clientHeight - keep <= 48;
    const html = (d.timeline || []).map((t) => {
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
      log.scrollTop = followLatest ? log.scrollHeight : keep;
    }
  }

  function closePanel() {
    dock.classList.remove("open");
    $("cluster").hidden = true;
    selected = null;
    try { sessionStorage.removeItem("agentsui.selected"); } catch (_) {}
    if (state) renderBoard(state);
  }

  // ---- tally -------------------------------------------------------------

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

  // ---- clusters: free GPUs and your jobs, while an ssh master to each is up ---

  const clusterOf = (name) => ((state && state.clusters) || []).find((c) => c.name === name) || null;
  const clusterShown = (name) => clusterName === name && !$("cluster").hidden && dock.classList.contains("open");

  function renderClusters(list) {
    const btns = (list || []).filter((c) => c.connected).map((c) =>
      '<button class="tbtn tbtn-cluster' + (clusterShown(c.name) ? " on" : "") + '" type="button" data-cluster="' +
      AgentsCards.esc(c.name) + '"' + (c.count.length ? ' title="running and queued: your jobs on ' +
      AgentsCards.esc(c.count.join(" / ")) + ' partitions"' : "") + ">" + AgentsCluster.button(c) + "</button>").join("");
    if (btns !== clusterBtnSig) { clusterBtnSig = btns; $("clusterBtns").innerHTML = btns; }
    const k = clusterOf(clusterName);
    if ($("cluster").hidden || !k) return;
    $("clusterHead").innerHTML = AgentsCluster.head(k, Date.now() / 1000);
    const html = AgentsCluster.body(k);
    if (html !== clusterSig) { clusterSig = html; $("clusterBody").innerHTML = html; }   // keeps a text selection alive
  }

  function openCluster(name) {
    clusterName = name;
    selected = null;
    try { sessionStorage.removeItem("agentsui.selected"); } catch (_) {}
    dock.classList.add("open");
    dock.style.setProperty("--hue", "#9BC7FF");
    $("newForm").hidden = true; host.hidden = true; $("log").hidden = true;
    $("cluster").hidden = false;
    clusterSig = "";
    note("", "");
    renderClusters(state && state.clusters);
    renderTabs();
    if (state) renderBoard(state);
  }

  async function refreshCluster() {
    const k = clusterOf(clusterName);
    if (!k) return;
    k.fetching = true;
    renderClusters(state.clusters);
    await post("/api/cluster/refresh", { name: k.name });
    poll();
  }

  // ---- plumbing ----------------------------------------------------------

  const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).catch(() => {});

  let restoredPanel = false;
  function draw(s) {
    if (stamp == null) stamp = s.build;
    else if (s.build !== stamp) { location.reload(); return; }   // front-end changed on disk
    state = s;
    for (const r of s.sessions) {
      if (r.terminalId) drafts.delete(r.id);
    }
    $("host").textContent = s.host;
    renderTally(s);
    renderClusters(s.clusters);
    renderBoard(s);
    if (selected && !row(selected)) closePanel();
    if (selected || s.hosted.length || !$("cluster").hidden) renderTabs();
    if (!restoredPanel) {
      restoredPanel = true;
      let previous;
      try { previous = sessionStorage.getItem("agentsui.selected"); } catch (_) {}
      if (previous && row(previous) && row(previous).terminalId) openPanel(previous, "term");
    }
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
    if (ev.target.closest(".name.editing")) return;   // clicks inside the editor stay there
    const id = card.dataset.id;
    if (ev.target.closest(".name") && !hide) {
      // A click on the title might be the first half of a rename double-click,
      // so hold the open briefly; dblclick cancels it.
      clearTimeout(nameClickTimer);
      if (ev.detail > 1) return;
      nameClickTimer = setTimeout(() => openPanel(id), 260);
      return;
    }
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
  // ---- rename a card: double-click the title, Enter saves, Escape reverts ----
  let nameClickTimer = null;
  layer.addEventListener("dblclick", (ev) => {
    const name = ev.target.closest(".name");
    const card = ev.target.closest(".card");
    clearTimeout(nameClickTimer);
    if (!name || !card || name.classList.contains("editing")) return;
    ev.preventDefault(); ev.stopPropagation();
    const id = card.dataset.id, r = row(id);
    const before = (r && r.title) || name.textContent;
    name.textContent = before;
    name.classList.add("editing");
    name.contentEditable = "plaintext-only";
    if (name.contentEditable !== "plaintext-only") name.contentEditable = "true";
    name.focus();
    try { const sel = getSelection(), range = document.createRange(); range.selectNodeContents(name); sel.removeAllRanges(); sel.addRange(range); } catch (e) { /* noop */ }
    const finish = (save) => {
      if (!name.classList.contains("editing")) return;
      name.classList.remove("editing");
      name.contentEditable = "false";
      const next = save ? name.textContent.replace(/\s+/g, " ").trim() : before;
      name.textContent = next || before;
      if (save && next !== before) {
        if (r) { r.title = next || r.title; r.renamed = !!next; }
        post("/api/title", { id, title: next });
        boardSig = null;
        if (state) renderBoard(state);
        renderTabs();
      }
    };
    name.addEventListener("keydown", (ke) => {
      if (ke.key === "Enter") { ke.preventDefault(); finish(true); }
      else if (ke.key === "Escape") { ke.preventDefault(); ke.stopPropagation(); finish(false); }
      ke.stopPropagation();
    });
    name.addEventListener("blur", () => finish(true), { once: true });
  });
  layer.addEventListener("keydown", (ev) => {
    const card = ev.target.closest(".card");
    if (!card || (ev.key !== "Enter" && ev.key !== " ")) return;
    ev.preventDefault();
    openPanel(card.dataset.id);
  });

  $("tabs").addEventListener("click", async (ev) => {
    const plus = ev.target.closest("[data-new]");
    if (plus) { openForm(); return; }
    const kill = ev.target.closest("[data-kill]");
    if (kill) {
      ev.stopPropagation();
      const id = kill.dataset.kill;
      try {
        await AgentsTerms.close(id, row(id));
        drafts.delete(id);
        if (selected === id) closePanel();
        await poll();
        renderTabs();
      } catch (_) { note("Could not end terminal. Try again.", "bad"); }
      return;
    }
    const cl = ev.target.closest("[data-cluster]");
    if (cl) { openCluster(cl.dataset.cluster); return; }
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

  addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (document.activeElement && document.activeElement.closest(".term-host")) return;
    if (dock.classList.contains("open")) closePanel();
  });

  $("newTerm").onclick = () => openForm();
  $("clusterBtns").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-cluster]");
    if (b) clusterShown(b.dataset.cluster) ? closePanel() : openCluster(b.dataset.cluster);
  });
  $("clusterHead").addEventListener("click", (ev) => { if (ev.target.closest("[data-refresh]")) refreshCluster(); });
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
