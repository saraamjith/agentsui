// AgentsTerms — multi-terminal manager for AgentsUI.
// Keeps each xterm instance alive in a detached container so a 3s poll
// re-render (which destroys/recreates .term-host) never kills a live pty
// session or its scrollback. Plain ES2019, no build step.
(function () {
  "use strict";

  const MAX_TERMS = 6;
  const RESIZE_DEBOUNCE_MS = 100;

  const THEME = {
      background: "#000000", foreground: "#F2F2F5", cursor: "#CAFFBF", cursorAccent: "#000000",
      selectionBackground: "#2A2A33",
      black: "#1A1A1F", red: "#FFADAD", green: "#CAFFBF", yellow: "#FDFFB6",
      blue: "#A0C4FF", magenta: "#FFC6FF", cyan: "#9BF6FF", white: "#E6E6EE",
      brightBlack: "#80808E", brightRed: "#FFC2C2", brightGreen: "#DBFFD3", brightYellow: "#FEFFCB",
      brightBlue: "#BAD4FF", brightMagenta: "#FFD6FF", brightCyan: "#BDF9FF", brightWhite: "#FFFFFF",
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

  function connect(entry, session) {
    try {
      const url = session.newIn
        ? `ws://${location.host}/ws/term?cwd=${encodeURIComponent(session.newIn)}&agent=${encodeURIComponent(session.agent || "claude")}`
        : `ws://${location.host}/ws/term?file=${encodeURIComponent(session.file)}`;
      const sock = new WebSocket(url);
      sock.binaryType = "arraybuffer";
      entry.sock = sock;

      sock.onopen = () => {
        if (entry.destroyed) return;
        reportStatus(entry, "live");
        doFit(entry);
      };
      sock.onmessage = (ev) => {
        if (entry.destroyed) return;
        safeCall(() => entry.term.write(new Uint8Array(ev.data)));
      };
      sock.onclose = () => {
        if (entry.destroyed) return;
        safeCall(() => entry.term.write("\r\n\x1b[2m[terminal ended]\x1b[0m\r\n"));
        reportStatus(entry, "closed");
        safeCall(() => entry.hooks && entry.hooks.onClose && entry.hooks.onClose(entry.id));
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
      sock: null, ro: null, resizeTimer: null, destroyed: false,
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

        if (registry.size >= MAX_TERMS) {
          safeCall(() => hooks && hooks.onStatus && hooks.onStatus(id, "error", "too many terminals open (6)"));
          return null;
        }

        entry = createEntry(id, session, hooks);
        attach(entry, hostEl, hooks);
        return id;
      } catch (e) {
        return null;
      }
    },

    close(id) {
      try {
        const entry = registry.get(id);
        if (!entry) return;
        teardown(entry);
        registry.delete(id);
      } catch (e) { /* idempotent, swallow */ }
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
