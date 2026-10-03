// Small SVG chart kit for the dashboard. Marks follow one spec: bars <= 24px with a 4px rounded
// data end, 2px lines, >= 8px markers with a surface ring, hairline grid, one y-axis.
// Every chart has a hover/focus tooltip; labels are always set with textContent.

const SVG = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    // Colors are CSS custom properties so they follow the theme; set them as styles, which
    // resolve var() everywhere, rather than presentation attributes.
    if ((key === 'fill' || key === 'stroke') && String(value).startsWith('var(')) node.style[key] = value;
    else node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}

function text(parent, x, y, content, attrs = {}) {
  const node = el('text', { x, y, ...attrs }, parent);
  node.textContent = content;
  return node;
}

// Rounded "nice" tick values covering [min, max].
export function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => span / s <= count + 0.5) ?? 10 * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

// One tooltip per chart container. Values lead, labels follow; rows keyed with a short line.
function tooltip(container) {
  let tip = container.querySelector(':scope > .tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'status');
    container.appendChild(tip);
  }
  return {
    show(x, y, title, rows) {
      tip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'tip-title';
      head.textContent = title;
      tip.appendChild(head);
      for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'tip-row';
        if (row.color) {
          const key = document.createElement('span');
          key.className = 'tip-key';
          key.style.background = row.color;
          line.appendChild(key);
        }
        const value = document.createElement('strong');
        value.textContent = row.value;
        const label = document.createElement('span');
        label.className = 'tip-label';
        label.textContent = row.label;
        line.append(value, label);
        tip.appendChild(line);
      }
      tip.classList.add('on');
      const box = container.getBoundingClientRect();
      const width = tip.offsetWidth;
      const left = Math.min(Math.max(x - width / 2, 4), box.width - width - 4);
      tip.style.transform = `translate(${left}px, ${Math.max(y - tip.offsetHeight - 12, 0)}px)`;
    },
    hide() { tip.classList.remove('on'); },
  };
}

// Path for a bar with a 4px rounded end on the data side and a square end on the baseline.
function barPath(x, width, yBase, yValue) {
  const up = yValue <= yBase;
  const height = Math.abs(yBase - yValue);
  const r = Math.min(4, width / 2, height);
  if (height === 0) return '';
  if (up) {
    return `M${x},${yBase}V${yValue + r}Q${x},${yValue} ${x + r},${yValue}H${x + width - r}Q${x + width},${yValue} ${x + width},${yValue + r}V${yBase}Z`;
  }
  return `M${x},${yBase}V${yValue - r}Q${x},${yValue} ${x + r},${yValue}H${x + width - r}Q${x + width},${yValue} ${x + width},${yValue - r}V${yBase}Z`;
}

function frame(container, height) {
  const width = Math.max(container.clientWidth, 280);
  container.querySelector(':scope > svg')?.remove();
  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'chart-svg' });
  container.prepend(svg);
  return { svg, width };
}

function yAxis(svg, ticks, scale, left, right, format) {
  const axis = el('g', { class: 'axis' }, svg);
  for (const tick of ticks) {
    const y = scale(tick);
    el('line', { x1: left, x2: right, y1: y, y2: y, class: tick === 0 ? 'baseline' : 'grid' }, axis);
    text(axis, left - 8, y + 4, format(tick), { 'text-anchor': 'end', class: 'tick' });
  }
}

/**
 * Column chart for one series. rows: [{ label, value, highlight }]. Optional reference line.
 */
