// Timeline view of one debug log: every event, colour-coded by kind, with
// filters, keyword highlighting and match-to-match navigation. Only the rows
// on screen are drawn, and they are fetched from the extension in pages, so
// logs with hundreds of thousands of lines stay quick.
(function () {
  const ROW = 26;
  const PAGE = 200;

  const KINDS = [
    ['error', 'Errors'],
    ['debug', 'Debug'],
    ['soql', 'SOQL'],
    ['dml', 'DML'],
    ['callout', 'Callouts'],
    ['flow', 'Flow & workflow'],
    ['validation', 'Validation'],
    ['limits', 'Limits'],
    ['unit', 'Code units'],
    ['method', 'Methods'],
    ['variable', 'Variables'],
    ['system', 'System']
  ];

  // Letters and digits of the keyword, allowing anything that is not a letter
  // or digit between them, so "dereference" also finds "de-reference".
  function keywordPattern(text, flags) {
    const chars = String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return chars ? new RegExp(chars.split('').join('[\\W_]*'), flags || 'i') : null;
  }

  function highlight(text, pattern, esc) {
    if (!pattern) return esc(text);
    const re = new RegExp(pattern.source, 'gi');
    let out = '';
    let last = 0;
    let match;
    while ((match = re.exec(text)) && match[0]) {
      out += esc(text.slice(last, match.index)) + '<mark>' + esc(match[0]) + '</mark>';
      last = match.index + match[0].length;
    }
    return out + esc(text.slice(last));
  }

  window.createLogViewer = function ({ send, esc }) {
    let state = null;
    let request = 0;

    function key() {
      return [state.id, [...state.kinds].sort().join(','), state.keyword].join('|');
    }

    function reset(id, keyword) {
      state = {
        id,
        keyword: keyword || '',
        kinds: new Set(KINDS.map(([k]) => k)),
        total: undefined,
        all: undefined,
        counts: {},
        pages: new Map(),
        pending: new Set(),
        selected: undefined,
        matchAt: -1,
        jumpTo: undefined
      };
    }

    function mount(host, id, keyword) {
      // A found keyword applies when a log is first opened; after that the box is the developer's.
      if (!state || state.id !== id) {
        reset(id, keyword);
      }
      host.innerHTML = `
        <div class="tl-bar">
          <div class="tl-kinds" id="tlKinds"></div>
          <div class="tl-search">
            <input class="input" id="tlSearch" type="search" placeholder="Highlight a keyword…" value="${esc(state.keyword)}" aria-label="Keyword">
            <button class="btn ghost icon" data-tl="prev" title="Previous match (Shift+Enter)">↑</button>
            <button class="btn ghost icon" data-tl="next" title="Next match (Enter)">↓</button>
            <span class="tl-count" id="tlCount"></span>
          </div>
        </div>
        <div class="tl-list" id="tlList" tabindex="0"><div class="tl-spacer" id="tlSpacer"></div></div>
        <div class="tl-full" id="tlFull" hidden></div>`;
      host.querySelector('#tlList').addEventListener('scroll', () => requestAnimationFrame(draw));
      host.querySelector('#tlSearch').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          const value = event.target.value.trim();
          if (value !== state.keyword) {
            setKeyword(value);
          } else {
            step(event.shiftKey ? -1 : 1);
          }
        }
      });
      let timer;
      host.querySelector('#tlSearch').addEventListener('input', (event) => {
        clearTimeout(timer);
        timer = setTimeout(() => setKeyword(event.target.value.trim()), 350);
      });
      refresh();
    }

    function setKeyword(value) {
      state.keyword = value;
      state.matchAt = -1;
      refresh();
    }

    // Starts over for the current filters: the first page tells us the size.
    function refresh() {
      state.pages = new Map();
      state.pending = new Set();
      state.total = undefined;
      const list = document.getElementById('tlList');
      if (list) list.scrollTop = 0;
      fetchPage(0);
      renderKinds();
      draw();
    }

    function fetchPage(offset) {
      const k = key();
      if (state.pages.has(offset) || state.pending.has(offset)) return;
      state.pending.add(offset);
      send('timeline', { id: state.id, kinds: [...state.kinds], keyword: state.keyword, offset, limit: PAGE, key: k, req: ++request });
    }

    function onData(data) {
      if (!state || data.key !== key()) return; // an answer for older filters
      state.pending.delete(data.offset);
      state.pages.set(data.offset, data.rows);
      state.total = data.total;
      state.all = data.all;
      state.counts = data.counts;
      state.matches = data.matches;
      renderKinds();
      draw();
      // Wait for the page that holds the target, not just any page.
      if (state.jumpTo !== undefined && rowAt(state.jumpTo)) {
        const target = state.jumpTo;
        state.jumpTo = undefined;
        scrollToRow(target);
      }
    }

    function renderKinds() {
      const host = document.getElementById('tlKinds');
      if (!host) return;
      const chips = KINDS.filter(([k]) => state.counts[k]).map(
        ([k, label]) => `<button class="tl-kind k-${k} ${state.kinds.has(k) ? 'on' : ''}" data-kind="${k}"><i></i>${esc(label)} <b>${(state.counts[k] || 0).toLocaleString()}</b></button>`
      );
      host.innerHTML =
        `<button class="tl-kind all" data-kind="*">All</button><button class="tl-kind only-errors" data-kind="!error" title="Show only errors and exceptions">Errors only</button>` +
        chips.join('');
      const count = document.getElementById('tlCount');
      if (count) {
        const shown = state.total === undefined ? '…' : state.total.toLocaleString();
        count.textContent = state.keyword
          ? `${state.matchAt >= 0 ? state.matchAt + 1 + ' of ' : ''}${shown} match${state.total === 1 ? '' : 'es'}`
          : `${shown} of ${(state.all || 0).toLocaleString()} events`;
      }
    }

    function rowAt(index) {
      const page = state.pages.get(Math.floor(index / PAGE) * PAGE);
      return page && page[index - Math.floor(index / PAGE) * PAGE];
    }

    function draw() {
      const list = document.getElementById('tlList');
      if (!list || !state) return;
      const total = state.total || 0;
      document.getElementById('tlSpacer').style.height = `${total * ROW}px`;
      const first = Math.max(0, Math.floor(list.scrollTop / ROW) - 10);
      const last = Math.min(total, Math.ceil((list.scrollTop + list.clientHeight) / ROW) + 10);
      for (let p = Math.floor(first / PAGE) * PAGE; p < last; p += PAGE) fetchPage(p);
      const pattern = keywordPattern(state.keyword);
      let html = '';
      for (let i = first; i < last; i++) {
        const r = rowAt(i);
        if (!r) {
          html += `<div class="tl-row" style="top:${i * ROW}px"><span class="skel" style="width:60%;margin:6px 0"></span></div>`;
          continue;
        }
        html += `<div class="tl-row k-${r.cat} ${state.selected === r.i ? 'sel' : ''}" data-row="${i}" data-ti="${r.i}" style="top:${i * ROW}px">
          <span class="tl-ms">+${r.ms.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms</span>
          <span class="tl-ev" title="${esc(r.event)}">${esc(r.event)}</span>
          <span class="tl-ln">${r.line ? 'L' + r.line : ''}</span>
          <span class="tl-tx">${highlight(r.text.split('\n')[0], pattern, esc)}${r.text.includes('\n') ? ' <em>…</em>' : ''}</span></div>`;
      }
      list.querySelectorAll('.tl-row').forEach((n) => n.remove());
      list.insertAdjacentHTML('beforeend', html);
      if (state.total === undefined) {
        list.insertAdjacentHTML('beforeend', '<div class="tl-row tl-loading" style="top:0"><div class="loading"><span class="spinner"></span><span>Reading events…</span></div></div>');
      } else if (!total) {
        list.insertAdjacentHTML('beforeend', `<div class="tl-row" style="top:0"><span class="tl-tx" style="color:var(--muted)">${state.keyword ? 'No event matches this keyword.' : 'Nothing to show. Switch some kinds back on.'}</span></div>`);
      }
      renderKinds();
    }

    function scrollToRow(index) {
      const list = document.getElementById('tlList');
      if (!list) return;
      list.scrollTop = Math.max(0, index * ROW - list.clientHeight / 3);
      const r = rowAt(index);
      if (r) select(r);
      draw();
    }

    function select(r) {
      state.selected = r.i;
      const full = document.getElementById('tlFull');
      if (!full) return;
      full.hidden = false;
      full.innerHTML = `<div class="tl-fullhead"><span class="tl-ev k-${r.cat}">${esc(r.event)}</span>${r.line ? `<span class="mono">line ${r.line}</span>` : ''}<span class="mono" style="color:var(--muted)">+${r.ms} ms</span><span class="spacer"></span><button class="btn ghost icon" data-tl="copyRow" title="Copy this event">⧉</button></div><pre>${highlight(r.text, keywordPattern(state.keyword), esc)}</pre>`;
    }

    // Steps through matches when a keyword is set, otherwise through errors.
    function step(direction) {
      const total = state.total || 0;
      if (!total) return;
      state.matchAt = (state.matchAt + direction + total) % total;
      if (rowAt(state.matchAt)) {
        scrollToRow(state.matchAt);
      } else {
        state.jumpTo = state.matchAt;
        fetchPage(Math.floor(state.matchAt / PAGE) * PAGE);
      }
      renderKinds();
    }

    // Opens the full timeline at one event (from the summary).
    function jumpToEvent(ti) {
      state.kinds = new Set(KINDS.map(([k]) => k));
      state.keyword = '';
      const input = document.getElementById('tlSearch');
      if (input) input.value = '';
      state.pages = new Map();
      state.pending = new Set();
      state.jumpTo = ti;
      state.selected = ti;
      fetchPage(Math.floor(ti / PAGE) * PAGE);
      fetchPage(0);
    }

    function onClick(event) {
      const kind = event.target.closest('[data-kind]');
      if (kind) {
        const k = kind.dataset.kind;
        if (k === '*') state.kinds = new Set(KINDS.map(([x]) => x));
        else if (k === '!error') state.kinds = new Set(['error']);
        else if (state.kinds.has(k) && state.kinds.size > 1) state.kinds.delete(k);
        else state.kinds.add(k);
        refresh();
        return true;
      }
      const button = event.target.closest('[data-tl]');
      if (button) {
        if (button.dataset.tl === 'next') step(1);
        if (button.dataset.tl === 'prev') step(-1);
        if (button.dataset.tl === 'copyRow') {
          const r = [...state.pages.values()].flat().find((x) => x.i === state.selected);
          if (r) send('copy', { text: `${r.event}${r.line ? ` [${r.line}]` : ''} ${r.text}` });
        }
        return true;
      }
      const row = event.target.closest('.tl-row[data-row]');
      if (row) {
        const r = rowAt(Number(row.dataset.row));
        if (r) {
          select(r);
          draw();
        }
        return true;
      }
      return false;
    }

    return { mount, onData, onClick, jumpToEvent, keywordPattern, highlight: (text, keyword) => highlight(text, keywordPattern(keyword), esc), current: () => state };
  };
})();
