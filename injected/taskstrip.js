// AI IDE task strip: draws task tabs in the VS Code title bar.
//
// Loaded by a <script> tag that scripts/install.ps1 adds to workbench.html of the portable copy.
// It holds no state of its own: the AI IDE extension publishes tasks as status bar items whose
// aria-labels carry the data (see extension/src/taskStrip.ts); this script mirrors them as tabs
// and forwards clicks to them. If anything here breaks, those status bar items still work.
//
// Note: the workbench enforces Trusted Types, so DOM is built with createElement/textContent only.
(function () {
  'use strict';

  const STRIP_ID = 'aiide-taskstrip';
  const BODY_CLASS = 'aiide-strip-on';
  const LABEL_SELECTOR = '.statusbar-item-label[aria-label^="aiide:"]';

  function readItems() {
    const tasks = [];
    let newTask = null;
    let move = null;
    let mode = null;
    for (const label of document.querySelectorAll(LABEL_SELECTOR)) {
      const parts = label.getAttribute('aria-label').split(':');
      if (parts[1] === 'task') {
        tasks.push({
          id: parts[2],
          state: parts[3],
          active: parts[4] === '1',
          index: Number(parts[5]),
          name: decodeURIComponent(parts.slice(6).join(':')),
          title: label.closest('.statusbar-item')?.getAttribute('title') || label.getAttribute('title') || '',
          target: label,
        });
      } else if (parts[1] === 'new') {
        newTask = label;
      } else if (parts[1] === 'move') {
        move = label;
      } else if (parts[1] === 'mode') {
        mode = parts[2];
      }
    }
    tasks.sort((a, b) => a.index - b.index);
    return { tasks, newTask, move, mode };
  }

  function icon(state) {
    const span = document.createElement('span');
    span.className = 'aiide-icon';
    switch (state) {
      case 'thinking':
        span.textContent = '✳'; // ✳, like Claude Code's own spinner
        span.classList.add('aiide-thinking');
        break;
      case 'waiting':
        span.className += ' codicon codicon-bell-dot aiide-waiting';
        break;
      case 'done':
        span.textContent = '●'; // ●
        span.classList.add('aiide-done');
        break;
      case 'stopped':
        span.className += ' codicon codicon-circle-slash aiide-stopped';
        break;
      default:
        span.textContent = '–'; // –  nothing happening
        span.classList.add('aiide-idle');
    }
    return span;
  }

  const STATE_TEXT = {
    thinking: 'AI is working',
    waiting: 'needs your input',
    done: 'finished',
    idle: 'idle',
    stopped: 'not running',
  };

  let lastSignature = '';
  /** Set while a tab is being dragged; re-rendering is postponed until the drop. */
  let drag = null;
  const DRAG_THRESHOLD = 5;

  function render() {
    if (drag) return;
    // Right after the menu bar, left-aligned (the title bar centre would centre it).
    const host = document.querySelector('.part.titlebar .titlebar-left');
    const items = readItems();
    const { tasks, newTask, mode } = items;
    const enabled = mode === 'agent' && host;
    let strip = document.getElementById(STRIP_ID);

    if (!enabled) {
      strip?.remove();
      document.body.classList.remove(BODY_CLASS);
      lastSignature = '';
      return;
    }
    if (!strip || strip.parentElement !== host) {
      strip?.remove();
      strip = document.createElement('div');
      strip.id = STRIP_ID;
      host.append(strip);
      lastSignature = '';
    }
    document.body.classList.add(BODY_CLASS);

    const signature = JSON.stringify(tasks.map((t) => [t.id, t.state, t.active, t.name, t.title]));
    if (signature === lastSignature) {
      return;
    }
    lastSignature = signature;

    strip.replaceChildren();
    tasks.forEach((task, index) => {
      const tab = document.createElement('div');
      tab.className = 'aiide-tab' + (task.active ? ' aiide-active' : '');
      tab.dataset.state = task.state;
      tab.dataset.id = task.id;
      tab.title = `${task.name} — ${STATE_TEXT[task.state] || task.state}${index < 9 ? `  (Ctrl+Alt+${index + 1})` : ''}`;
      const name = document.createElement('span');
      name.className = 'aiide-name';
      name.textContent = task.name;
      tab.append(name, icon(task.state));
      tab.addEventListener('pointerdown', (e) => onPointerDown(e, tab, task));
      strip.append(tab);
    });

    const add = document.createElement('div');
    add.className = 'aiide-add codicon codicon-add';
    add.title = 'New task (Ctrl+Alt+N)';
    add.addEventListener('click', () => newTask?.click());
    strip.append(add);
  }

  // --- click and drag-to-reorder -------------------------------------------------------------
  // A press without movement is a click (activate the task). Moving past the threshold starts a
  // drag; dropping on another tab asks the extension to move the task there: "move" item, then
  // the dragged task, then the target (see extension/src/extension.ts, aiIde.armMove).

  function onPointerDown(e, tab, task) {
    if (e.button !== 0) return;
    e.preventDefault();
    tab.setPointerCapture(e.pointerId);
    const state = { tab, task, startX: e.clientX, dragging: false, target: null, after: false };

    const onMove = (ev) => {
      if (!state.dragging) {
        if (Math.abs(ev.clientX - state.startX) < DRAG_THRESHOLD) return;
        state.dragging = true;
        drag = state;
        tab.classList.add('aiide-dragging');
      }
      updateDropTarget(state, ev.clientX);
    };
    const onUp = (ev) => {
      tab.removeEventListener('pointermove', onMove);
      tab.removeEventListener('pointerup', onUp);
      tab.removeEventListener('pointercancel', onCancel);
      if (!state.dragging) {
        task.target.click();
        return;
      }
      finishDrag(state, ev.type === 'pointerup');
    };
    const onCancel = (ev) => onUp(ev);
    tab.addEventListener('pointermove', onMove);
    tab.addEventListener('pointerup', onUp);
    tab.addEventListener('pointercancel', onCancel);
  }

  function updateDropTarget(state, x) {
    const tabs = [...document.querySelectorAll(`#${STRIP_ID} .aiide-tab`)];
    for (const t of tabs) t.classList.remove('aiide-drop-before', 'aiide-drop-after');
    // The tab under the pointer, or the nearest one when past either end of the strip.
    let target = tabs.find((t) => {
      const r = t.getBoundingClientRect();
      return x >= r.left && x <= r.right;
    });
    if (!target && tabs.length) {
      target = x < tabs[0].getBoundingClientRect().left ? tabs[0] : tabs[tabs.length - 1];
    }
    state.target = target && target !== state.tab ? target : null;
    if (state.target) {
      const after = tabs.indexOf(state.target) > tabs.indexOf(state.tab);
      state.target.classList.add(after ? 'aiide-drop-after' : 'aiide-drop-before');
    }
  }

  function finishDrag(state, drop) {
    for (const t of document.querySelectorAll(`#${STRIP_ID} .aiide-tab`)) {
      t.classList.remove('aiide-dragging', 'aiide-drop-before', 'aiide-drop-after');
    }
    drag = null;
    const { move, tasks } = readItems();
    const target = state.target && tasks.find((t) => t.id === state.target.dataset.id);
    if (drop && move && target) {
      // Each click becomes a command sent to the extension; back-to-back clicks can arrive out of
      // order, so space them out a little.
      const clicks = [move, state.task.target, target.target];
      clicks.forEach((el, i) => setTimeout(() => el.click(), i * 80));
    }
    lastSignature = '';
    schedule();
  }

  function injectStyle() {
    if (document.getElementById('aiide-taskstrip-style')) return;
    const style = document.createElement('style');
    style.id = 'aiide-taskstrip-style';
    style.textContent = `
      body.${BODY_CLASS} .part.titlebar .titlebar-center .window-title { display: none !important; }
      body.${BODY_CLASS} .part.titlebar .titlebar-left { min-width: 0; }
      body.${BODY_CLASS} .part.titlebar .titlebar-left > .menubar { flex-shrink: 0; }
      body.${BODY_CLASS} .statusbar-item:has(> .statusbar-item-label[aria-label^="aiide:task:"]),
      body.${BODY_CLASS} .statusbar-item:has(> .statusbar-item-label[aria-label="aiide:new"]),
      body.${BODY_CLASS} .statusbar-item:has(> .statusbar-item-label[aria-label="aiide:move"]) { display: none !important; }

      /* The title bar is a window-drag region: like VS Code's own title bar controls, the strip
         must be raised above it and opted out, or Windows takes the clicks as window drags. */
      #${STRIP_ID} {
        order: 3; flex: 0 1 auto; margin-left: 8px;
        display: flex; align-items: stretch; height: 100%; gap: 2px; min-width: 0;
        overflow-x: auto; scrollbar-width: none;
        position: relative; z-index: 2500; -webkit-app-region: no-drag;
      }
      #${STRIP_ID} * { -webkit-app-region: no-drag; }
      #${STRIP_ID}::-webkit-scrollbar { display: none; }
      #${STRIP_ID} .aiide-tab {
        display: flex; align-items: center; gap: 8px; padding: 0 12px; cursor: pointer; white-space: nowrap;
        font-size: 12px; color: var(--vscode-titleBar-inactiveForeground);
        border-left: 1px solid var(--vscode-titleBar-border, rgba(128,128,128,.25));
        border-bottom: 2px solid transparent; box-sizing: border-box; touch-action: none;
      }
      #${STRIP_ID} .aiide-tab > * { pointer-events: none; }
      #${STRIP_ID} .aiide-tab.aiide-dragging { opacity: .45; cursor: grabbing; }
      #${STRIP_ID} .aiide-tab.aiide-drop-before { box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
      #${STRIP_ID} .aiide-tab.aiide-drop-after { box-shadow: inset -2px 0 0 var(--vscode-focusBorder); }
      #${STRIP_ID} .aiide-tab:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-titleBar-activeForeground); }
      #${STRIP_ID} .aiide-tab.aiide-active {
        color: var(--vscode-titleBar-activeForeground);
        background: var(--vscode-tab-activeBackground, rgba(128,128,128,.15));
        border-bottom-color: var(--vscode-focusBorder);
        font-weight: 600;
      }
      #${STRIP_ID} .aiide-icon { font-size: 13px; line-height: 1; width: 14px; text-align: center; }
      #${STRIP_ID} .aiide-thinking { color: var(--vscode-charts-orange, #d97757); display: inline-block; animation: aiide-spin 1.6s linear infinite; }
      #${STRIP_ID} .aiide-waiting { color: var(--vscode-charts-orange, #e5a50a); animation: aiide-pulse 1s ease-in-out infinite alternate; }
      #${STRIP_ID} .aiide-done { color: var(--vscode-charts-green, #3fb950); font-size: 10px; }
      #${STRIP_ID} .aiide-idle { opacity: .45; }
      #${STRIP_ID} .aiide-stopped { opacity: .45; font-size: 12px; }
      #${STRIP_ID} .aiide-add {
        display: flex; align-items: center; padding: 0 10px; cursor: pointer; opacity: .7;
        border-left: 1px solid var(--vscode-titleBar-border, rgba(128,128,128,.25));
      }
      #${STRIP_ID} .aiide-add:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
      @keyframes aiide-spin { to { transform: rotate(360deg); } }
      @keyframes aiide-pulse { from { opacity: .5; } to { opacity: 1; } }
    `;
    document.head.append(style);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        render();
      } catch (err) {
        console.error('[aiide] task strip render failed', err);
      }
    });
  }

  function start() {
    const statusbar = document.querySelector('.part.statusbar');
    const titlebar = document.querySelector('.part.titlebar');
    if (!statusbar || !titlebar) {
      setTimeout(start, 300);
      return;
    }
    injectStyle();
    new MutationObserver(schedule).observe(statusbar, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-label', 'title', 'class', 'style'],
    });
    new MutationObserver((mutations) => {
      if (mutations.some((m) => !document.getElementById(STRIP_ID)?.contains(m.target))) schedule();
    }).observe(titlebar, { subtree: true, childList: true });
    // Safety net for re-renders the observers do not see (e.g. the title bar being rebuilt).
    setInterval(schedule, 2000);
    schedule();
    console.log('[aiide] task strip loaded');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