export function columnChart(container, { rows, format, tickFormat = format, xTitle, reference, color = 'var(--s1)', muted = 'var(--s1-soft)', height = 240 }) {
  const { svg, width } = frame(container, height);
  const tip = tooltip(container);
  const m = { top: 22, right: 12, bottom: xTitle ? 44 : 28, left: 56 };
  const values = rows.map((r) => r.value);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const lo = ticks[0];
  const hi = ticks.at(-1);
  const y = (v) => m.top + ((hi - v) / (hi - lo)) * (height - m.top - m.bottom);
  const band = (width - m.left - m.right) / rows.length;
  const barWidth = Math.min(24, band * 0.62);

  yAxis(svg, ticks, y, m.left, width - m.right, tickFormat);

  if (reference) {
    const position = m.left + (reference.index + 0.5) * band;
    el('line', { x1: position, x2: position, y1: m.top - 6, y2: height - m.bottom, class: 'refline' }, svg);
    text(svg, position + 4, m.top - 8, reference.label, { class: 'ref-label' });
  }

  rows.forEach((row, i) => {
    const x = m.left + i * band + (band - barWidth) / 2;
    const group = el('g', { class: 'mark', tabindex: 0, role: 'img', 'aria-label': `${row.label}: ${format(row.value)}` }, svg);
    el('path', { d: barPath(x, barWidth, y(0), y(row.value)), fill: row.highlight ? color : muted }, group);
    el('rect', { x: m.left + i * band, y: m.top, width: band, height: height - m.top - m.bottom, fill: 'transparent' }, group);
    text(svg, x + barWidth / 2, height - m.bottom + 18, row.label, { 'text-anchor': 'middle', class: row.highlight ? 'tick strong' : 'tick' });
    if (row.highlight) {
      const above = row.value >= 0;
      text(svg, x + barWidth / 2, y(row.value) + (above ? -8 : 16), format(row.value), { 'text-anchor': 'middle', class: 'value-label' });
    }
    const show = () => tip.show(x + barWidth / 2, Math.min(y(row.value), y(0)), row.tooltipTitle ?? row.label, row.tooltipRows ?? [{ value: format(row.value), label: '' }]);
    group.addEventListener('pointerenter', show);
    group.addEventListener('focus', show);
    group.addEventListener('pointerleave', tip.hide);
    group.addEventListener('blur', tip.hide);
  });
  if (xTitle) text(svg, m.left + (width - m.left - m.right) / 2, height - 6, xTitle, { 'text-anchor': 'middle', class: 'axis-title' });
}

/**
 * Line chart over a shared categorical x. series: [{ name, color, values: (number|null)[] }].
 * Crosshair snaps to the nearest x and lists every series there; ends carry direct labels.
 */
export function lineChart(container, { xLabels, series, format, tickFormat = format, xTitle, xTooltip = (label) => label, height = 260, zeroBased = false }) {
  const { svg, width } = frame(container, height);
  const tip = tooltip(container);
  const endLabelSpace = series.length > 1 ? 54 : 16;
  const m = { top: 16, right: endLabelSpace, bottom: xTitle ? 44 : 28, left: 56 };
  const all = series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
  const ticks = niceTicks(zeroBased ? 0 : Math.min(...all), Math.max(...all));
  const lo = ticks[0];
  const hi = ticks.at(-1);
  const y = (v) => m.top + ((hi - v) / (hi - lo)) * (height - m.top - m.bottom);
  const step = xLabels.length > 1 ? (width - m.left - m.right) / (xLabels.length - 1) : 0;
  const x = (i) => m.left + i * step;

  yAxis(svg, ticks, y, m.left, width - m.right, tickFormat);

  // Thin out x labels so they never collide.
  const every = Math.max(1, Math.ceil((xLabels.length * 44) / (width - m.left - m.right)));
  // Count from the right so the latest point always gets a label and never collides with another.
  const last = xLabels.length - 1;
  xLabels.forEach((label, i) => {
    if ((last - i) % every === 0) text(svg, x(i), height - m.bottom + 18, label, { 'text-anchor': 'middle', class: 'tick' });
  });
  if (xTitle) text(svg, m.left + (width - m.left - m.right) / 2, height - 6, xTitle, { 'text-anchor': 'middle', class: 'axis-title' });

  for (const s of series) {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
      pen = true;
    });
    el('path', { d, class: 'line', stroke: s.color }, svg);
    const lastIndex = s.values.findLastIndex((v) => v !== null && v !== undefined);
    if (lastIndex >= 0) {
      el('circle', { cx: x(lastIndex), cy: y(s.values[lastIndex]), r: 4, fill: s.color, class: 'dot' }, svg);
      if (series.length > 1) text(svg, x(lastIndex) + 8, y(s.values[lastIndex]) + 4, s.name, { class: 'end-label' });
    }
  }

  const cross = el('line', { y1: m.top, y2: height - m.bottom, class: 'crosshair' }, svg);
  const hoverDots = series.map((s) => el('circle', { r: 4, fill: s.color, class: 'dot hover-dot' }, svg));
  const hit = el('rect', { x: m.left - step / 2, y: m.top, width: width - m.left - m.right + step, height: height - m.top - m.bottom, fill: 'transparent', tabindex: 0, class: 'hit' }, svg);

  let focusIndex = xLabels.length - 1;
  const showAt = (i) => {
    focusIndex = Math.max(0, Math.min(xLabels.length - 1, i));
    cross.setAttribute('x1', x(focusIndex));
    cross.setAttribute('x2', x(focusIndex));
    cross.classList.add('on');
    let top = height;
    series.forEach((s, k) => {
      const v = s.values[focusIndex];
      const dot = hoverDots[k];
      if (v === null || v === undefined) { dot.classList.remove('on'); return; }
      dot.setAttribute('cx', x(focusIndex));
      dot.setAttribute('cy', y(v));
      dot.classList.add('on');
      top = Math.min(top, y(v));
    });
    const rows = series
      .map((s) => ({ color: s.color, value: s.values[focusIndex] === null || s.values[focusIndex] === undefined ? '—' : format(s.values[focusIndex]), label: series.length > 1 ? s.name : '' }));
    tip.show(x(focusIndex), top, xTooltip(xLabels[focusIndex], focusIndex), rows);
  };
  const hide = () => {
    cross.classList.remove('on');
    hoverDots.forEach((dot) => dot.classList.remove('on'));
    tip.hide();
  };
  hit.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    showAt(step ? Math.round((event.clientX - box.left - m.left) / step) : 0);
  });
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => showAt(focusIndex));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') { showAt(focusIndex - 1); event.preventDefault(); }
    if (event.key === 'ArrowRight') { showAt(focusIndex + 1); event.preventDefault(); }
  });
}

