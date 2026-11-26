// Margin panel webview: draws a box per comment thread beside its line, stacks
// boxes that would overlap, and sends every action to the extension.
// @ts-check
(function () {
  // @ts-ignore acquireVsCodeApi is provided by VS Code.
  const vscode = acquireVsCodeApi();

  const lane = /** @type {HTMLElement} */ (document.getElementById('lane'));
  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (document.getElementById('connectors')));
  const header = /** @type {HTMLElement} */ (document.getElementById('header'));
  const above = /** @type {HTMLButtonElement} */ (document.getElementById('above'));
  const below = /** @type {HTMLButtonElement} */ (document.getElementById('below'));
  const orphans = /** @type {HTMLElement} */ (document.getElementById('orphans'));
  const empty = /** @type {HTMLElement} */ (document.getElementById('empty'));

  const GAP = 6;

  /** @type {any} */
  let state = undefined;
  /** Box elements by thread id, with the content signature they were built from. */
  /** @type {Map<string, {el: HTMLElement, sig: string}>} */
  const boxes = new Map();
  // VS Code throws a hidden webview's page away: unsent text is kept in its
  // state, which survives that, and restored here.
  const saved = vscode.getState() || {};
  /** Reply drafts by thread id, kept across rebuilds. */
  /** @type {Map<string, string>} */
  const replyDrafts = new Map(Array.isArray(saved.replyDrafts) ? saved.replyDrafts : []);
  /** Comments being edited: comment id -> draft text. */
  /** @type {Map<string, string>} */
  const editing = new Map(Array.isArray(saved.editing) ? saved.editing : []);
  /** @type {string | undefined} */
  let activeId = undefined;

  function saveDrafts() {
    vscode.setState({ replyDrafts: [...replyDrafts], editing: [...editing] });
  }

  function post(message) {
    vscode.postMessage(message);
    saveDrafts();
  }

  // Report script errors to the extension, where tests can see them.
  window.addEventListener('error', (e) => post({ type: 'error', message: String(e.message) }));

  /**
   * @param {string} tag
   * @param {Record<string, string>} [attrs]
   * @param {(Node | string)[]} [children]
   */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      el.setAttribute(k, v);
    }
    for (const c of children || []) {
      el.append(c);
    }
    return el;
  }

  function signature(t) {
    return JSON.stringify([t.status, t.category, t.colour, t.categoryLabel, t.orphaned, t.startLine, t.endLine, t.snippet, t.comments, state.categories]);
  }

  function lineLabel(t) {
    return t.startLine === t.endLine ? `L${t.startLine + 1}` : `L${t.startLine + 1}–${t.endLine + 1}`;
  }

  function buildBox(t) {
    const box = h('div', { class: 'box', tabindex: '0', 'data-id': t.id, role: 'button', 'aria-label': `Comment on ${lineLabel(t)}` });
    box.style.setProperty('--cat', t.colour);
    box.classList.toggle('resolved', t.status === 'resolved');
    box.classList.toggle('orphaned', t.orphaned);

    const select = /** @type {HTMLSelectElement} */ (h('select', { class: 'cat', title: 'Category', 'data-id': t.id }));
    const known = state.categories.some((c) => c.id === t.category);
    for (const c of known ? state.categories : [{ id: t.category, label: t.categoryLabel }, ...state.categories]) {
      const opt = /** @type {HTMLOptionElement} */ (h('option', { value: c.id }, [c.label]));
      opt.selected = c.id === t.category;
      select.append(opt);
    }

    const resolve =
      t.status === 'open'
        ? h('button', { 'data-act': 'resolve', title: 'Resolve' }, ['✓'])
        : h('button', { 'data-act': 'reopen', title: 'Reopen' }, ['↺']);
    const tools = h('span', { class: 'tools' }, [
      ...(t.orphaned ? [h('button', { 'data-act': 'reattach', title: 'Reattach to the selection in the editor' }, ['⚓'])] : []),
      resolve,
      h('button', { 'data-act': 'deleteThread', title: 'Delete thread' }, ['🗑']),
    ]);
    const head = h('div', { class: 'head' }, [
      h('span', { class: 'line', title: t.orphaned ? 'Last known line' : 'Line' }, [lineLabel(t)]),
      select,
      ...(t.status === 'resolved' ? [h('span', { class: 'status' }, ['resolved'])] : []),
      tools,
    ]);
    box.append(h('div', { class: 'strip' }), head);

    if (t.orphaned) {
      box.append(h('div', { class: 'warning' }, ['Code not found — reattach?']));
      box.append(h('pre', { class: 'snippet' }, [t.snippet || '(blank line)']));
    }

    const list = h('div', { class: 'comments' });
    for (const c of t.comments) {
      const meta = h('div', { class: 'meta' }, [
        h('span', { class: 'when' }, [c.edited ? `${c.created} (edited)` : c.created]),
        h('span', { class: 'tools' }, [
          h('button', { 'data-act': 'edit', 'data-cid': c.id, title: 'Edit' }, ['✎']),
          h('button', { 'data-act': 'deleteComment', 'data-cid': c.id, title: 'Delete comment' }, ['✕']),
        ]),
      ]);
      const item = h('div', { class: 'comment', 'data-cid': c.id }, [meta]);
      if (editing.has(c.id)) {
        const area = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'edit', 'data-cid': c.id, rows: '3' }));
        area.value = /** @type {string} */ (editing.get(c.id));
        item.append(
          area,
          h('div', { class: 'actions' }, [
            h('button', { 'data-act': 'cancelEdit', 'data-cid': c.id }, ['Cancel']),
            h('button', { 'data-act': 'saveEdit', 'data-cid': c.id, class: 'primary' }, ['Save']),
          ]),
        );
      } else {
        item.append(h('div', { class: 'body' }, [c.body]));
      }
      list.append(item);
    }
    box.append(list);

    const reply = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'reply', placeholder: 'Reply… (Ctrl+Enter)', rows: '1', 'data-id': t.id }));
    reply.value = replyDrafts.get(t.id) || '';
    box.append(h('div', { class: 'replybar' }, [reply, h('button', { 'data-act': 'reply', class: 'primary' }, ['Reply'])]));
    box.classList.toggle('active', t.id === activeId);
    return box;
  }

  function render() {
    if (!state) {
      return;
    }
    document.documentElement.style.setProperty('--line-height', `${state.lineHeight}px`);
    header.textContent = state.file;
    header.style.height = `${state.topOffset}px`;
    activeId = state.activeId;

    const seen = new Set();
    for (const t of state.threads) {
      seen.add(t.id);
      const sig = signature(t);
      const existing = boxes.get(t.id);
      if (existing && existing.sig === sig) {
        continue;
      }
      const focused = existing && existing.el.contains(document.activeElement) ? document.activeElement : null;
      const focusSelector = focused instanceof HTMLTextAreaElement ? `textarea.${focused.className}` : null;
      const el = buildBox(t);
      if (existing) {
        resizer.unobserve(existing.el);
        existing.el.replaceWith(el);
      }
      boxes.set(t.id, { el, sig });
      if (focusSelector) {
        const again = el.querySelector(focusSelector);
        if (again instanceof HTMLTextAreaElement) {
          again.focus();
        }
      }
      resizer.observe(el);
    }
    for (const [id, b] of boxes) {
      if (!seen.has(id)) {
        resizer.unobserve(b.el);
        b.el.remove();
        boxes.delete(id);
        replyDrafts.delete(id);
      }
    }
    layout();
  }

  /** Places the boxes: each at its line, pushed down below the one before when they would overlap. */
  function layout() {
    if (!state) {
      return;
    }
    const visible = state.threads
      .filter((t) => !t.orphaned && t.placement.where === 'visible')
      .sort((a, b) => a.placement.row - b.placement.row || a.startLine - b.startLine);
    const lh = state.lineHeight;
    let bottom = 0;
    const links = [];
    for (const t of visible) {
      const el = boxes.get(t.id).el;
      if (el.parentElement !== lane) {
        lane.append(el);
      }
      el.hidden = false;
      const want = state.topOffset + t.placement.row * lh;
      const top = Math.max(want, bottom === 0 ? 0 : bottom + GAP);
      el.style.top = `${top}px`;
      bottom = top + el.offsetHeight;
      links.push({ from: want + lh / 2, to: top + Math.min(12, el.offsetHeight / 2), colour: t.colour });
    }
    const hiddenAbove = state.threads.filter((t) => !t.orphaned && t.placement.where === 'above');
    const hiddenBelow = state.threads.filter((t) => !t.orphaned && t.placement.where === 'below');
    for (const t of [...hiddenAbove, ...hiddenBelow]) {
      const el = boxes.get(t.id).el;
      el.hidden = true;
    }
    const orphaned = state.threads.filter((t) => t.orphaned);
    orphans.replaceChildren();
    if (orphaned.length > 0) {
      orphans.append(h('h2', {}, [`Orphaned (${orphaned.length})`]));
      for (const t of orphaned) {
        const el = boxes.get(t.id).el;
        el.hidden = false;
        el.style.top = '';
        orphans.append(el);
      }
    }
    lane.style.height = `${Math.max(window.innerHeight, bottom + GAP)}px`;

    svg.setAttribute('height', String(Math.max(window.innerHeight, bottom + GAP)));
    svg.replaceChildren(
      ...links.map((l) => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M0 ${l.from} H4 L10 ${l.to} H14`);
        path.setAttribute('stroke', l.colour);
        return path;
      }),
    );

    above.hidden = hiddenAbove.length === 0;
    above.textContent = `↑ ${hiddenAbove.length} more`;
    const belowCount = hiddenBelow.length;
    below.hidden = belowCount === 0 && orphaned.length === 0;
    below.textContent =
      belowCount > 0
        ? `↓ ${belowCount} more${orphaned.length ? ` · ⚠ ${orphaned.length} orphaned` : ''}`
        : `⚠ ${orphaned.length} orphaned`;
    empty.hidden = state.threads.length > 0;
  }

  const resizer = new ResizeObserver(() => layout());

  function setActive(id, scroll) {
    activeId = id;
    for (const [tid, b] of boxes) {
      b.el.classList.toggle('active', tid === id);
    }
    if (id && scroll) {
      const b = boxes.get(id);
      if (b && !b.el.hidden) {
        b.el.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function threadOf(el) {
    const box = el.closest('.box');
    return box ? box.getAttribute('data-id') : null;
  }

  function act(button) {
    const action = button.getAttribute('data-act');
    const threadId = threadOf(button);
    const commentId = button.getAttribute('data-cid');
    switch (action) {
      case 'resolve':
        post({ type: 'setStatus', threadId, status: 'resolved' });
        break;
      case 'reopen':
        post({ type: 'setStatus', threadId, status: 'open' });
        break;
      case 'deleteThread':
        post({ type: 'deleteThread', threadId });
        break;
      case 'reattach':
        post({ type: 'reattach', threadId });
        break;
      case 'deleteComment':
        post({ type: 'deleteComment', commentId });
        break;
      case 'edit': {
        const t = state.threads.find((x) => x.id === threadId);
        const c = t && t.comments.find((x) => x.id === commentId);
        if (c) {
          editing.set(commentId, c.body);
          rebuild(threadId);
          const area = boxes.get(threadId).el.querySelector(`textarea.edit[data-cid="${commentId}"]`);
          if (area instanceof HTMLTextAreaElement) {
            area.focus();
          }
        }
        break;
      }
      case 'cancelEdit':
        editing.delete(commentId);
        rebuild(threadId);
        break;
      case 'saveEdit': {
        const body = editing.get(commentId);
        editing.delete(commentId);
        if (body && body.trim()) {
          post({ type: 'edit', commentId, body });
        }
        rebuild(threadId);
        break;
      }
      case 'reply':
        submitReply(threadId);
        break;
    }
  }

  function rebuild(threadId) {
    const b = boxes.get(threadId);
    if (b) {
      b.sig = '';
    }
    saveDrafts();
    render();
  }

  function submitReply(threadId) {
    const body = (replyDrafts.get(threadId) || '').trim();
    if (!body) {
      return;
    }
    replyDrafts.delete(threadId);
    post({ type: 'reply', threadId, body });
  }

  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const button = target.closest('[data-act]');
    if (button) {
      // Actions never trigger a jump.
      e.stopPropagation();
      act(button);
      return;
    }
    if (target.closest('textarea, select, input, button, a')) {
      return;
    }
    const id = threadOf(target);
    if (id) {
      setActive(id, false);
      post({ type: 'reveal', threadId: id });
    }
  });

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.classList.contains('box') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const id = target.getAttribute('data-id');
      setActive(id, false);
      post({ type: 'reveal', threadId: id });
      return;
    }
    if (target instanceof HTMLTextAreaElement && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (target.classList.contains('reply')) {
        submitReply(threadOf(target));
      } else if (target.classList.contains('edit')) {
        const saveButton = target.parentElement && target.parentElement.querySelector('[data-act="saveEdit"]');
        if (saveButton) {
          act(saveButton);
        }
      }
    }
    if (target instanceof HTMLTextAreaElement && e.key === 'Escape' && target.classList.contains('edit')) {
      const cancelButton = target.parentElement && target.parentElement.querySelector('[data-act="cancelEdit"]');
      if (cancelButton) {
        act(cancelButton);
      }
    }
  });

  document.addEventListener('input', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLTextAreaElement)) {
      return;
    }
    if (target.classList.contains('reply')) {
      replyDrafts.set(/** @type {string} */ (target.getAttribute('data-id')), target.value);
    } else if (target.classList.contains('edit')) {
      editing.set(/** @type {string} */ (target.getAttribute('data-cid')), target.value);
    }
    saveDrafts();
  });

  document.addEventListener('change', (e) => {
    const target = e.target;
    if (target instanceof HTMLSelectElement && target.classList.contains('cat')) {
      post({ type: 'setCategory', threadId: target.getAttribute('data-id'), category: target.value });
    }
  });

  above.addEventListener('click', () => post({ type: 'scrollTo', direction: 'up' }));
  below.addEventListener('click', () => {
    if (state && state.threads.some((t) => !t.orphaned && t.placement.where === 'below')) {
      post({ type: 'scrollTo', direction: 'down' });
    } else {
      orphans.scrollIntoView({ block: 'start' });
    }
  });

  window.addEventListener('resize', () => layout());

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'render') {
      state = m;
      render();
      post({ type: 'rendered', boxes: lane.querySelectorAll('.box:not([hidden])').length, orphans: orphans.querySelectorAll('.box').length });
    } else if (m.type === 'active') {
      setActive(m.threadId, true);
    }
  });

  post({ type: 'ready' });
})();
