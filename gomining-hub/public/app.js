import { columnChart, lineChart, splitBar } from './charts.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

// ---------- formatting ----------
const usd = (value, digits) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const usdSmart = (value) => usd(value, Math.abs(value) < 1 ? 4 : Math.abs(value) < 1000 ? 2 : 0);
const num = (value, digits = 0) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
// Axis ticks: whole numbers stay whole, 2.5-style steps keep their decimal.
const tick = (value) => num(value, Number.isInteger(value) ? 0 : 1);
const sats = (value) => `${num(value, Math.abs(value) < 100 ? 1 : 0)} sats`;
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)'];

const state = { market: null, history: [], efficiency: Number(store.get('efficiency')) || 15 };

// ---------- theme ----------
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
}
applyTheme(store.get('theme'));
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  store.set('theme', next);
});

// ---------- data ----------
async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function load({ refresh = false } = {}) {
  $('main').setAttribute('aria-busy', 'true');
  $('refresh').classList.add('spinning');
  try {
    const [market, history] = await Promise.all([getJson(`/api/market${refresh ? '?refresh=1' : ''}`), getJson('/api/history')]);
    state.market = market;
    state.history = history.rows ?? [];
    renderSource();
    renderAll();
    calculate();
  } catch (error) {
    setSource('error', 'Dashboard server unreachable');
    showNotice(`Couldn't load data: ${error.message}. Is the dashboard server running?`);
  } finally {
    $('main').setAttribute('aria-busy', 'false');
    $('refresh').classList.remove('spinning');
  }
}

function setSource(stateName, label) {
  $('source').dataset.state = stateName;
  $('source-text').textContent = label;
}

function showNotice(message) {
  const notice = $('notice');
  notice.textContent = message;
  notice.hidden = !message;
}

function renderSource() {
  const m = state.market;
  if (m.source === 'live') {
    setSource('live', `Live · ${time(m.fetchedAt)}`);
    showNotice('');
  } else {
    setSource('sample', 'Sample data');
    const parts = Object.keys(m.errors).join(', ');
    showNotice(`GoMining's API couldn't be reached (${parts}), so this shows real GoMining figures captured ${day(m.sampleCapturedAt)} instead of today's. Refresh to try again.`);
  }
}

// ---------- rendering ----------
function breakdown(efficiency) {
  const income = state.market.income;
  const electricityUsd = income.electricityUsdPerThPerWthDay * efficiency;
  const netUsd = income.rewardUsdPerThDay - electricityUsd - income.serviceUsdPerThDay;
  return { grossUsd: income.rewardUsdPerThDay, electricityUsd, serviceUsd: income.serviceUsdPerThDay, netUsd, netSats: (netUsd / income.btcPriceUsd) * 1e8 };
}

function renderEfficiencyOptions() {
  const select = $('efficiency');
  if (select.options.length) return;
  for (const row of state.market.curve.rows) {
    const option = document.createElement('option');
    option.value = row.efficiencyWth;
    option.textContent = `${row.efficiencyWth} W/TH`;
    select.appendChild(option);
  }
  if (!state.market.curve.rows.some((row) => row.efficiencyWth === state.efficiency)) state.efficiency = state.market.curve.rows[0].efficiencyWth;
  select.value = state.efficiency;
}

function renderHero() {
  const income = state.market.income;
  const b = breakdown(state.efficiency);
  $('hero-sats').textContent = num(b.netSats, Math.abs(b.netSats) < 100 ? 1 : 0);
  $('hero-sub').textContent = `${usdSmart(b.netUsd)} per TH per day at ${state.efficiency} W/TH · payout of ${day(income.payoutDate)}`;
  const status = $('hero-status');
  status.hidden = b.netUsd >= 0;
  status.textContent = `Fees exceed the payout at ${state.efficiency} W/TH`;

  $('t-btc').textContent = usd(income.btcPriceUsd, 0);
  $('t-date').textContent = `Payout of ${day(income.payoutDate)}`;
  $('t-gross').textContent = usdSmart(income.rewardUsdPerThDay);
  $('t-gross-sats').textContent = `${sats(income.rewardSatsPerThDay)} per day`;
  $('t-kwh').textContent = `${usd(income.electricityKwhPriceUsd, 3)}/kWh`;
  $('t-elec').textContent = `${usdSmart(b.electricityUsd)} per TH per day at ${state.efficiency} W/TH`;
  $('t-service').textContent = usdSmart(income.serviceUsdPerThDay);
}