/**
 * One horizontal stacked bar (24px) splitting a total into segments, 2px surface gaps between
 * segments, rounded at the data end only. segments: [{ name, value, color }].
 */
export function splitBar(container, { segments, format, total, totalLabel, height = 56 }) {
  const { svg, width } = frame(container, height);
  const tip = tooltip(container);
  const barHeight = 24;
  const top = 16;
  const scaleMax = Math.max(total, segments.reduce((sum, s) => sum + Math.max(s.value, 0), 0));
  const usable = width - 2;
  let cursor = 0;
  const visible = segments.filter((s) => s.value > 0);
  visible.forEach((segment, i) => {
    const w = (segment.value / scaleMax) * usable;
    const gap = i < visible.length - 1 ? 2 : 0;
    const x = cursor;
    const drawn = Math.max(w - gap, 1);
    const last = i === visible.length - 1;
    const group = el('g', { class: 'mark', tabindex: 0, role: 'img', 'aria-label': `${segment.name}: ${format(segment.value)}` }, svg);
    if (last) {
      const r = Math.min(4, drawn / 2);
      el('path', { d: `M${x},${top}H${x + drawn - r}Q${x + drawn},${top} ${x + drawn},${top + r}V${top + barHeight - r}Q${x + drawn},${top + barHeight} ${x + drawn - r},${top + barHeight}H${x}Z`, fill: segment.color }, group);
    } else {
      el('rect', { x, y: top, width: drawn, height: barHeight, fill: segment.color }, group);
    }
    el('rect', { x, y: 0, width: Math.max(w, 1), height, fill: 'transparent' }, group);
    const share = total > 0 ? ` · ${((segment.value / total) * 100).toFixed(1)}% of ${totalLabel}` : '';
    const show = () => tip.show(x + drawn / 2, top, segment.name, [{ color: segment.color, value: format(segment.value), label: share.replace(/^ · /, '') }]);
    group.addEventListener('pointerenter', show);
    group.addEventListener('focus', show);
    group.addEventListener('pointerleave', tip.hide);
    group.addEventListener('blur', tip.hide);
    cursor += w;
  });
  // When costs exceed the payout, mark where the payout ends.
  if (total < scaleMax) {
    const position = (total / scaleMax) * usable;
    el('line', { x1: position, x2: position, y1: top - 8, y2: top + barHeight + 8, class: 'refline' }, svg);
    text(svg, position, top - 10, `${totalLabel} ends`, { 'text-anchor': 'middle', class: 'ref-label' });
  }
}
