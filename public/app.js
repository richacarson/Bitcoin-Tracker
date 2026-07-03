/* Bitcoin Tracker dashboard — vanilla JS + hand-rolled SVG charts. */
'use strict';

const state = { data: null, range: 'all', views: { value: 'chart', buys: 'chart' } };
const NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

// ── Formatting ──────────────────────────────────────────────────────────
const fmtUsdFull = (v) =>
  (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtUsd(v) {
  const a = Math.abs(v), sign = v < 0 ? '-$' : '$';
  if (a >= 1e6) return sign + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return sign + (a / 1e3).toFixed(1) + 'K';
  if (a >= 100) return sign + Math.round(a).toLocaleString('en-US');
  return sign + a.toFixed(2);
}
const fmtBtc = (v) => {
  const digits = Math.abs(v) >= 1 ? 4 : 8;
  return parseFloat(v.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits }) + ' BTC';
};
const fmtDate = (d) =>
  new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtPct = (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';

// ── DOM helpers (textContent only — labels are untrusted data) ─────────
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function svgEl(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  return node;
}

// ── Scales & ticks ──────────────────────────────────────────────────────
function niceTicks(min, max, count = 5) {
  if (min === max) { min = min * 0.9; max = max * 1.1 || 1; }
  const span = max - min;
  const step0 = Math.pow(10, Math.floor(Math.log10(span / count)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * step0).find((s) => span / s <= count) || step0 * 10;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step / 1e6; v += step) ticks.push(v);
  return ticks;
}
function timeTicks(t0, t1, count = 6) {
  const ticks = [];
  const span = t1 - t0;
  const d = new Date(t0);
  d.setDate(1); d.setHours(0, 0, 0, 0);
  const monthStep = Math.max(1, Math.round(span / (30.4 * 86400000) / count));
  d.setMonth(d.getMonth() + 1);
  while (d.getTime() <= t1) {
    ticks.push(d.getTime());
    d.setMonth(d.getMonth() + monthStep);
  }
  return ticks;
}
const fmtTick = (t, span) =>
  new Date(t).toLocaleDateString('en-US', span > 300 * 86400000 ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });

// ── Tooltip ─────────────────────────────────────────────────────────────
const tooltip = () => $('tooltip');
function showTooltip(clientX, clientY, dateText, rows) {
  const tt = tooltip();
  tt.replaceChildren();
  tt.appendChild(el('div', 'tt-date', dateText));
  for (const r of rows) {
    const row = el('div', 'tt-row');
    const key = el('span', 'tt-key');
    key.style.background = r.color;
    row.appendChild(key);
    row.appendChild(el('span', 'tt-val', r.value));
    row.appendChild(el('span', 'tt-name', r.name));
    tt.appendChild(row);
  }
  tt.hidden = false;
  const rect = tt.getBoundingClientRect();
  let x = clientX + 14, y = clientY + 14;
  if (x + rect.width > window.innerWidth - 8) x = clientX - rect.width - 14;
  if (y + rect.height > window.innerHeight - 8) y = clientY - rect.height - 14;
  tt.style.left = x + 'px';
  tt.style.top = y + 'px';
}
const hideTooltip = () => { tooltip().hidden = true; };

// ── Chart scaffolding ───────────────────────────────────────────────────
function chartFrame(container, seriesMeta) {
  container.replaceChildren();
  const legend = el('div', 'chart-legend');
  for (const s of seriesMeta) {
    const item = el('div', 'legend-item');
    const key = el('span', s.dot ? 'legend-key-dot' : 'legend-key-line');
    key.style.background = s.color;
    item.appendChild(key);
    item.appendChild(el('span', null, s.name));
    legend.appendChild(item);
  }
  container.appendChild(legend);
  const width = Math.max(320, container.clientWidth);
  const height = 320;
  const m = { l: 62, r: 96, t: 10, b: 30 };
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  container.appendChild(svg);
  return { svg, width, height, m, plotW: width - m.l - m.r, plotH: height - m.t - m.b };
}