function renderSplit() {
  const b = breakdown(state.efficiency);
  const parts = [
    { name: 'Your net reward', value: Math.max(b.netUsd, 0), shown: b.netUsd, color: SERIES[0] },
    { name: 'Electricity', value: b.electricityUsd, shown: b.electricityUsd, color: SERIES[1] },
    { name: 'Service fee', value: b.serviceUsd, shown: b.serviceUsd, color: SERIES[2] },
  ];
  $('split-sub').textContent = `Today, per TH per day at ${state.efficiency} W/TH, out of a ${usdSmart(b.grossUsd)} payout`;
  splitBar($('split-chart'), { segments: parts, format: usdSmart, total: b.grossUsd, totalLabel: 'payout' });

  const body = $('split-table').tBodies[0];
  body.replaceChildren();
  for (const part of parts) {
    const row = body.insertRow();
    const name = row.insertCell();
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = part.color;
    name.append(swatch, document.createTextNode(part.name));
    const value = row.insertCell();
    value.className = `num${part.shown < 0 ? ' neg' : ''}`;
    value.textContent = usdSmart(part.shown);
    const share = row.insertCell();
    share.className = 'num';
    share.textContent = `${num((part.shown / b.grossUsd) * 100, 1)}%`;
  }
}

function renderCurve() {
  const { rows, breakEvenEfficiencyWth } = state.market.curve;
  const min = rows[0].efficiencyWth;
  const max = rows.at(-1).efficiencyWth;
  const inRange = breakEvenEfficiencyWth >= min && breakEvenEfficiencyWth <= max;
  $('curve-sub').textContent = `Sats per TH per day at today's payout and fees · break-even at ${num(breakEvenEfficiencyWth, 1)} W/TH`;
  columnChart($('curve-chart'), {
    rows: rows.map((row) => ({
      label: String(row.efficiencyWth),
      value: row.netSats,
      highlight: row.efficiencyWth === state.efficiency,
      tooltipTitle: `${row.efficiencyWth} W/TH`,
      tooltipRows: [
        { value: sats(row.netSats), label: 'net per TH' },
        { value: usdSmart(row.netUsd), label: 'net USD' },
        { value: usdSmart(row.electricityUsd), label: 'electricity' },
      ],
    })),
    format: (v) => num(v, 1),
    tickFormat: tick,
    xTitle: 'Efficiency (W/TH, lower is better)',
    reference: inRange ? { index: breakEvenEfficiencyWth - min, label: 'break-even' } : null,
  });
  table($('curve-table'), ['W/TH', 'Net sats/TH', 'Net USD/TH', 'Electricity USD/TH'], rows.map((row) => [row.efficiencyWth, num(row.netSats, 1), usdSmart(row.netUsd), usdSmart(row.electricityUsd)]));
}

function renderPrices() {
  const presets = state.market.presets;
  const efficiencies = [...new Set(presets.map((row) => row.efficiencyWth))].sort((a, b) => a - b).slice(0, SERIES.length);
  const sizes = [...new Set(presets.filter((row) => efficiencies.includes(row.efficiencyWth)).map((row) => row.powerTh))].sort((a, b) => a - b);
  const series = efficiencies.map((efficiency, i) => ({
    name: `${efficiency} W/TH`,
    color: SERIES[i],
    values: sizes.map((size) => presets.find((row) => row.efficiencyWth === efficiency && row.powerTh === size)?.priceUsdPerTh ?? null),
  }));

  const legend = $('prices-legend');
  legend.replaceChildren();
  if (series.length > 1) {
    for (const s of series) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const key = document.createElement('span');
      key.className = 'legend-key';
      key.style.background = s.color;
      item.append(key, document.createTextNode(s.name));
      legend.appendChild(item);
    }
  }

  if (!sizes.length) {
    $('prices-chart').replaceChildren(empty('No miner prices available.'));
  } else {
    lineChart($('prices-chart'), {
      xLabels: sizes.map((size) => num(size, size < 1 ? 2 : 0)),
      series,
      format: (v) => `${usd(v, 2)}/TH`,
      tickFormat: (v) => usd(v, 0),
      xTitle: 'Miner size (TH)',
      xTooltip: (label) => `${label} TH miner`,
    });
  }
  table($('prices-table'), ['Size (TH)', 'W/TH', 'Price', 'Per TH'], presets.map((row) => [num(row.powerTh, row.powerTh < 1 ? 2 : 0), row.efficiencyWth, usd(row.priceUsd, 2), usd(row.priceUsdPerTh, 2)]));
}

function renderHistory() {
  const rows = state.history;
  if (rows.length < 2) {
    $('history-chart').replaceChildren(empty(rows.length
      ? `1 day recorded (${day(rows[0].date)}). The chart appears once there are two payout days.`
      : 'Nothing recorded yet. While this dashboard runs with live data it saves one point per payout day.'));
  } else {
    lineChart($('history-chart'), {
      xLabels: rows.map((row) => new Date(row.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })),
      series: [{ name: 'Sats per TH', color: SERIES[0], values: rows.map((row) => row.rewardSatsPerThDay) }],
      format: (v) => sats(v),
      tickFormat: tick,
      xTooltip: (_label, i) => day(rows[i].date),
    });
  }
  table($('history-table'), ['Date', 'Sats/TH', 'USD/TH', 'BTC price'], rows.map((row) => [day(row.date), num(row.rewardSatsPerThDay, 1), usdSmart(row.rewardUsdPerThDay), usd(row.btcPriceUsd, 0)]));
}

