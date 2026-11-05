// AgentsTerms — multi-terminal manager for AgentsUI.
// Keeps each xterm instance alive in a detached container so a 3s poll
// re-render (which destroys/recreates .term-host) never kills a live pty
// session or its scrollback. Plain ES2019, no build step.
(function () {
  "use strict";

  const RESIZE_DEBOUNCE_MS = 100;

  const THEME = {
      background: "#000000", foreground: "#F7F2FF", cursor: "#F5B0E0", cursorAccent: "#000000",
      selectionBackground: "#3B2855",
      black: "#20182C", red: "#FF91C8", green: "#9BC7FF", yellow: "#D2ADFF",
      blue: "#86B5F9", magenta: "#E49BEF", cyan: "#AAB7FF", white: "#EEE5FA",
      brightBlack: "#9A8DAB", brightRed: "#FFB8DF", brightGreen: "#C0DDFF", brightYellow: "#E7CCFF",
      brightBlue: "#BAD8FF", brightMagenta: "#F5C5FF", brightCyan: "#D0D7FF", brightWhite: "#FFFFFF",
    };

  // registry: id -> { term, fit, sock, container, ro, hooks, resizeTimer, destroyed }
  const registry = new Map();

  function safeCall(fn) {
    try { fn && fn(); } catch (e) { /* never let a bad terminal break others */ }
  }

  function sendSize(entry) {
    if (!entry.sock || entry.sock.readyState !== 1) return;
    const rows = entry.term.rows, cols = entry.term.cols;
    if (!rows || !cols || Number.isNaN(rows) || Number.isNaN(cols)) return;
    safeCall(() => entry.sock.send(JSON.stringify({ t: "size", rows, cols })));
  }

  function doFit(entry) {
    requestAnimationFrame(() => {
      if (entry.destroyed) return;
      try { entry.fit.fit(); } catch (e) { return; }
      sendSize(entry);
      if (entry.scrollOnFit) {
        entry.scrollOnFit = false;
        entry.term.write("", () => {
          if (!entry.destroyed) entry.term.scrollToBottom();
        });
      }
    });
  }

  function scheduleFit(entry) {
    if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
    entry.resizeTimer = setTimeout(() => {
      entry.resizeTimer = null;
      doFit(entry);
    }, RESIZE_DEBOUNCE_MS);
  }

  function reportStatus(entry, status, message) {
    safeCall(() => entry.hooks && entry.hooks.onStatus && entry.hooks.onStatus(entry.id, status, message));
  }

  function endTerminal(terminalId) {
    return fetch("/api/terminal/close", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: terminalId }),
    });
  }

  // Ask for the pty over plain HTTP before opening the socket. A websocket the
  // server turns down reports only "error" to the browser - no status, no body -
  // so a refusal made over HTTP is the only kind the UI can explain.
  async function create(session) {
    const response = await fetch("/api/terminal/new", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: session.id, agent: session.agent || "claude",
        cwd: session.newIn || "", file: session.newIn ? "" : (session.file || ""),
      }),
    });
    let data = null;
    try { data = await response.json(); } catch (e) { /* an error page, not JSON */ }
    if (!response.ok || !data || !data.terminal) {
      throw new Error((data && data.error) || "could not start a terminal (" + response.status + ")");
    }
    return data.terminal;
  }

  function failed(entry, message) {
    if (entry.destroyed) return;
    registry.delete(entry.id);
    safeCall(() => entry.term.write("\r\n[" + message + "]\r\n"));
    reportStatus(entry, "error", message);
    safeCall(() => entry.ro && entry.ro.disconnect());
    safeCall(() => entry.hooks && entry.hooks.onFail && entry.hooks.onFail(entry.id, message));
  }

  function connect(entry, session) {
    if (session.terminalId) return openSocket(entry, session.terminalId);
    create(session).then((terminal) => {
      entry.terminalId = terminal.id;
      // Closed while the pty was starting: end it rather than orphan it.
      if (entry.destroyed || entry.endRequested) return endTerminal(terminal.id);
      openSocket(entry, terminal.id);
    }).catch((e) => failed(entry, e.message || "could not start a terminal"));
  }

  function openSocket(entry, terminalId) {
    try {
      const url = `ws://${location.host}/ws/term?terminal=${encodeURIComponent(terminalId)}`;
      const sock = new WebSocket(url);
      sock.binaryType = "arraybuffer";
      entry.sock = sock;

      sock.onopen = () => {
        if (entry.endRequested) {
          sock.send(JSON.stringify({ t: "close" }));
          sock.close();
          return;
        }
        if (entry.destroyed) return;
        reportStatus(entry, "live");
        doFit(entry);
      };
      sock.onmessage = (ev) => {
        if (entry.destroyed) return;
        if (typeof ev.data === "string") {
          const msg = JSON.parse(ev.data);
          if (msg.t === "ready") {
            entry.terminalId = msg.terminal.id;
            safeCall(() => entry.hooks.onReady && entry.hooks.onReady(entry.id, msg.terminal));
          }
          if (msg.t === "ended") entry.ended = true;
          return;
        }
        const scrollToLatest = entry.scrollOnNextOutput;
        entry.scrollOnNextOutput = false;
        safeCall(() => entry.term.write(new Uint8Array(ev.data), () => {
          if (scrollToLatest && !entry.destroyed) entry.term.scrollToBottom();
        }));
      };
      sock.onclose = () => {
        if (entry.destroyed) return;
        registry.delete(entry.id);
        safeCall(() => entry.term.write(entry.ended
          ? "\r\n[terminal ended]\r\n" : "\r\n[disconnected — click the card to reconnect]\r\n"));
        reportStatus(entry, "closed");
        safeCall(() => entry.ro && entry.ro.disconnect());
        safeCall(() => entry.hooks && entry.hooks.onClose && entry.hooks.onClose(entry.id, !!entry.ended));
      };
      sock.onerror = () => {
        if (entry.destroyed) return;
        reportStatus(entry, "error", "socket error");
      };
    } catch (e) {
      reportStatus(entry, "error", "failed to connect");
    }
  }

  function createEntry(id, session, hooks) {
    const container = document.createElement("div");
    container.className = "fleetterm-container";
    container.style.width = "100%";
    container.style.height = "100%";

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 13.5, lineHeight: 1.25, cursorBlink: true, scrollback: 10000,
      theme: THEME, allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(container); // must only ever happen once per Terminal instance

    const entry = {
      id, term, fit, container, hooks,
      sock: null, ro: null, resizeTimer: null, destroyed: false, terminalId: session.terminalId,
      scrollOnNextOutput: true, scrollOnFit: true,
    };

    term.onData((d) => {
      if (entry.sock && entry.sock.readyState === 1) {
        safeCall(() => entry.sock.send(JSON.stringify({ t: "in", d })));
      }
    });

    registry.set(id, entry);
    reportStatus(entry, "connecting");
    connect(entry, session);
    return entry;
  }

  function attach(entry, hostEl, hooks) {
    if (hooks) entry.hooks = hooks; // hooks may be refreshed across re-renders
    safeCall(() => entry.ro && entry.ro.disconnect());
    hostEl.appendChild(entry.container); // move detached container into new host
    entry.scrollOnFit = true;
    entry.ro = new ResizeObserver(() => scheduleFit(entry));
    safeCall(() => entry.ro.observe(hostEl));
    doFit(entry);
    safeCall(() => entry.term.focus());
  }

  function teardown(entry) {
    entry.destroyed = true;
    if (entry.resizeTimer) { clearTimeout(entry.resizeTimer); entry.resizeTimer = null; }
    safeCall(() => entry.ro && entry.ro.disconnect());
    safeCall(() => entry.sock && entry.sock.close());
    safeCall(() => entry.term.dispose());
    safeCall(() => entry.container.remove());
  }

  const AgentsTerms = {
    open(hostEl, session, hooks) {
      try {
        const id = session && session.id;
        if (!id || !hostEl) return null;

        let entry = registry.get(id);
        if (entry) {
          attach(entry, hostEl, hooks); // re-attach: same Terminal instance, scrollback intact
          return id;
        }

        entry = createEntry(id, session, hooks);
        attach(entry, hostEl, hooks);
        return id;
      } catch (e) {
        return null;
      }
    },

    async close(id, session) {
      const entry = registry.get(id);
      if (entry) entry.endRequested = true;   // a pending create ends it instead
      const terminalId = (entry && entry.terminalId) || (session && session.terminalId);
      if (terminalId) {
        const response = await endTerminal(terminalId);
        if (!response.ok) throw new Error("Could not end terminal");
      }
      if (entry) teardown(entry);
      registry.delete(id);
    },

    closeAll() {
      try {
        for (const id of Array.from(registry.keys())) AgentsTerms.close(id);
      } catch (e) { /* noop */ }
    },

    has(id) {
      try { return registry.has(id); } catch (e) { return false; }
    },

    ids() {
      try { return Array.from(registry.keys()); } catch (e) { return []; }
    },

    refit(id) {
      try {
        const entry = registry.get(id);
        if (entry) doFit(entry);
      } catch (e) { /* noop */ }
    },

    refitAll() {
      try {
        for (const entry of registry.values()) doFit(entry);
      } catch (e) { /* noop */ }
    },

    focus(id) {
      try {
        const entry = registry.get(id);
        if (entry) safeCall(() => entry.term.focus());
      } catch (e) { /* noop */ }
    },
  };

  window.AgentsTerms = AgentsTerms;
})();
