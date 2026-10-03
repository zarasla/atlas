// Shared helpers for the dashboard's modules: formatting, small DOM builders, tables and data loading.
// Text always goes in with textContent, never as HTML.

export const $ = (id) => document.getElementById(id);
export const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

// ---------- formatting ----------
export const usd = (value, digits) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const usdSmart = (value) => usd(value, Math.abs(value) < 1 ? 4 : Math.abs(value) < 1000 ? 2 : 0);
export const num = (value, digits = 0) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
// Axis ticks: whole numbers stay whole, 2.5-style steps keep their decimal.
export const tick = (value) => num(value, Number.isInteger(value) ? 0 : 1);
export const sats = (value) => `${num(value, Math.abs(value) < 100 ? 1 : 0)} sats`;
export const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const compact = (value, digits = 1) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: digits }).format(value);
export const pct = (value, digits = 2) => `${value > 0 ? '+' : ''}${num(value, digits)}%`;
export const btcFmt = (value) => `${num(value, Math.abs(value) < 0.01 ? 6 : 4)} BTC`;
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)'];
export const PERIOD_LABELS = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };
// "as of 14:05" when a feed is down and its last good answer is being shown.
export const staleNote = (part) => (part?.stale && part.asOf ? ` · as of ${time(part.asOf)}` : '');

// ---------- DOM ----------
export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
export const bold = (text) => el('b', '', text);

export function empty(message) {
  return el('div', 'empty', message);
}

// Writes a signed percentage (arrow shows direction, color shows good or bad) then a label.
export function setDelta(node, label, value, { upIsGood = true } = {}) {
  node.replaceChildren();
  if (value === null || value === undefined) { node.textContent = label || ' '; return; }
  const delta = document.createElement('span');
  if (value !== 0) {
    const good = (value > 0) === upIsGood;
    delta.className = `${value > 0 ? 'arrow-up' : 'arrow-down'} ${good ? 'good' : 'bad'}`;
  }
  delta.textContent = `${num(Math.abs(value), 2)}%`;
  node.append(delta, document.createTextNode(label ? ` ${label}` : ''));
}

// A table from rows of cell text. Columns after the first are numbers (right-aligned) unless listed
// in `text`. `highlight(i)` marks a row; `onRow(i)` makes rows clickable (and keyboard-activatable).
export function table(container, headers, rows, { highlight, text = [], onRow, cellClass } = {}) {
  const t = document.createElement('table');
  const head = t.createTHead().insertRow();
  headers.forEach((label, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    if (i > 0 && !text.includes(i)) th.className = 'num';
    head.appendChild(th);
  });
  const body = t.createTBody();
  rows.forEach((cells, index) => {
    const tr = body.insertRow();
    const classes = [];
    if (highlight?.(index)) classes.push('highlight');
    if (onRow) {
      classes.push('clickable');
      tr.tabIndex = 0;
      tr.addEventListener('click', () => onRow(index));
      tr.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRow(index); } });
    }
    tr.className = classes.join(' ');
    cells.forEach((value, i) => {
      const td = tr.insertCell();
      td.textContent = value;
      const extra = cellClass?.(index, i);
      td.className = [i > 0 && !text.includes(i) ? 'num' : '', extra ?? ''].filter(Boolean).join(' ');
    });
  });
  container.replaceChildren(t);
}

export function legendInto(container, items) {
  container.replaceChildren();
  for (const [name, color] of items) {
    const item = el('span', 'legend-item');
    const key = el('span', 'legend-key');
    key.style.background = color;
    item.append(key, document.createTextNode(name));
    container.appendChild(item);
  }
}

// A label / big value / small note block, used by the stat strips.
export function stat(label, value, meta) {
  const box = el('div', 'mini-stat');
  box.append(el('p', 'tile-label', label), el('p', 'tile-value', value), el('p', 'tile-meta', meta ?? ' '));
  return box;
}

// ---------- data ----------
export async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

// Reads a number from a form field: undefined when empty.
export const fieldNumber = (form, name) => {
  const value = form.elements[name]?.value;
  return value === undefined || value === '' ? undefined : Number(value);
};
