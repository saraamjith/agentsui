// AgentsCanvas — vanilla infinite-canvas engine (pan/zoom/drag/resize) for AgentsUI.
// No deps, no build step. Cards keep their live DOM (xterm instances); we only
// ever touch style.left/top/width/height and layer.style.transform.
(function () {
  'use strict';

  const MIN_K = 0.25;
  const MAX_K = 2.5;
  const MIN_W = 260;
  const MIN_H = 180;
  const PAN_STEP = 60;
  const STORAGE_KEY = 'agentsui.view';
  const INTERACTIVE_SEL =
    'button, a, input, select, textarea, .term-host, .xterm, [contenteditable="true"]';

  let stage = null;
  let layer = null;
  let onPlace = null;
  let state = { x: 0, y: 0, k: 1 };
  const listeners = [];

  let applyQueued = false;
  let gesture = null; // active pan/drag/resize, or null

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function isInteractive(el) {
    return !!(el && el.closest && el.closest(INTERACTIVE_SEL));
  }

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.x === 'number' && typeof p.y === 'number' && typeof p.k === 'number') {
        state = { x: p.x, y: p.y, k: clamp(p.k, MIN_K, MAX_K) };
      }
    } catch (_) { /* privacy mode / corrupt storage — ignore, keep defaults */ }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) { /* quota / privacy mode — non-fatal */ }
  }

  function paint() {
    layer.style.transform = `translate(${state.x}px,${state.y}px) scale(${state.k})`;
  }

  function scheduleApply() {
    if (applyQueued) return;
    applyQueued = true;
    requestAnimationFrame(() => {
      applyQueued = false;
      paint();
    });
  }

  function notify() {
    const snap = transform();
    listeners.forEach((fn) => fn(snap));
  }

  function setTransform(x, y, k) {
    state = { x, y, k: clamp(k, MIN_K, MAX_K) };
    scheduleApply();
    persist();
    notify();
  }

  function transform() {
    return { x: state.x, y: state.y, k: state.k };
  }

  function zoomAbout(clientX, clientY, newK) {
    const rect = stage.getBoundingClientRect();
    // keep the layer point under the cursor fixed while k changes
    const lx = (clientX - rect.left - state.x) / state.k;
    const ly = (clientY - rect.top - state.y) / state.k;
    const x = clientX - rect.left - lx * newK;
    const y = clientY - rect.top - ly * newK;
    setTransform(x, y, newK);
  }

  function zoomBy(factor, clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    const cx = clientX !== undefined ? clientX : rect.left + rect.width / 2;
    const cy = clientY !== undefined ? clientY : rect.top + rect.height / 2;
    zoomAbout(cx, cy, clamp(state.k * factor, MIN_K, MAX_K));
  }

  function zoomTo(k) {
    const rect = stage.getBoundingClientRect();
    zoomAbout(rect.left + rect.width / 2, rect.top + rect.height / 2, clamp(k, MIN_K, MAX_K));
  }

  function fit(padding) {
    const pad = padding === undefined ? 60 : padding;
    const cards = layer.querySelectorAll('.card');
    if (!cards.length) return setTransform(0, 0, 1);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // Cards sit in normal flow inside lanes, so measure where they actually
    // are and undo the current scale to get layer coordinates.
    const lr = layer.getBoundingClientRect();
    cards.forEach((c) => {
      const r = c.getBoundingClientRect();
      const l = (r.left - lr.left) / state.k;
      const t = (r.top - lr.top) / state.k;
      const w = r.width / state.k;
      const h = r.height / state.k;
      minX = Math.min(minX, l);
      minY = Math.min(minY, t);
      maxX = Math.max(maxX, l + w);
      maxY = Math.max(maxY, t + h);
    });
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const rect = stage.getBoundingClientRect();
    const availW = Math.max(1, rect.width - 2 * pad);
    const availH = Math.max(1, rect.height - 2 * pad);
    const k = clamp(Math.min(availW / bw, availH / bh), MIN_K, MAX_K);
    const cx = minX + bw / 2;
    const cy = minY + bh / 2;
    setTransform(rect.width / 2 - cx * k, rect.height / 2 - cy * k, k);
  }

  function reset() {
    setTransform(0, 0, 1);
  }

  function screenToLayer(clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    return {
      x: (clientX - rect.left - state.x) / state.k,
      y: (clientY - rect.top - state.y) / state.k,
    };
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  // --- pointer-driven pan / drag / resize -----------------------------------

  function onPointerDown(e) {
    if (gesture) return; // one active gesture at a time
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 0 && isInteractive(e.target)) return;

    let type = null;
    let card = null;
    if (e.button === 1) {
      type = 'pan';
    } else {
      const grip = e.target.closest('[data-grip]');
      const handle = e.target.closest('[data-drag]');
      if (grip) {
        card = grip.closest('.card');
        if (card) type = 'resize';
      } else if (handle) {
        card = handle.closest('.card');
        if (card) type = 'drag';
      } else if (!e.target.closest('.card')) {
        type = 'pan'; // background of stage/layer
      }
    }
    if (!type) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    gesture = {
      type, card, pointerId: e.pointerId,
      startClientX: e.clientX, startClientY: e.clientY,
      startK: state.k,
    };
    if (type === 'pan') {
      gesture.startX = state.x;
      gesture.startY = state.y;
      stage.classList.add('panning');
    } else {
      gesture.startLeft = parseFloat(card.style.left) || 0;
      gesture.startTop = parseFloat(card.style.top) || 0;
      gesture.startW = parseFloat(card.style.width) || card.offsetWidth;
      gesture.startH = parseFloat(card.style.height) || card.offsetHeight;
      card.classList.add('dragging');
    }
  }

  function onPointerMove(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const dxScreen = e.clientX - gesture.startClientX;
    const dyScreen = e.clientY - gesture.startClientY;
    if (gesture.type === 'pan') {
      // pan offsets live in screen space, so no scale division here
      setTransform(gesture.startX + dxScreen, gesture.startY + dyScreen, state.k);
      return;
    }
    // card geometry is in layer space, so screen deltas must be unscaled by k
    const dx = dxScreen / gesture.startK;
    const dy = dyScreen / gesture.startK;
    if (gesture.type === 'drag') {
      gesture.card.style.left = gesture.startLeft + dx + 'px';
      gesture.card.style.top = gesture.startTop + dy + 'px';
    } else if (gesture.type === 'resize') {
      gesture.card.style.width = Math.max(MIN_W, gesture.startW + dx) + 'px';
      gesture.card.style.height = Math.max(MIN_H, gesture.startH + dy) + 'px';
    }
  }

  function onPointerUp(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const g = gesture;
    gesture = null;
    try { stage.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    if (g.type === 'pan') {
      stage.classList.remove('panning');
      return;
    }
    g.card.classList.remove('dragging');
    if (typeof onPlace === 'function') {
      onPlace(g.card.dataset.id, {
        x: Math.round(parseFloat(g.card.style.left) || 0),
        y: Math.round(parseFloat(g.card.style.top) || 0),
        w: Math.round(parseFloat(g.card.style.width) || 0),
        h: Math.round(parseFloat(g.card.style.height) || 0),
      });
    }
  }

  // --- wheel: plain = pan, ctrl/cmd = zoom about cursor ---------------------

  function onWheel(e) {
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) { // line mode
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) { // page mode
      const rect = stage.getBoundingClientRect();
      dx *= rect.width;
      dy *= rect.height;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault(); // also stops the browser pinch-zoom gesture
      zoomBy(Math.exp(-dy * 0.01), e.clientX, e.clientY);
    } else {
      e.preventDefault();
      setTransform(state.x - dx, state.y - dy, state.k);
    }
  }

  // --- keyboard, only while the stage itself has focus ----------------------

  function onKeyDown(e) {
    if (isInteractive(e.target)) return;
    switch (e.key) {
      case 'ArrowUp': setTransform(state.x, state.y + PAN_STEP, state.k); break;
      case 'ArrowDown': setTransform(state.x, state.y - PAN_STEP, state.k); break;
      case 'ArrowLeft': setTransform(state.x + PAN_STEP, state.y, state.k); break;
      case 'ArrowRight': setTransform(state.x - PAN_STEP, state.y, state.k); break;
      case '0': zoomTo(1); break;
      case '+': case '=': zoomBy(1.2); break;
      case '-': case '_': zoomBy(1 / 1.2); break;
      default: return;
    }
    e.preventDefault();
  }

  function init(opts) {
    stage = opts.stage;
    layer = opts.layer;
    onPlace = opts.onPlace;

    loadPersisted();
    paint(); // apply immediately, no first-frame flash
    layer.style.transformOrigin = '0 0';
    if (!stage.hasAttribute('tabindex')) stage.tabIndex = 0;

    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', onPointerUp);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('keydown', onKeyDown);
  }

  window.AgentsCanvas = {
    init,
    transform,
    setTransform,
    zoomBy,
    zoomTo,
    fit,
    reset,
    screenToLayer,
    onChange,
  };
})();