function renderUpgrades() {
  const { valuationSteps, efficiencyUpgradeSteps } = state.market.upgrades;
  const levels = [...new Set([...valuationSteps, ...efficiencyUpgradeSteps].map((step) => step.toLevelWth))].sort((a, b) => a - b);
  if (!levels.length) {
    $('upgrade-table').replaceChildren(empty('No upgrade prices available.'));
    return;
  }
  table($('upgrade-table'), ['To W/TH', 'Upgrade cost per TH', 'Valuation step per TH'], levels.map((level) => [
    level,
    fmtStep(efficiencyUpgradeSteps.find((step) => step.toLevelWth === level)),
    fmtStep(valuationSteps.find((step) => step.toLevelWth === level)),
  ]));
}

const fmtStep = (step) => (step ? usd(step.priceUsdPerTh, 3) : '—');

function empty(message) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = message;
  return div;
}

function table(container, headers, rows) {
  const t = document.createElement('table');
  const head = t.createTHead().insertRow();
  headers.forEach((label, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    if (i > 0) th.className = 'num';
    head.appendChild(th);
  });
  const body = t.createTBody();
  for (const cells of rows) {
    const tr = body.insertRow();
    cells.forEach((value, i) => {
      const td = tr.insertCell();
      td.textContent = value;
      if (i > 0) td.className = 'num';
    });
  }
  container.replaceChildren(t);
}

function renderAll() {
  if (!state.market) return;
  renderEfficiencyOptions();
  renderHero();
  renderSplit();
  renderCurve();
  renderPrices();
  renderHistory();
  renderUpgrades();
}

// ---------- calculator ----------
let calcTimer;
let calcSeq = 0;
async function calculate() {
  const form = $('calc');
  const data = new FormData(form);
  const params = new URLSearchParams({ powerTh: data.get('powerTh'), efficiencyWth: data.get('efficiencyWth'), days: data.get('days') });
  if (Number(data.get('priceUsd')) > 0) params.set('priceUsd', data.get('priceUsd'));
  if (data.get('average')) params.set('average', '1');
  if (!form.checkValidity()) return;
  const seq = ++calcSeq;
  try {
    const r = await getJson(`/api/earnings?${params}`);
    if (seq !== calcSeq) return;
    $('c-day').textContent = usdSmart(r.perDay.netUsd);
    $('c-day').classList.toggle('neg', r.perDay.netUsd < 0);
    $('c-day-sats').textContent = `${sats(r.perDay.netSats)} · gross ${usdSmart(r.perDay.grossUsd)}`;
    $('c-period-label').textContent = `Net over ${num(r.period.days)} days`;
    $('c-period').textContent = `${usdSmart(r.period.netUsd)} · ${num(r.period.netBtc, 6)} BTC`;
    $('c-fees').textContent = usdSmart(r.period.feesUsd);
    $('c-payback').textContent = r.payback ? (r.payback.days ? `${num(r.payback.days)} days` : 'Never at current rates') : 'Add a price';
    $('c-apr').textContent = r.payback ? `${num(r.payback.annualReturnPct, 1)}%` : '—';
    const priceNote = r.priceSource === 'GoMining listed price' ? `Using GoMining's listed price of ${usd(r.payback.priceUsd, 2)}. ` : '';
    $('c-note').textContent = `${priceNote}${r.input.rewardBasis === 'today' ? "Today's payout" : '365-day average payout'}${r.dataSource === 'sample' ? ' from sample data' : ''}. Excludes fee discounts and future BTC price or difficulty changes.`;
  } catch (error) {
    if (seq === calcSeq) $('c-note').textContent = `Couldn't calculate: ${error.message}`;
  }
}

$('calc').addEventListener('input', () => {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(calculate, 200);
});
$('calc').addEventListener('submit', (event) => event.preventDefault());

// ---------- controls ----------
$('efficiency').addEventListener('change', (event) => {
  state.efficiency = Number(event.target.value);
  store.set('efficiency', String(state.efficiency));
  renderHero();
  renderSplit();
  renderCurve();
});

$('refresh').addEventListener('click', () => load({ refresh: true }));

document.querySelectorAll('[data-table-toggle]').forEach((button) => {
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => {
    const target = $(`${button.dataset.tableToggle}-table`);
    target.hidden = !target.hidden;
    button.setAttribute('aria-pressed', String(!target.hidden));
  });
});

// Charts size to their container, so redraw when the width changes (not the height, which the
// charts themselves change).
let resizeTimer;
let lastWidth = 0;
new ResizeObserver(([entry]) => {
  const width = Math.round(entry.contentRect.width);
  if (width === lastWidth) return;
  lastWidth = width;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderAll, 120);
}).observe($('main'));

load();
