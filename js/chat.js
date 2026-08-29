// Per-project chat dock: structured edit proposals.

import { renderMarkdown } from './markdown.js';

export function createChat(ctx) {
  const {
    el,
    state,
    store,
    warn,
    requestRender,
    createLink,
    LINK_TYPES
  } = ctx;

  const dock = el('chatDock');
  const btn = el('btnChat');
  const statusEl = el('chatStatus');
  const tokenRing = el('chatTokenRing');
  const tokenArc = el('chatTokenArc');
  const tokenPct = el('chatTokenPct');
  const messagesEl = el('chatMessages');
  const input = el('chatInput');
  const sendBtn = el('chatSend');
  const clearBtn = el('chatClear');
  const closeBtn = el('chatClose');

  let pendingOps = null;
  let busy = false;
  let contextTimer = 0;
  let sendAbort = null;

  function projectName() {
    return store.name || '';
  }

  function setTokenUsage(usage) {
    if (!tokenRing || !usage || !usage.max) {
      if (tokenRing) tokenRing.hidden = true;
      return;
    }
    const used = Math.max(0, usage.used || 0);
    const max = usage.max;
    const pct = Math.max(0, Math.min(100, usage.pct != null ? usage.pct : Math.round(100 * used / max)));
    tokenRing.hidden = false;
    tokenRing.classList.toggle('warn', pct >= 85);
    tokenRing.title = used + ' / ' + max + ' context tokens (' + pct + '%)';
    if (tokenPct) tokenPct.textContent = pct + '%';
    if (tokenArc) {
      // pathLength=100 → dash is percent of the ring (CSS var beats hard-coded dasharray)
      tokenArc.style.setProperty('--token-dash', String(pct));
    }
  }

  async function refreshContextUsage() {
    const name = projectName();
    if (!name || !state.model || state.viewOnly) return;
    try {
      const res = await fetch('api/assistant/context?name=' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: input.value || '',
          project: state.model.toJSON()
        })
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.max) setTokenUsage(data);
    } catch (err) {
      /* ignore meter errors */
    }
  }

  function scheduleContextUsage() {
    if (contextTimer) clearTimeout(contextTimer);
    contextTimer = setTimeout(function () {
      contextTimer = 0;
      refreshContextUsage();
    }, 450);
  }

  function open(force) {
    if (state.viewOnly) return;
    const show = force === true ? true : force === false ? false : dock.hidden;
    dock.hidden = !show;
    btn.classList.toggle('on', show);
    if (show) {
      refreshAll();
      input.focus();
    }
  }

  function close() {
    open(false);
  }

  async function refreshAll() {
    await refreshStatus();
    await refreshMessages();
    await refreshContextUsage();
  }

  async function refreshStatus() {
    try {
      const res = await fetch('api/assistant/status', { cache: 'no-store' });
      const data = await res.json();
      if (!data.ready) {
        statusEl.textContent = data.error || 'Assistant not ready';
        statusEl.className = 'chat-status warn';
      } else {
        let text = 'Ready';
        if (data.gpuEnabled && !data.gpuOffloadSupported) {
          text += ' (GPU on, but wheel has no offload; python tools/install_assistant.py vulkan)';
          statusEl.className = 'chat-status warn';
        } else if (data.gpuEnabled && data.gpuOffloadSupported) {
          text += ' (GPU)';
          statusEl.className = 'chat-status';
        } else {
          statusEl.className = 'chat-status';
        }
        statusEl.textContent = text;
      }
      return data;
    } catch (err) {
      statusEl.textContent = String(err.message || err);
      statusEl.className = 'chat-status warn';
      return null;
    }
  }

  async function refreshMessages() {
    const name = projectName();
    if (!name) return;
    const res = await fetch('api/assistant/chat?name=' + encodeURIComponent(name), { cache: 'no-store' });
    const data = await res.json();
    renderMessages(data.messages || []);
  }

  function describeOp(op) {
    switch (op.op) {
      case 'insert':
        return 'Add “' + op.name + '” (' + (op.duration || 0) + 'd)' +
          (op.tempId ? ' as ' + op.tempId : '') +
          (op.atStart ? ' at start' : ' after ' + formatRef(op.afterId));
      case 'patch':
        return 'Update #' + op.id + ' (' + Object.keys(op.fields || {}).join(', ') + ')';
      case 'delete':
        return 'Delete #' + (op.ids || []).join(', #');
      case 'link':
        return 'Link ' + formatRef(op.from) + ' → ' + formatRef(op.to) + ' ' + (op.type || 'FS') +
          (op.lag ? ' ' + (op.lag > 0 ? '+' : '') + op.lag + 'd' : '');
      case 'unlink':
        return 'Unlink ' + formatRef(op.from) + ' → ' + formatRef(op.to);
      case 'indent':
        return 'Indent #' + (op.ids || []).join(', #');
      case 'outdent':
        return 'Outdent #' + (op.ids || []).join(', #');
      case 'setLevel':
        return 'Set level of #' + op.id + ' to L' + op.level;
      case 'setMeta':
        return 'Set #' + op.id + ' ' + op.key + ' = ' + op.value;
      default:
        return JSON.stringify(op);
    }
  }

  function formatRef(ref) {
    if (typeof ref === 'string' && !/^\d+$/.test(ref)) return ref;
    return '#' + ref;
  }

  function renderMessages(messages) {
    while (messagesEl.firstChild) messagesEl.removeChild(messagesEl.firstChild);
    pendingOps = null;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const bubble = document.createElement('div');
      bubble.className = 'chat-msg ' + (msg.role === 'user' ? 'user' : 'assistant');
      const body = document.createElement('div');
      body.className = 'chat-msg-body';
      if (msg.role === 'assistant') {
        body.classList.add('md');
        const text = (msg.content || '').trim();
        if (text) {
          body.innerHTML = renderMarkdown(text);
        } else if (!(msg.ops && msg.ops.length)) {
          body.textContent = 'No schedule changes.';
        }
      } else {
        body.textContent = msg.content || '';
      }
      if (body.childNodes.length || (body.textContent || '').trim()) {
        bubble.appendChild(body);
      }

      const isLast = i === messages.length - 1;
      const hasOps = msg.ops && msg.ops.length;
      if (msg.role === 'assistant' && msg.status === 'proposed' && isLast && hasOps) {
        pendingOps = msg.ops || [];
        bubble.appendChild(buildProposal(msg.ops || []));
      } else if (msg.role === 'assistant' && hasOps) {
        const note = document.createElement('div');
        note.className = 'chat-ops-note';
        let prefix = '';
        if (msg.status === 'applied') prefix = 'Applied: ';
        else if (msg.status === 'applied_partial') prefix = 'Partially applied: ';
        else if (msg.status === 'rejected') prefix = 'Rejected: ';
        note.textContent = prefix + msg.ops.map(describeOp).join('; ');
        bubble.appendChild(note);
        if (msg.applyErrors && msg.applyErrors.length) {
          const err = document.createElement('div');
          err.className = 'chat-ops-note';
          err.textContent = 'Failed: ' + msg.applyErrors.join('; ');
          bubble.appendChild(err);
        }
      }

      messagesEl.appendChild(bubble);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function buildProposal(ops) {
    const card = document.createElement('div');
    card.className = 'chat-proposal';
    const title = document.createElement('div');
    title.className = 'chat-proposal-title';
    title.textContent = 'Proposed changes';
    card.appendChild(title);
    const list = document.createElement('ul');
    for (let i = 0; i < ops.length; i++) {
      const li = document.createElement('li');
      li.textContent = describeOp(ops[i]);
      list.appendChild(li);
    }
    card.appendChild(list);
    const row = document.createElement('div');
    row.className = 'chat-proposal-actions';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = 'Apply';
    apply.onclick = function () { applyOps(ops); };
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.textContent = 'Reject';
    reject.onclick = function () { rejectOps(); };
    row.appendChild(apply);
    row.appendChild(reject);
    card.appendChild(row);
    return card;
  }

  function findIndex(id) {
    return state.model.index().get(id);
  }

  function resolveRef(ref, aliases) {
    if (typeof ref === 'string' && aliases.has(ref)) return aliases.get(ref);
    if (typeof ref === 'number' && isFinite(ref)) return ref;
    if (typeof ref === 'string' && /^\d+$/.test(ref)) return parseInt(ref, 10);
    return undefined;
  }

  function applyOps(ops) {
    if (!ops || !ops.length || state.viewOnly) return;
    const warnings = [];
    const aliases = new Map();
    state.model.transact(function () {
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        try {
          if (op.op === 'insert') {
            let at = 0;
            if (op.atStart) {
              at = 0;
            } else {
              const afterId = resolveRef(op.afterId, aliases);
              const idx = afterId === undefined ? undefined : findIndex(afterId);
              if (idx === undefined || idx < 0) {
                warnings.push('insert: unknown afterId ' + op.afterId);
                continue;
              }
              at = idx + 1;
            }
            const extras = {
              name: op.name,
              duration: op.duration,
              milestone: !!op.milestone,
              notes: op.notes || ''
            };
            if (op.meta) extras.meta = op.meta;
            const id = state.model.insertTask(at, op.level, extras);
            if (!id) {
              warnings.push('insert failed: ' + op.name);
            } else if (op.tempId) {
              aliases.set(op.tempId, id);
            }
          } else if (op.op === 'patch') {
            if (!state.model.patchTask(op.id, op.fields || {})) {
              warnings.push('patch failed: #' + op.id);
            }
          } else if (op.op === 'delete') {
            if (!state.model.deleteIds(op.ids || [])) {
              warnings.push('delete failed');
            }
          } else if (op.op === 'link') {
            const typ = LINK_TYPES.indexOf(op.type) >= 0 ? op.type : 'FS';
            const from = resolveRef(op.from, aliases);
            const to = resolveRef(op.to, aliases);
            if (from === undefined || to === undefined) {
              warnings.push('link failed: unresolved ' + formatRef(op.from) + ' → ' + formatRef(op.to));
              continue;
            }
            const result = createLink(from, to, typ, op.lag || 0, { silent: true });
            if (!result.ok) {
              continue;
            }
          } else if (op.op === 'unlink') {
            const from = resolveRef(op.from, aliases);
            const to = resolveRef(op.to, aliases);
            if (from === undefined || to === undefined) {
              warnings.push('unlink failed: unresolved refs');
            } else {
              state.model.removeLink(from, to);
            }
          } else if (op.op === 'indent') {
            const ids = (op.ids || []).map(function (id) { return resolveRef(id, aliases); })
              .filter(function (id) { return id !== undefined; });
            if (!ids.length || !state.model.shiftLevels(ids, 1)) {
              continue;
            }
          } else if (op.op === 'outdent') {
            const ids = (op.ids || []).map(function (id) { return resolveRef(id, aliases); })
              .filter(function (id) { return id !== undefined; });
            if (!ids.length || !state.model.shiftLevels(ids, -1)) {
              continue;
            }
          } else if (op.op === 'setLevel') {
            const id = resolveRef(op.id, aliases);
            if (id === undefined) continue;
            const task = state.model.task(id);
            const want = Math.max(0, op.level | 0);
            const cur = task ? (task.level || 0) : 0;
            const delta = want - cur;
            if (delta !== 0 && !state.model.shiftLevels([id], delta)) {
              continue;
            }
          } else if (op.op === 'setMeta') {
            state.model.setMeta(op.id, op.key, op.value);
          }
        } catch (err) {
          warnings.push(String(err.message || err));
        }
      }
    });
    requestRender();
    const status = warnings.length ? 'applied_partial' : 'applied';
    markStatus(status, warnings);
    pendingOps = null;
    if (warnings.length) warn(warnings.join('; '));
  }

  async function rejectOps() {
    await markStatus('rejected');
    pendingOps = null;
  }

  async function markStatus(status, errors) {
    const name = projectName();
    const body = { status: status };
    if (errors && errors.length) body.errors = errors;
    await fetch('api/assistant/ops-status?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    await refreshMessages();
  }

  function abortSend() {
    if (sendAbort) {
      try { sendAbort.abort(); } catch (e) { /* ignore */ }
      sendAbort = null;
    }
    busy = false;
    sendBtn.disabled = false;
  }

  function showThinkingDots(statusEl) {
    statusEl.className = 'chat-live-status chat-thinking-dots';
    statusEl.hidden = false;
    statusEl.setAttribute('aria-label', 'Thinking');
    statusEl.textContent = '';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'chat-think-dot';
      statusEl.appendChild(dot);
    }
  }

  async function send() {
    if (busy || state.viewOnly) return;
    const text = input.value.trim();
    if (!text) return;
    const name = projectName();
    if (!name || !state.model) return;
    abortSend();
    const ac = new AbortController();
    sendAbort = ac;
    busy = true;
    sendBtn.disabled = true;
    input.value = '';

    const userBubble = document.createElement('div');
    userBubble.className = 'chat-msg user';
    userBubble.textContent = text;
    messagesEl.appendChild(userBubble);

    const live = document.createElement('div');
    live.className = 'chat-msg assistant chat-thinking';
    const liveStatus = document.createElement('div');
    showThinkingDots(liveStatus);
    const liveBody = document.createElement('div');
    liveBody.className = 'chat-msg-body md';
    liveBody.textContent = '';
    live.appendChild(liveStatus);
    live.appendChild(liveBody);
    messagesEl.appendChild(live);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    let raw = '';
    let firstToken = true;
    let aborted = false;
    // Coalesce SSE markdown paints: tokens arrive faster than frames; full
    // renderMarkdown + innerHTML per token was the main chat jank source.
    let streamRaf = 0;
    let streamDirty = false;

    function cancelStreamPaint() {
      if (streamRaf) {
        cancelAnimationFrame(streamRaf);
        streamRaf = 0;
      }
      streamDirty = false;
    }

    function paintStreamMarkdown() {
      streamRaf = 0;
      if (!streamDirty) return;
      streamDirty = false;
      liveBody.innerHTML = renderMarkdown(raw);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function scheduleStreamMarkdown() {
      streamDirty = true;
      if (streamRaf) return;
      streamRaf = requestAnimationFrame(paintStreamMarkdown);
    }

    // Snapshot project once for this request (not per token).
    const projectSnapshot = state.model.toJSON();
    try {
      const res = await fetch('api/assistant/chat?name=' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ message: text, project: projectSnapshot }),
        signal: ac.signal
      });
      if (ac.signal.aborted) {
        aborted = true;
        return;
      }
      const ctype = (res.headers.get('Content-Type') || '').toLowerCase();
      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch (e) { /* ignore */ }
        if (live.parentNode) live.parentNode.removeChild(live);
        warn(data.error || ('Chat failed (' + res.status + ')'));
        if (data.hint) statusEl.textContent = data.hint;
        await refreshMessages();
        return;
      }
      if (ctype.indexOf('text/event-stream') < 0 || !res.body) {
        if (live.parentNode) live.parentNode.removeChild(live);
        warn('Unexpected chat response');
        await refreshMessages();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (!finished) {
        if (ac.signal.aborted) {
          aborted = true;
          try { await reader.cancel(); } catch (e) { /* ignore */ }
          break;
        }
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          if (ac.signal.aborted) {
            aborted = true;
            finished = true;
            break;
          }
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const lines = frame.split('\n');
          let dataLine = '';
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('data:') === 0) {
              dataLine += (dataLine ? '\n' : '') + lines[i].slice(5).replace(/^\s/, '');
            }
          }
          if (!dataLine) continue;
          let event;
          try { event = JSON.parse(dataLine); } catch (e) { continue; }
          if (event.type === 'usage') {
            setTokenUsage(event);
          } else if (event.type === 'status' && event.text) {
            const thinking = event.text.indexOf('Thinking') === 0;
            live.classList.toggle('chat-thinking', thinking && firstToken);
            if (thinking) {
              showThinkingDots(liveStatus);
            } else {
              liveStatus.className = 'chat-live-status';
              liveStatus.removeAttribute('aria-label');
              liveStatus.hidden = false;
              liveStatus.textContent = event.text;
            }
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else if (event.type === 'token' && event.text) {
            if (firstToken) {
              live.classList.remove('chat-thinking');
              liveStatus.hidden = true;
              liveStatus.textContent = '';
              liveStatus.className = 'chat-live-status';
              liveStatus.removeAttribute('aria-label');
              firstToken = false;
            }
            raw += event.text;
            scheduleStreamMarkdown();
          } else if (event.type === 'done') {
            finished = true;
            cancelStreamPaint();
            if (event.usage) setTokenUsage(event.usage);
            renderMessages(event.messages || []);
            break;
          } else if (event.type === 'error') {
            finished = true;
            cancelStreamPaint();
            if (live.parentNode) live.parentNode.removeChild(live);
            warn(event.error || 'Chat failed');
            await refreshMessages();
            break;
          }
        }
      }
      if (!finished && !aborted) {
        cancelStreamPaint();
        await refreshMessages();
      }
    } catch (err) {
      aborted = aborted || (err && err.name === 'AbortError') || ac.signal.aborted;
      cancelStreamPaint();
      if (!aborted) {
        if (live.parentNode) live.parentNode.removeChild(live);
        warn(String(err.message || err));
        await refreshMessages();
      }
    } finally {
      cancelStreamPaint();
      if (sendAbort === ac) sendAbort = null;
      busy = false;
      sendBtn.disabled = false;
      if (!aborted) input.focus();
    }
  }

  function wire() {
    if (state.viewOnly) {
      btn.hidden = true;
      dock.hidden = true;
      return;
    }
    btn.onclick = function () { open(); };
    closeBtn.onclick = close;
    sendBtn.onclick = send;
    clearBtn.onclick = function () {
      el('clearChatDialog').showModal();
      el('clearChatOk').focus();
    };
    el('clearChatCancel').onclick = function () { el('clearChatDialog').close(); };
    el('clearChatOk').onclick = async function () {
      el('clearChatDialog').close();
      abortSend();
      pendingOps = null;
      const name = projectName();
      await fetch('api/assistant/chat?name=' + encodeURIComponent(name), { method: 'DELETE' });
      await refreshMessages();
      await refreshContextUsage();
      input.focus();
    };
    input.addEventListener('input', scheduleContextUsage);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
  }

  async function onProjectChange() {
    pendingOps = null;
    if (!dock.hidden) await refreshAll();
  }

  return {
    wire: wire,
    open: open,
    close: close,
    onProjectChange: onProjectChange,
    refreshAll: refreshAll,
    refreshStatus: refreshStatus
  };
}