function drawAxes(f, tExt, yTicks, yFmt) {
  const { svg, m, plotW, plotH } = f;
  for (const v of yTicks) {
    const y = m.t + plotH - ((v - yTicks[0]) / (yTicks[yTicks.length - 1] - yTicks[0])) * plotH;
    svg.appendChild(svgEl('line', { x1: m.l, x2: m.l + plotW, y1: y, y2: y, stroke: 'var(--grid)', 'stroke-width': 1 }));
    const label = svgEl('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end', class: 'axis-text' });
    label.textContent = yFmt(v);
    svg.appendChild(label);
  }
  svg.appendChild(svgEl('line', { x1: m.l, x2: m.l + plotW, y1: m.t + plotH, y2: m.t + plotH, stroke: 'var(--baseline)', 'stroke-width': 1 }));
  const span = tExt[1] - tExt[0];
  for (const t of timeTicks(tExt[0], tExt[1])) {
    const x = m.l + ((t - tExt[0]) / span) * plotW;
    const label = svgEl('text', { x, y: m.t + plotH + 18, 'text-anchor': 'middle', class: 'axis-text' });
    label.textContent = fmtTick(t, span);
    svg.appendChild(label);
  }
}

function linePath(points, sx, sy) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
}

// End labels with simple collision handling (push apart + leader lines).
function endLabels(f, labels) {
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].y - labels[i - 1].y < 15) labels[i].y = labels[i - 1].y + 15;
  }
  for (const lb of labels) {
    if (Math.abs(lb.y - lb.anchorY) > 4) {
      f.svg.appendChild(svgEl('line', {
        x1: f.m.l + f.plotW + 2, x2: f.m.l + f.plotW + 12,
        y1: lb.anchorY, y2: lb.y - 4, stroke: 'var(--baseline)', 'stroke-width': 1,
      }));
    }
    const text = svgEl('text', { x: f.m.l + f.plotW + 14, y: lb.y, class: 'end-label' });
    text.textContent = lb.text;
    f.svg.appendChild(text);
  }
}

