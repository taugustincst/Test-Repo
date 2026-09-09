/* Inkwell charts: small inline-SVG charts with hover tooltips and table twins. No dependencies. */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  /* Colors: the validated dark palette (see docs). Marks carry color; text never does. */
  const TOKENS = {
    surface: '#17171a',
    grid: '#2a2a31',
    axis: '#3a3a44',
    muted: '#898781',
    text: '#f1ece3',
    series: ['#3987e5', '#d95926', '#199e70'],
    ordinal: ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab'],
    sequential: ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'],
  };

  function svgEl(tag, attrs = {}, parent) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    if (parent) parent.appendChild(el);
    return el;
  }

  const compact = (n) => {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
    return v.toLocaleString();
  };
  const money = (n) => `$${compact(n)}`;

  function niceMax(max, ticks = 4, integer = false) {
    if (max <= 0) return { max: ticks, step: 1 };
    if (integer && max <= ticks) return { max: Math.max(ticks, Math.ceil(max)), step: 1 };
    const rough = max / ticks;
    const mag = 10 ** Math.floor(Math.log10(rough));
    const norm = rough / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    return { max: step * ticks >= max ? step * ticks : step * (ticks + 1), step };
  }

  /* ---------- shared tooltip ---------- */

  let tip;
  function tooltip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }

  /** rows: [{ color?, label, value }] with value first in the DOM (values lead, labels follow). */
  function showTip(x, y, title, rows) {
    const t = tooltip();
    t.replaceChildren();
    if (title) { const h = document.createElement('div'); h.className = 'viz-tip__title'; h.textContent = title; t.appendChild(h); }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'viz-tip__row';
      if (r.color) { const key = document.createElement('span'); key.className = 'viz-tip__key'; key.style.background = r.color; row.appendChild(key); }
      const val = document.createElement('strong'); val.textContent = r.value; row.appendChild(val);
      const lab = document.createElement('span'); lab.textContent = r.label; row.appendChild(lab);
      t.appendChild(row);
    }
    t.hidden = false;
    const pad = 12;
    const w = t.offsetWidth; const h = t.offsetHeight;
    let left = x + pad; let top = y - h - pad;
    if (left + w > window.innerWidth - 8) left = x - w - pad;
    if (top < 8) top = y + pad;
    t.style.left = `${left + window.scrollX}px`;
    t.style.top = `${top + window.scrollY}px`;
  }
  function hideTip() { if (tip) tip.hidden = true; }

  /* ---------- responsive mount ---------- */

  function mount(el, draw) {
    const render = () => { el.replaceChildren(); draw(Math.max(200, el.clientWidth)); };
    render();
    if ('ResizeObserver' in window) {
      let last = el.clientWidth;
      const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - last) > 8) { last = el.clientWidth; render(); } });
      ro.observe(el);
      el._vizObserver = ro;
    }
  }

  /* ---------- line chart (multi-series, crosshair tooltip, selective end labels) ---------- */

  function line({ el, labels, series, format = compact, height = 220 }) {
    mount(el, (width) => {
      const m = { t: 14, r: 56, b: 26, l: 40 };
      const w = width - m.l - m.r; const h = height - m.t - m.b;
      const n = labels.length;
      const all = series.flatMap((s) => s.values);
      const rawMax = Math.max(0, ...all);
      const { max, step } = niceMax(rawMax, 4, all.every(Number.isInteger));
      const x = (i) => m.l + (n > 1 ? (i / (n - 1)) * w : w / 2);
      const y = (v) => m.t + h - (v / max) * h;
      const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': `${series.map((s) => s.name).join(' and ')} over time` }, el);

      for (let v = 0; v <= max; v += step) {
        svgEl('line', { x1: m.l, x2: m.l + w, y1: y(v), y2: y(v), stroke: v === 0 ? TOKENS.axis : TOKENS.grid, 'stroke-width': 1 }, svg);
        svgEl('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'viz-axis' }, svg).textContent = format(v);
      }
      const every = Math.max(1, Math.ceil(n / 6));
      labels.forEach((lab, i) => {
        if (i % every !== 0 && i !== n - 1) return;
        svgEl('text', { x: x(i), y: height - 8, 'text-anchor': i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'), class: 'viz-axis' }, svg).textContent = lab;
      });

      series.forEach((s, si) => {
        const color = s.color || TOKENS.series[si];
        const pts = s.values.map((v, i) => `${x(i)},${y(v)}`);
        if (series.length === 1) {
          svgEl('path', { d: `M${x(0)},${y(0)} L${pts.join(' L')} L${x(n - 1)},${y(0)} Z`, fill: color, opacity: 0.1 }, svg);
        }
        svgEl('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
        const lastI = n - 1;
        svgEl('circle', { cx: x(lastI), cy: y(s.values[lastI]), r: 4, fill: color, stroke: TOKENS.surface, 'stroke-width': 2 }, svg);
        svgEl('text', { x: x(lastI) + 8, y: y(s.values[lastI]) + 4, class: 'viz-label' }, svg).textContent = format(s.values[lastI]);
      });

      // Crosshair: the pointer aims at an X, never at a 2px line.
      const cross = svgEl('line', { x1: 0, x2: 0, y1: m.t, y2: m.t + h, stroke: TOKENS.muted, 'stroke-width': 1, opacity: 0 }, svg);
      const dots = series.map((s, si) => svgEl('circle', { r: 4, fill: s.color || TOKENS.series[si], stroke: TOKENS.surface, 'stroke-width': 2, opacity: 0 }, svg));
      const hit = svgEl('rect', { x: m.l, y: 0, width: w, height, fill: 'transparent', tabindex: 0, 'aria-label': 'Chart values; use arrow keys' }, svg);
      let idx = -1;
      const focus = (i, clientX, clientY) => {
        idx = i;
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 1);
        dots.forEach((d, si) => { d.setAttribute('cx', x(i)); d.setAttribute('cy', y(series[si].values[i])); d.setAttribute('opacity', 1); });
        const rect = svg.getBoundingClientRect();
        showTip(clientX ?? rect.left + x(i), clientY ?? rect.top + m.t, labels[i], series.map((s, si) => ({ color: s.color || TOKENS.series[si], label: s.name, value: format(s.values[i]) })));
      };
      const blur = () => { cross.setAttribute('opacity', 0); dots.forEach((d) => d.setAttribute('opacity', 0)); hideTip(); };
      hit.addEventListener('pointermove', (e) => {
        const rect = svg.getBoundingClientRect();
        const px = (e.clientX - rect.left) * (width / rect.width);
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / w) * (n - 1))));
        focus(i, e.clientX, e.clientY);
      });
      hit.addEventListener('pointerleave', blur);
      hit.addEventListener('focus', () => focus(idx < 0 ? n - 1 : idx));
      hit.addEventListener('blur', blur);
      hit.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); focus(Math.max(0, (idx < 0 ? n - 1 : idx) - 1)); }
        if (e.key === 'ArrowRight') { e.preventDefault(); focus(Math.min(n - 1, (idx < 0 ? n - 1 : idx) + 1)); }
      });
    });
  }

  /* ---------- column chart (single series, thin bars, rounded data-end) ---------- */

  function column({ el, labels, values, color = TOKENS.series[0], format = compact, height = 200 }) {
    mount(el, (width) => {
      const m = { t: 18, r: 12, b: 26, l: 40 };
      const w = width - m.l - m.r; const h = height - m.t - m.b;
      const n = values.length;
      const { max, step } = niceMax(Math.max(0, ...values), 4, values.every(Number.isInteger));
      const band = w / n;
      const bw = Math.min(24, Math.max(3, band - 2));
      const y = (v) => m.t + h - (v / max) * h;
      const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' }, el);
      for (let v = 0; v <= max; v += step) {
        svgEl('line', { x1: m.l, x2: m.l + w, y1: y(v), y2: y(v), stroke: v === 0 ? TOKENS.axis : TOKENS.grid, 'stroke-width': 1 }, svg);
        svgEl('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'viz-axis' }, svg).textContent = format(v);
      }
      const every = Math.max(1, Math.ceil(n / 6));
      const maxI = values.indexOf(Math.max(...values));
      values.forEach((v, i) => {
        const cx = m.l + band * i + band / 2;
        const top = y(v); const base = y(0);
        const hh = Math.max(0, base - top);
        const r = Math.min(4, hh);
        const left = cx - bw / 2;
        const d = hh > 0
          ? `M${left},${base} V${top + r} Q${left},${top} ${left + r},${top} H${left + bw - r} Q${left + bw},${top} ${left + bw},${top + r} V${base} Z`
          : `M${left},${base} h${bw} v0 Z`;
        const bar = svgEl('path', { d, fill: color, class: 'viz-bar' }, svg);
        const hit = svgEl('rect', { x: m.l + band * i, y: m.t, width: band, height: h + m.b, fill: 'transparent', tabindex: 0, 'aria-label': `${labels[i]}: ${format(v)}` }, svg);
        const show = (e) => { bar.classList.add('is-hover'); const rect = svg.getBoundingClientRect(); showTip(e && e.clientX ? e.clientX : rect.left + cx, e && e.clientY ? e.clientY : rect.top + top, labels[i], [{ color, label: 'value', value: format(v) }]); };
        const hide = () => { bar.classList.remove('is-hover'); hideTip(); };
        hit.addEventListener('pointermove', show); hit.addEventListener('pointerleave', hide);
        hit.addEventListener('focus', () => show()); hit.addEventListener('blur', hide);
        if (i === maxI && v > 0) svgEl('text', { x: cx, y: top - 6, 'text-anchor': 'middle', class: 'viz-label' }, svg).textContent = format(v);
        if (i % every === 0 || i === n - 1) svgEl('text', { x: cx, y: height - 8, 'text-anchor': 'middle', class: 'viz-axis' }, svg).textContent = labels[i];
      });
    });
  }

  /* ---------- horizontal bars (funnel / ratings / demand) ---------- */

  function barsH({ el, rows, colors, format = compact, labelWidth = 150 }) {
    mount(el, (width) => {
      const rowH = 30; const barH = 18;
      const height = rows.length * rowH + 4;
      const max = Math.max(1, ...rows.map((r) => r.value));
      const labelFor = (r) => (r.detail ? `${format(r.value)} ${r.detail}` : format(r.value));
      const longest = Math.max(...rows.map((r) => labelFor(r).length));
      const l = labelWidth; const w = Math.max(40, width - l - (longest * 6.6 + 16));
      const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' }, el);
      svgEl('line', { x1: l, x2: l, y1: 0, y2: height, stroke: TOKENS.axis, 'stroke-width': 1 }, svg);
      rows.forEach((r, i) => {
        const y = i * rowH + (rowH - barH) / 2;
        const bw = Math.max(0, (r.value / max) * w);
        const color = Array.isArray(colors) ? colors[i % colors.length] : (colors || TOKENS.series[0]);
        svgEl('text', { x: l - 10, y: y + barH / 2 + 4, 'text-anchor': 'end', class: 'viz-axis viz-axis--strong' }, svg).textContent = r.label;
        const rr = Math.min(4, bw);
        const d = bw > 0 ? `M${l},${y} H${l + bw - rr} Q${l + bw},${y} ${l + bw},${y + rr} V${y + barH - rr} Q${l + bw},${y + barH} ${l + bw - rr},${y + barH} H${l} Z` : '';
        const bar = svgEl('path', { d, fill: color, class: 'viz-bar' }, svg);
        svgEl('text', { x: l + bw + 8, y: y + barH / 2 + 4, class: 'viz-label' }, svg).textContent = labelFor(r);
        const hit = svgEl('rect', { x: 0, y: i * rowH, width, height: rowH, fill: 'transparent', tabindex: 0, 'aria-label': `${r.label}: ${format(r.value)}` }, svg);
        const show = (e) => { bar.classList.add('is-hover'); const rect = svg.getBoundingClientRect(); showTip(e && e.clientX ? e.clientX : rect.left + l + bw, e && e.clientY ? e.clientY : rect.top + y, r.label, [{ color, label: r.detail || '', value: format(r.value) }]); };
        const hide = () => { bar.classList.remove('is-hover'); hideTip(); };
        hit.addEventListener('pointermove', show); hit.addEventListener('pointerleave', hide);
        hit.addEventListener('focus', () => show()); hit.addEventListener('blur', hide);
      });
    });
  }

  /* ---------- heatmap (weekday × hour, sequential ramp) ---------- */

  function heatmap({ el, grid, rowLabels, colLabels, ramp = TOKENS.sequential, format = compact, hours = [8, 21] }) {
    mount(el, (width) => {
      const l = 36; const t = 18;
      const cols = hours[1] - hours[0] + 1;
      const cell = Math.max(10, Math.min(28, (width - l - 8) / cols));
      const height = t + grid.length * (cell + 2) + 4;
      const max = Math.max(1, ...grid.flat());
      const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' }, el);
      for (let c = 0; c < cols; c += 1) {
        if ((hours[0] + c) % 3 === 0) svgEl('text', { x: l + c * (cell + 2) + cell / 2, y: 12, 'text-anchor': 'middle', class: 'viz-axis' }, svg).textContent = colLabels[hours[0] + c];
      }
      grid.forEach((row, r) => {
        svgEl('text', { x: l - 8, y: t + r * (cell + 2) + cell / 2 + 4, 'text-anchor': 'end', class: 'viz-axis' }, svg).textContent = rowLabels[r];
        for (let c = 0; c < cols; c += 1) {
          const v = row[hours[0] + c];
          const stepI = v <= 0 ? -1 : Math.min(ramp.length - 1, Math.floor((v / max) * ramp.length - 0.001));
          const fill = stepI < 0 ? TOKENS.grid : ramp[stepI];
          const x = l + c * (cell + 2); const y = t + r * (cell + 2);
          const rect = svgEl('rect', { x, y, width: cell, height: cell, rx: 3, fill, class: 'viz-cell', tabindex: 0, 'aria-label': `${rowLabels[r]} ${colLabels[hours[0] + c]}: ${format(v)}` }, svg);
          const show = (e) => { const b = svg.getBoundingClientRect(); showTip(e && e.clientX ? e.clientX : b.left + x, e && e.clientY ? e.clientY : b.top + y, `${rowLabels[r]} at ${colLabels[hours[0] + c]}`, [{ color: fill, label: v === 1 ? 'session' : 'sessions', value: format(v) }]); };
          rect.addEventListener('pointermove', show); rect.addEventListener('pointerleave', hideTip);
          rect.addEventListener('focus', () => show()); rect.addEventListener('blur', hideTip);
        }
      });
    });
  }

  /* ---------- sparkline (stat tiles) ---------- */

  function sparkline({ el, values, color = TOKENS.series[0], width = 96, height = 28 }) {
    el.replaceChildren();
    const n = values.length;
    if (!n) return;
    const max = Math.max(1, ...values);
    const x = (i) => 2 + (n > 1 ? (i / (n - 1)) * (width - 8) : 0);
    const y = (v) => height - 4 - (v / max) * (height - 8);
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' }, el);
    svgEl('polyline', { points: values.map((v, i) => `${x(i)},${y(v)}`).join(' '), fill: 'none', stroke: TOKENS.muted, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, svg);
    svgEl('circle', { cx: x(n - 1), cy: y(values[n - 1]), r: 3, fill: color, stroke: TOKENS.surface, 'stroke-width': 2 }, svg);
  }

  /* ---------- table twin ---------- */

  function table({ el, columns, rows }) {
    el.replaceChildren();
    const t = document.createElement('table');
    t.className = 'table viz-table';
    const thead = document.createElement('thead'); const tr = document.createElement('tr');
    columns.forEach((c) => { const th = document.createElement('th'); th.textContent = c; tr.appendChild(th); });
    thead.appendChild(tr); t.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach((r) => { const row = document.createElement('tr'); r.forEach((v) => { const td = document.createElement('td'); td.textContent = v; row.appendChild(td); }); tbody.appendChild(row); });
    t.appendChild(tbody);
    el.appendChild(t);
  }

  window.charts = { line, column, barsH, heatmap, sparkline, table, compact, money, TOKENS, hideTip };
})();