function hoverDot(svg, color) {
  const dot = svgEl('circle', { r: 4.5, fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' });
  svg.appendChild(dot);
  return dot;
}

// Multi-series line chart with crosshair + all-series tooltip.
function lineChart(container, series, yFmt, tooltipFmt) {
  const f = chartFrame(container, series);
  const all = series.flatMap((s) => s.points);
  if (!all.length) { container.appendChild(el('p', 'muted', 'No data in this range.')); return; }
  const tExt = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
  const yTicks = niceTicks(Math.min(0, ...all.map((p) => p[1])), Math.max(...all.map((p) => p[1])));
  const yExt = [yTicks[0], yTicks[yTicks.length - 1]];
  const sx = (t) => f.m.l + ((t - tExt[0]) / (tExt[1] - tExt[0] || 1)) * f.plotW;
  const sy = (v) => f.m.t + f.plotH - ((v - yExt[0]) / (yExt[1] - yExt[0] || 1)) * f.plotH;
  drawAxes(f, tExt, yTicks, yFmt);

  for (const s of series) {
    if (s.area) {
      const last = s.points[s.points.length - 1], first = s.points[0];
      f.svg.appendChild(svgEl('path', {
        d: linePath(s.points, sx, sy) + `L${sx(last[0])},${sy(yExt[0] < 0 ? 0 : yExt[0])}L${sx(first[0])},${sy(yExt[0] < 0 ? 0 : yExt[0])}Z`,
        fill: s.color, opacity: 0.1,
      }));
    }
    f.svg.appendChild(svgEl('path', {
      d: linePath(s.points, sx, sy), fill: 'none', stroke: s.color,
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  }
  endLabels(f, series.map((s) => {
    const last = s.points[s.points.length - 1];
    return { anchorY: sy(last[1]), y: sy(last[1]) + 4, text: yFmt(last[1]) };
  }));

  // Crosshair + tooltip (pointer and keyboard).
  const hair = svgEl('line', { y1: f.m.t, y2: f.m.t + f.plotH, stroke: 'var(--baseline)', 'stroke-width': 1, visibility: 'hidden' });
  f.svg.appendChild(hair);
  const dots = series.map((s) => hoverDot(f.svg, s.color));
  const overlay = svgEl('rect', { x: f.m.l, y: f.m.t, width: f.plotW, height: f.plotH, fill: 'transparent', tabindex: 0 });
  f.svg.appendChild(overlay);
  const times = series[0].points.map((p) => p[0]);
  let idx = -1;
  const showAt = (i, clientX, clientY) => {
    idx = i;
    const t = times[i];
    const x = sx(t);
    hair.setAttribute('x1', x); hair.setAttribute('x2', x);
    hair.setAttribute('visibility', 'visible');
    const rows = [];
    series.forEach((s, si) => {
      const p = s.points[Math.min(i, s.points.length - 1)];
      dots[si].setAttribute('cx', sx(p[0]));
      dots[si].setAttribute('cy', sy(p[1]));
      dots[si].setAttribute('visibility', 'visible');
      rows.push({ color: s.color, name: s.name, value: tooltipFmt(p[1]) });
    });
    showTooltip(clientX, clientY, fmtDate(t), rows);
  };
  const clear = () => {
    hair.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    hideTooltip();
    idx = -1;
  };
  overlay.addEventListener('pointermove', (e) => {
    const rect = f.svg.getBoundingClientRect();
    const scale = f.width / rect.width;
    const t = tExt[0] + (((e.clientX - rect.left) * scale - f.m.l) / f.plotW) * (tExt[1] - tExt[0]);
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    showAt(best, e.clientX, e.clientY);
  });
  overlay.addEventListener('pointerleave', clear);
  overlay.addEventListener('blur', clear);
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = Math.max(0, Math.min(times.length - 1, (idx < 0 ? times.length - 1 : idx) + (e.key === 'ArrowRight' ? 1 : -1)));
    const rect = f.svg.getBoundingClientRect();
    const scale = rect.width / f.width;
    showAt(next, rect.left + sx(times[next]) * scale, rect.top + f.m.t * scale + 40);
  });
}

// Scatter (buy dots) over context lines, nearest-point hover.
function buysChart(container, dots, lines, yFmt) {
  const meta = [{ name: 'Your buys (effective price)', color: cssVar('--series-2'), dot: true }, ...lines];
  const f = chartFrame(container, meta);
  const allY = [...dots.map((d) => d.y), ...lines.flatMap((l) => l.points.map((p) => p[1]))];
  const allT = [...dots.map((d) => d.t), ...lines.flatMap((l) => l.points.map((p) => p[0]))];
  if (!allY.length) { container.appendChild(el('p', 'muted', 'No buys in this range.')); return; }
  const tExt = [Math.min(...allT), Math.max(...allT)];
  const yTicks = niceTicks(Math.min(...allY) * 0.95, Math.max(...allY) * 1.02);
  const yExt = [yTicks[0], yTicks[yTicks.length - 1]];
  const sx = (t) => f.m.l + ((t - tExt[0]) / (tExt[1] - tExt[0] || 1)) * f.plotW;
  const sy = (v) => f.m.t + f.plotH - ((v - yExt[0]) / (yExt[1] - yExt[0] || 1)) * f.plotH;
  drawAxes(f, tExt, yTicks, yFmt);

  for (const line of lines) {
    f.svg.appendChild(svgEl('path', {
      d: linePath(line.points, sx, sy), fill: 'none', stroke: line.color,
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      'stroke-dasharray': '', opacity: 0.9,
    }));
  }
  for (const d of dots) {
    f.svg.appendChild(svgEl('circle', {
      cx: sx(d.t), cy: sy(d.y), r: 4, fill: cssVar('--series-2'),
      stroke: 'var(--surface-1)', 'stroke-width': 2,
    }));
  }
  endLabels(f, lines.map((l) => {
    const last = l.points[l.points.length - 1];
    return { anchorY: sy(last[1]), y: sy(last[1]) + 4, text: `${l.short} ${yFmt(last[1])}` };
  }));

  const halo = svgEl('circle', { r: 7, fill: 'none', stroke: cssVar('--series-2'), 'stroke-width': 2, visibility: 'hidden' });
  f.svg.appendChild(halo);
  const overlay = svgEl('rect', { x: f.m.l, y: f.m.t, width: f.plotW, height: f.plotH, fill: 'transparent', tabindex: 0 });
  f.svg.appendChild(overlay);
  const showDot = (d, clientX, clientY) => {
    halo.setAttribute('cx', sx(d.t)); halo.setAttribute('cy', sy(d.y));
    halo.setAttribute('visibility', 'visible');
    showTooltip(clientX, clientY, `${fmtDate(d.t)} · ${d.data.source}`, [
      { color: cssVar('--series-2'), name: 'spent', value: fmtUsdFull(d.data.usd) },
      { color: cssVar('--series-2'), name: 'bought', value: fmtBtc(d.data.btc) },
      { color: cssVar('--series-2'), name: 'effective price', value: fmtUsdFull(d.data.price) },
    ]);
  };
  overlay.addEventListener('pointermove', (e) => {
    const rect = f.svg.getBoundingClientRect();
    const scale = f.width / rect.width;
    const px = (e.clientX - rect.left) * scale, py = (e.clientY - rect.top) * scale;
    let best = null, bestDist = Infinity;
    for (const d of dots) {
      const dist = Math.hypot(sx(d.t) - px, sy(d.y) - py);
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    if (best) showDot(best, e.clientX, e.clientY);
  });
  overlay.addEventListener('pointerleave', () => { halo.setAttribute('visibility', 'hidden'); hideTooltip(); });
  overlay.addEventListener('blur', () => { halo.setAttribute('visibility', 'hidden'); hideTooltip(); });
  let kIdx = -1;
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    kIdx = Math.max(0, Math.min(dots.length - 1, (kIdx < 0 ? dots.length - 1 : kIdx) + (e.key === 'ArrowRight' ? 1 : -1)));
    const rect = f.svg.getBoundingClientRect();
    const scale = rect.width / f.width;
    const d = dots[kIdx];
    showDot(d, rect.left + sx(d.t) * scale, rect.top + sy(d.y) * scale);
  });
}

const cssVar = (name) => getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(name).trim();

// ── Tables ──────────────────────────────────────────────────────────────
function buildTable(container, headers, rows) {
  container.replaceChildren();
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  headers.forEach((h) => hr.appendChild(el('th', null, h)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td');
      if (cell && cell.chip) {
        const chip = el('span', 'chip', cell.chip);
        td.appendChild(chip);
      } else if (cell && cell.cls) {
        td.className = '';
        td.appendChild(el('span', cell.cls, cell.text));
      } else td.textContent = cell ?? '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

// ── Range filtering ─────────────────────────────────────────────────────
function rangeCutoff() {
  const days = { '90d': 90, '1y': 365, '2y': 730 }[state.range];
  return days ? Date.now() - days * 86400000 : 0;
}

// ── Render ──────────────────────────────────────────────────────────────
function tile(label, value, opts = {}) {
  const t = el('div', 'tile' + (opts.hero ? ' hero' : ''));
  t.appendChild(el('div', 'label', label));
  t.appendChild(el('div', 'value', value));
  if (opts.delta) t.appendChild(el('div', 'delta ' + (opts.deltaDir || ''), opts.delta));
  if (opts.sub) t.appendChild(el('div', 'sub', opts.sub));
  return t;
}

function renderTiles() {
  const s = state.data.summary;
  const tiles = $('tiles');
  tiles.replaceChildren();
  tiles.appendChild(tile('Portfolio value', fmtUsdFull(s.currentValue), {
    hero: true,
    delta: `${s.unrealizedGain >= 0 ? '▲' : '▼'} ${fmtUsd(s.unrealizedGain)} (${fmtPct(s.unrealizedPct)}) unrealized`,
    deltaDir: s.unrealizedGain >= 0 ? 'up' : 'down',
  }));
  tiles.appendChild(tile('Holdings (BTC)', fmtBtc(s.currentBtc).replace(' BTC', ''), {
    sub: s.reconcileDiffBtc != null ? `ledger math: ${fmtBtc(s.computedBtc)}` : null,
  }));
  tiles.appendChild(tile('Average cost', fmtUsdFull(s.avgCost), {
    sub: 'per BTC, fees included',
  }));
  tiles.appendChild(tile('BTC price', fmtUsdFull(s.currentPrice), {
    delta: s.avgCost > 0 ? fmtPct(((s.currentPrice - s.avgCost) / s.avgCost) * 100) + ' vs your avg' : null,
    deltaDir: s.currentPrice >= s.avgCost ? 'up' : 'down',
  }));
  tiles.appendChild(tile('Net invested', fmtUsd(s.netInvested), {
    sub: `cost basis ${fmtUsd(s.costBasisUsd)} · fees ${fmtUsd(s.totalFeesUsd)}`,
  }));
  if (s.totalSellBtc > 0) {
    tiles.appendChild(tile('Realized P/L', fmtUsd(s.realizedGain), {
      delta: `${fmtBtc(s.totalSellBtc)} sold (FIFO)`,
      deltaDir: s.realizedGain >= 0 ? 'up' : 'down',
    }));
  }
}

function renderLocations() {
  const box = $('locations');
  box.replaceChildren();
  const { locations, summary } = state.data;
  if (!locations.length) {
    box.appendChild(el('p', 'muted', 'Add exchange keys or a Phantom address to see balances by venue.'));
    return;
  }
  const total = locations.reduce((sum, l) => sum + l.btc, 0) || 1;
  const colors = [cssVar('--series-1'), cssVar('--series-2'), cssVar('--series-3')];
  locations.forEach((loc, i) => {
    const row = el('div', 'loc-row');
    const name = el('div', 'loc-name');
    const dot = el('span', 'loc-dot');
    dot.style.background = colors[i % colors.length];
    name.appendChild(dot);
    name.appendChild(el('span', null, loc.name + (loc.actual ? '' : ' (est.)')));
    const track = el('div', 'loc-bar-track');
    const bar = el('div', 'loc-bar');
    bar.style.width = Math.max(2, (loc.btc / total) * 100) + '%';
    bar.style.background = colors[i % colors.length];
    track.appendChild(bar);
    row.appendChild(name);
    row.appendChild(track);
    row.appendChild(el('div', 'loc-val', `${fmtBtc(loc.btc)} · ${fmtUsd(loc.btc * summary.currentPrice)}`));
    box.appendChild(row);
  });
  if (summary.reconcileDiffBtc != null && Math.abs(summary.reconcileDiffBtc) > 1e-6) {
    const kv = el('div', 'kv-row');
    kv.appendChild(el('span', 'k', 'Live balances vs. trade ledger'));
    kv.appendChild(el('span', 'v', `${summary.reconcileDiffBtc > 0 ? '+' : ''}${fmtBtc(summary.reconcileDiffBtc)} (network fees, dust)`));
    box.appendChild(kv);
  }
}

function renderActivity() {
  const box = $('activity');
  box.replaceChildren();
  const { buys } = state.data;
  const s = state.data.summary;
  const rows = [];
  if (buys.length) {
    const last30 = buys.filter((b) => new Date(b.date) > Date.now() - 30 * 86400000);
    const spent30 = last30.reduce((sum, b) => sum + b.usd, 0);
    const stack30 = last30.reduce((sum, b) => sum + b.btc, 0);
    rows.push(['Buys, last 30 days', `${last30.length} (${fmtUsd(spent30)})`]);
    rows.push(['Stacked, last 30 days', fmtBtc(stack30)]);
    rows.push(['Average buy', fmtUsd(s.totalBuyUsd / s.buyCount)]);
    rows.push(['Total buys', `${s.buyCount} since ${fmtDate(s.firstBuy)}`]);
    rows.push(['Last buy', fmtDate(buys[buys.length - 1].date)]);
    rows.push(['Lifetime spent', fmtUsdFull(s.totalBuyUsd)]);
  } else {
    rows.push(['Buys', 'none recorded yet']);
  }
  for (const [k, v] of rows) {
    const kv = el('div', 'kv-row');
    kv.appendChild(el('span', 'k', k));
    kv.appendChild(el('span', 'v', v));
    box.appendChild(kv);
  }
}

function renderValueChart() {
  const cutoff = rangeCutoff();
  const daily = state.data.daily.filter((d) => new Date(d.d).getTime() >= cutoff);
  const points = daily.map((d) => [new Date(d.d).getTime(), d]);
  lineChart(
    $('value-chart'),
    [
      { name: 'Portfolio value', color: cssVar('--series-1'), points: points.map(([t, d]) => [t, d.value]), area: true },
      { name: 'Net invested', color: cssVar('--series-2'), points: points.map(([t, d]) => [t, d.invested]) },
    ],
    fmtUsd,
    fmtUsdFull
  );
  // Table twin: month-end rows.
  const monthly = [];
  for (let i = 0; i < daily.length; i++) {
    const cur = daily[i], next = daily[i + 1];
    if (!next || next.d.slice(0, 7) !== cur.d.slice(0, 7)) monthly.push(cur);
  }
  buildTable($('value-table'), ['Month end', 'Net invested', 'Portfolio value', 'P/L', 'BTC held'],
    monthly.map((d) => [
      d.d,
      fmtUsdFull(d.invested),
      fmtUsdFull(d.value),
      { cls: d.value - d.invested >= 0 ? 'type-buy' : 'type-sell', text: fmtUsd(d.value - d.invested) },
      fmtBtc(d.btc),
    ]));
}

function renderBuysChart() {
  const cutoff = rangeCutoff();
  const buys = state.data.buys.filter((b) => new Date(b.date).getTime() >= cutoff);
  const daily = state.data.daily.filter((d) => new Date(d.d).getTime() >= cutoff);
  const marketLine = daily.filter((d) => d.btc > 1e-9).map((d) => [new Date(d.d).getTime(), d.value / d.btc]);
  // Average-cost step line across the visible window.
  const acs = state.data.avgCostSeries.filter((p) => p.avgCost > 0);
  const avgLine = [];
  for (const p of acs) {
    const t = new Date(p.date).getTime();
    if (t >= cutoff) avgLine.push([t, p.avgCost]);
  }
  const before = acs.filter((p) => new Date(p.date).getTime() < cutoff).pop();
  if (before) avgLine.unshift([Math.max(cutoff, marketLine[0]?.[0] ?? cutoff), before.avgCost]);
  if (avgLine.length) avgLine.push([Date.now(), avgLine[avgLine.length - 1][1]]);

  buysChart(
    $('buys-chart'),
    buys.map((b) => ({ t: new Date(b.date).getTime(), y: b.price, data: b })),
    [
      { name: 'Market price', short: 'mkt', color: cssVar('--series-1'), points: marketLine },
      { name: 'Your average cost', short: 'avg', color: cssVar('--series-3'), points: avgLine },
    ].filter((l) => l.points.length > 1),
    fmtUsd
  );
  buildTable($('buys-table'), ['Date', 'Source', 'Spent', 'BTC', 'Effective price'],
    [...buys].reverse().map((b) => [
      fmtDate(b.date),
      { chip: b.source },
      fmtUsdFull(b.usd),
      fmtBtc(b.btc),
      fmtUsdFull(b.price),
    ]));
}

function renderTxTable() {
  const cutoff = rangeCutoff();
  const rows = [
    ...state.data.trades.map((t) => ({ ...t, kind: t.type })),
    ...state.data.transfers.map((t) => ({ ...t, kind: t.type })),
  ]
    .filter((t) => new Date(t.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  $('tx-count').textContent = `${rows.length} records`;
  buildTable($('tx-table'), ['Date', 'Source', 'Type', 'BTC', 'USD', 'Price'],
    rows.map((t) => [
      fmtDate(t.date),
      { chip: t.source },
      { cls: 'type-' + t.kind, text: t.kind },
      fmtBtc(t.btc),
      t.usd != null ? fmtUsdFull(t.usd) : '—',
      t.price ? fmtUsdFull(t.price) : '—',
    ]));
}

function renderChrome() {
  const { status, summary, locations } = state.data;
  const names = locations.map((l) => l.name.replace(' (on-chain)', '')).join(', ');
  $('subtitle').textContent =
    `${fmtBtc(summary.currentBtc)}${names ? ' across ' + names : ''}` +
    (status.syncedAt ? ` · synced ${new Date(status.syncedAt).toLocaleString()}` : '');

  const banner = $('banner');
  if (status.demo) {
    banner.replaceChildren();
    const strong = el('strong', null, 'Demo data. ');
    banner.appendChild(strong);
    banner.appendChild(document.createTextNode(
      'This is a sample portfolio so you can explore the dashboard. To connect your real accounts, copy .env.example to .env and follow the API-key walkthrough in the README (about 5 minutes), then restart the server.'));
    banner.hidden = false;
  } else banner.hidden = true;

  const footer = $('footer');
  footer.replaceChildren();
  const notes = [];
  if (summary.dedupedRecords > 0) notes.push(`${summary.dedupedRecords} duplicate record(s) merged across sources.`);
  if (summary.unmatchedSellBtc > 1e-8) notes.push(`⚠ Warning: ${fmtBtc(summary.unmatchedSellBtc)} sold without a matching buy record — cost basis may be incomplete. Import older history via CSV.`);
  notes.push('Cost basis is FIFO and fee-inclusive. Transfers to your own wallet (Phantom) are not sales and don\'t affect basis. Not tax advice.');
  for (const n of notes) footer.appendChild(el('p', n.startsWith('⚠') ? 'err' : null, n));
  for (const errText of status.errors || []) footer.appendChild(el('p', 'err', '⚠ ' + errText));
}

function renderAll() {
  if (!state.data) return;
  renderChrome();
  renderTiles();
  renderLocations();
  renderActivity();
  renderValueChart();
  renderBuysChart();
  renderTxTable();
}

// ── Data loading & controls ─────────────────────────────────────────────
async function load() {
  $('main').classList.add('refetching');
  try {
    const res = await fetch('/api/dashboard');
    if (res.status === 401) { location.href = '/login'; return; }
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.data = data;
    renderAll();
  } catch (err) {
    $('subtitle').textContent = 'Failed to load: ' + err.message;
  } finally {
    $('main').classList.remove('refetching');
  }
}

$('sync-btn').addEventListener('click', async () => {
  const btn = $('sync-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  $('main').classList.add('refetching');
  try {
    await fetch('/api/sync', { method: 'POST' });
    await load();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
    $('main').classList.remove('refetching');
  }
});

$('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login';
});

$('theme-btn').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  renderAll(); // charts read resolved CSS vars
});
if (localStorage.getItem('theme')) document.documentElement.dataset.theme = localStorage.getItem('theme');

$('range-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  state.range = btn.dataset.range;
  document.querySelectorAll('#range-buttons button').forEach((b) => b.classList.toggle('active', b === btn));
  renderValueChart();
  renderBuysChart();
  renderTxTable();
});

document.querySelectorAll('.view-toggle').forEach((toggle) => {
  toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    const key = toggle.dataset.for;
    state.views[key] = btn.dataset.view;
    toggle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    $(key + '-chart').hidden = btn.dataset.view !== 'chart';
    $(key + '-table').hidden = btn.dataset.view !== 'table';
  });
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { renderValueChart(); renderBuysChart(); }, 150);
});

load();
