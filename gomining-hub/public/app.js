import { columnChart, lineChart, splitBar } from './charts.js';
import { findListedPrice, investmentPlan, listedPricePerTh, portfolio, rewardsBreakdown, upgradeAdvisor } from '/lib/calc.js';

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

const state = { market: null, history: [], efficiency: Number(store.get('efficiency')) || 15, historyMetric: store.get('historyMetric') || 'sats' };
const compact = (value, digits = 1) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: digits }).format(value);
const pct = (value, digits = 2) => `${value > 0 ? '+' : ''}${num(value, digits)}%`;

// Writes a signed percentage (arrow shows direction, color shows good or bad) then a label.
function setDelta(el, label, value, { upIsGood = true } = {}) {
  el.replaceChildren();
  if (value === null || value === undefined) { el.textContent = label || '\u00a0'; return; }
  const delta = document.createElement('span');
  if (value !== 0) {
    const good = (value > 0) === upIsGood;
    delta.className = `${value > 0 ? 'arrow-up' : 'arrow-down'} ${good ? 'good' : 'bad'}`;
  }
  delta.textContent = `${num(Math.abs(value), 2)}%`;
  el.append(delta, document.createTextNode(label ? ` ${label}` : ''));
}

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
    // GoMining settles the payout once a day: say which payout is shown and when it was checked.
    setSource('live', `Payout ${new Date(m.income.payoutDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · checked ${time(m.fetchedAt)}`);
    showNotice('');
  } else {
    setSource('sample', 'Sample data');
    // Only GoMining's own parts fall back to sample data; network and prices just show as unavailable.
    const parts = Object.keys(m.errors).filter((part) => ['income', 'presets', 'upgrades'].includes(part)).join(', ');
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

  renderKpis(b);
}

function renderKpis(b) {
  const m = state.market;
  const income = m.income;
  const btc = m.prices?.btc;
  $('k-btc').textContent = usd(btc?.usd ?? income.btcPriceUsd, 0);
  if (btc) setDelta($('k-btc-meta'), '24h', btc.change24hPct);
  else $('k-btc-meta').textContent = `GoMining payout rate, ${day(income.payoutDate)}`;

  const gmt = m.prices?.gomining;
  $('k-gmt').textContent = gmt ? usd(gmt.usd, gmt.usd < 1 ? 4 : 2) : '—';
  if (gmt) setDelta($('k-gmt-meta'), gmt.marketCapUsd ? `24h · cap $${compact(gmt.marketCapUsd)}` : '24h', gmt.change24hPct);
  else $('k-gmt-meta').textContent = 'Price feed unavailable';

  $('k-hashprice').textContent = `${usd(m.hashprice.usdPerPhDay, 2)}`;
  $('k-hashprice-meta').textContent = `per PH per day · ${num(m.hashprice.satsPerPhDay)} sats`;

  $('k-gross').textContent = usdSmart(income.rewardUsdPerThDay);
  if (m.payoutVsAveragePct !== null) setDelta($('k-gross-meta'), `vs 365-day avg · ${sats(income.rewardSatsPerThDay)}`, m.payoutVsAveragePct);
  else $('k-gross-meta').textContent = `${sats(income.rewardSatsPerThDay)} per day`;

  const net = m.network;
  $('k-hashrate').textContent = net?.hashrateEhs ? `${num(net.hashrateEhs, 0)} EH/s` : '—';
  $('k-hashrate-meta').textContent = net?.blockHeight ? `Block ${num(net.blockHeight)}` : 'Network feed unavailable';
  $('k-diff').textContent = net?.difficultyT ? `${num(net.difficultyT, 1)} T` : '—';
  if (net?.nextAdjustment?.estimatedChangePct !== null && net?.nextAdjustment?.estimatedChangePct !== undefined) {
    // Rising difficulty means less BTC per TH, so up is bad here.
    setDelta($('k-diff-meta'), 'next adjustment', net.nextAdjustment.estimatedChangePct, { upIsGood: false });
  } else $('k-diff-meta').textContent = '\u00a0';

  $('k-kwh').textContent = `${usd(income.electricityKwhPriceUsd, 3)}/kWh`;
  $('k-kwh-meta').textContent = `${usdSmart(b.electricityUsd)} per TH per day at ${state.efficiency} W/TH`;
  $('k-service').textContent = usdSmart(income.serviceUsdPerThDay);
  $('k-service-meta').textContent = `per day · break-even at ${num(m.curve.breakEvenEfficiencyWth, 1)} W/TH`;
}

function renderNetwork() {
  const body = $('network-body');
  const net = state.market.network;
  if (!net) {
    body.replaceChildren(empty(`Bitcoin network data is unavailable right now${state.market.errors.network ? ` (${state.market.errors.network})` : ''}. It comes back by itself.`));
    return;
  }
  const adj = net.nextAdjustment;
  const frag = document.createDocumentFragment();
  const top = document.createElement('div');
  const change = document.createElement('p');
  change.className = 'big-number';
  change.textContent = adj.estimatedChangePct === null ? '—' : pct(adj.estimatedChangePct);
  const sub = document.createElement('p');
  sub.className = 'card-sub';
  sub.textContent = adj.estimatedChangePct > 0 ? 'Expected difficulty rise: slightly fewer sats per TH after it' : 'Expected difficulty drop: slightly more sats per TH after it';
  top.append(change, sub);
  const meter = document.createElement('div');
  meter.className = 'meter';
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', String(adj.progressPct ?? 0));
  meter.setAttribute('aria-label', 'Progress through the current difficulty period');
  const fill = document.createElement('span');
  fill.style.width = `${Math.min(100, Math.max(0, adj.progressPct ?? 0))}%`;
  meter.appendChild(fill);
  const stats = document.createElement('dl');
  stats.className = 'stat-grid';
  const add = (label, value) => {
    const row = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value;
    row.append(dt, dd);
    stats.appendChild(row);
  };
  add('Period progress', adj.progressPct === null ? '—' : `${num(adj.progressPct, 1)}%`);
  add('Blocks to go', adj.remainingBlocks === null ? '—' : num(adj.remainingBlocks));
  add('Expected on', adj.estimatedDate ? day(adj.estimatedDate) : '—');
  add('Previous change', adj.previousChangePct === null ? '—' : pct(adj.previousChangePct));
  add('Avg block time', adj.avgBlockMinutes === null ? '—' : `${num(adj.avgBlockMinutes, 1)} min`);
  add('Block height', net.blockHeight ? num(net.blockHeight) : '—');
  add('Network hashrate', net.hashrateEhs ? `${num(net.hashrateEhs, 1)} EH/s` : '—');
  add('Fees (fast / 1h / eco)', net.feesSatVb.fastest === null ? '—' : `${net.feesSatVb.fastest} / ${net.feesSatVb.hour} / ${net.feesSatVb.economy} sat/vB`);
  frag.append(top, meter, stats);
  body.replaceChildren(frag);
}

function renderRoi() {
  const rows = [...state.market.minerRoi].sort((a, b) => (a.paybackDays ?? Infinity) - (b.paybackDays ?? Infinity));
  const best = state.market.fastestPayback;
  const banner = $('roi-best');
  banner.hidden = !best;
  if (best) {
    banner.replaceChildren();
    const label = document.createElement('strong');
    label.textContent = 'Fastest payback';
    banner.append(label, document.createTextNode(` ${num(best.powerTh, best.powerTh < 1 ? 2 : 0)} TH at ${best.efficiencyWth} W/TH for ${usd(best.priceUsd, 2)}: ${num(best.paybackDays)} days · ${num(best.annualReturnPct, 1)}% a year`));
  }
  table($('roi-table'), ['Size (TH)', 'W/TH', 'Price', 'Per TH', 'Net / day', 'Sats / day', 'Payback', 'Per year'], rows.map((r) => [
    num(r.powerTh, r.powerTh < 1 ? 2 : 0), r.efficiencyWth, usd(r.priceUsd, 2), usd(r.priceUsdPerTh, 2), usdSmart(r.netUsdDay), num(r.netSatsDay),
    r.paybackDays ? `${num(r.paybackDays)} d` : 'never', `${num(r.annualReturnPct, 1)}%`,
  ]), { highlight: (i) => best && rows[i] === best });
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

const HISTORY_METRICS = [
  { id: 'sats', label: 'Sats / TH', key: 'rewardSatsPerThDay', format: (v) => sats(v), tick },
  { id: 'hashprice', label: 'Hashprice', key: 'hashpriceUsdPerPhDay', format: (v) => `${usd(v, 2)}/PH`, tick: (v) => usd(v, 0) },
  { id: 'btc', label: 'BTC price', key: 'btcPriceUsd', format: (v) => usd(v, 0), tick: (v) => `$${compact(v)}` },
  { id: 'hashrate', label: 'Hashrate', key: 'hashrateEhs', format: (v) => `${num(v, 0)} EH/s`, tick },
  { id: 'gmt', label: 'GOMINING', key: 'gominingUsd', format: (v) => usd(v, 4), tick: (v) => usd(v, 2) },
];

function renderHistory() {
  const seg = $('history-metric');
  if (!seg.childElementCount) {
    for (const metric of HISTORY_METRICS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.dataset.metric = metric.id;
      button.textContent = metric.label;
      button.addEventListener('click', () => {
        state.historyMetric = metric.id;
        store.set('historyMetric', metric.id);
        renderHistory();
      });
      seg.appendChild(button);
    }
  }
  const metric = HISTORY_METRICS.find((m) => m.id === state.historyMetric) ?? HISTORY_METRICS[0];
  for (const button of seg.children) button.setAttribute('aria-checked', String(button.dataset.metric === metric.id));

  const rows = state.history.filter((row) => typeof row[metric.key] === 'number');
  $('history-sub').textContent = `${metric.label}, recorded each day the dashboard fetches live data`;
  if (rows.length < 2) {
    $('history-chart').replaceChildren(empty(rows.length
      ? `1 day recorded (${day(rows[0].date)}). The chart draws itself from the second day.`
      : 'Nothing recorded for this metric yet. One point is saved per payout day.'));
  } else {
    lineChart($('history-chart'), {
      xLabels: rows.map((row) => new Date(row.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })),
      series: [{ name: metric.label, color: SERIES[0], values: rows.map((row) => row[metric.key]) }],
      format: metric.format,
      tickFormat: metric.tick,
      xTooltip: (_label, i) => day(rows[i].date),
    });
  }
  table($('history-table'), ['Date', 'Sats/TH', 'Hashprice', 'BTC price', 'Hashrate', 'GOMINING'], state.history.map((row) => [
    day(row.date), num(row.rewardSatsPerThDay, 1), row.hashpriceUsdPerPhDay ? usd(row.hashpriceUsdPerPhDay, 2) : '—', usd(row.btcPriceUsd, 0),
    row.hashrateEhs ? `${num(row.hashrateEhs, 0)} EH/s` : '—', row.gominingUsd ? usd(row.gominingUsd, 4) : '—',
  ]));
}

function renderAdvisor() {
  // Savings shrink with the maintenance discount entered in the calculator.
  const discountPct = Number($('gc-form').elements.discountPct.value) || 0;
  const kwhPriceUsd = Number($('gc-form').elements.kwhPriceUsd.value) || undefined;
  const steps = upgradeAdvisor(state.market.income, state.market.upgrades, { discountPct, kwhPriceUsd });
  $('advisor-sub').textContent = `Is one W/TH less worth it? Cost per TH against electricity saved, after your ${num(discountPct, 1)}% maintenance discount (set in the calculator)`;
  if (!steps.length) {
    $('upgrade-table').replaceChildren(empty('No upgrade prices available.'));
    return;
  }
  table($('upgrade-table'), ['Step', 'Cost per TH', 'Saves per TH / day', 'Pays back in'], steps.map((step) => [
    `${step.fromWth} → ${step.toWth} W/TH`, usd(step.costUsdPerTh, 3), usdSmart(step.savingUsdPerThDay), step.paybackDays ? `${num(step.paybackDays)} days` : 'never',
  ]));
}

function empty(message) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = message;
  return div;
}

function table(container, headers, rows, { highlight } = {}) {
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
  rows.forEach((cells, index) => {
    const tr = body.insertRow();
    if (highlight?.(index)) tr.className = 'highlight';
    cells.forEach((value, i) => {
      const td = tr.insertCell();
      td.textContent = value;
      if (i > 0) td.className = 'num';
    });
  });
  container.replaceChildren(t);
}

function renderAll() {
  if (!state.market) return;
  renderEfficiencyOptions();
  renderCalculator();
  renderMyMiners();
  renderHero();
  renderSplit();
  renderCurve();
  renderNetwork();
  renderRoi();
  renderPrices();
  renderAdvisor();
  renderHistory();
}

// ---------- Goose Calculator ----------
state.gcMode = store.get('gcMode') === 'plan' ? 'plan' : 'rewards';
const PERIOD_LABELS = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };

function setMode(mode) {
  state.gcMode = mode;
  store.set('gcMode', mode);
  for (const button of $('gc-mode').children) button.setAttribute('aria-checked', String(button.dataset.mode === mode));
  for (const field of document.querySelectorAll('#gc-form [data-only]')) field.hidden = field.dataset.only !== mode;
  $('gc-rewards').hidden = mode !== 'rewards';
  $('gc-plan').hidden = mode !== 'plan';
  $('gc-form').elements.powerTh.closest('label').firstElementChild.textContent = mode === 'plan' ? 'Starting power (TH)' : 'Power (TH)';
  renderCalculator();
}

function formValues() {
  const f = $('gc-form').elements;
  const n = (name) => (f[name].value === '' ? undefined : Number(f[name].value));
  return {
    powerTh: n('powerTh') ?? 0,
    efficiencyWth: n('efficiencyWth'),
    discountPct: n('discountPct') ?? 0,
    priceUsd: n('priceUsd'),
    monthlyUsd: n('monthlyUsd') ?? 0,
    months: n('months') ?? 12,
    pricePerThUsd: n('pricePerThUsd'),
    reinvestPricePerThUsd: n('reinvestPricePerThUsd'),
    reinvestBonusPct: n('reinvestBonusPct') ?? 0,
    kwhPriceUsd: n('kwhPriceUsd'),
    reinvest: f.reinvest.checked,
    useAverageReward: f.average.checked,
  };
}

function legendInto(container, items) {
  container.replaceChildren();
  for (const [name, color] of items) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const key = document.createElement('span');
    key.className = 'legend-key';
    key.style.background = color;
    item.append(key, document.createTextNode(name));
    container.appendChild(item);
  }
}

function renderCalculator() {
  if (!state.market) return;
  // Show the rate an empty electricity box falls back to.
  $('gc-form').elements.kwhPriceUsd.placeholder = `GoMining rate: ${usd(state.market.income.electricityKwhPriceUsd, 3)}`;
  const v = formValues();
  const income = state.market.income;
  const gmt = state.market.prices?.gomining?.usd;
  const basis = v.useAverageReward ? "GoMining's 365-day average payout" : "GoMining's latest daily payout";
  const sample = state.market.sources.income === 'sample' ? ' (sample data)' : '';
  try {
    if (!(v.efficiencyWth > 0)) throw new Error('Enter an efficiency in W/TH.');
    if (state.gcMode === 'rewards') {
      if (!(v.powerTh > 0)) throw new Error('Enter your power in TH.');
      const listed = v.priceUsd ? null : findListedPrice(state.market.presets, v.powerTh, v.efficiencyWth);
      const r = rewardsBreakdown(income, { ...v, priceUsd: v.priceUsd ?? listed ?? undefined, gominingUsd: gmt });
      const d = r.periods.day;
      const m = r.periods.month;
      $('gc-day').textContent = usdSmart(d.netUsd);
      $('gc-day').classList.toggle('neg', d.netUsd < 0);
      $('gc-day-sub').textContent = `${num(d.netSats)} sats${d.netGomining !== null ? ` · ${num(d.netGomining, 2)} GOMINING` : ''}`;
      $('gc-month').textContent = usdSmart(m.netUsd);
      $('gc-month').classList.toggle('neg', m.netUsd < 0);
      $('gc-month-sub').textContent = `${num(m.netBtc, 8)} BTC`;
      $('gc-payback').textContent = r.payback ? (r.payback.days ? `${num(r.payback.days)} d` : 'Never') : '—';
      $('gc-payback-sub').textContent = r.payback
        ? `${num(r.payback.annualReturnPct, 1)}% a year on ${usd(r.payback.priceUsd, 2)}${listed ? ' (listed price)' : ''}`
        : 'Add the price you paid';
      // Rewards are paid in BTC; the GOMINING column is only a conversion at market price, shown when the price feed answered.
      const withGmt = d.netGomining !== null;
      table($('gc-table'), ['Period', 'Gross', 'Electricity', 'Service', 'Discount', 'Net USD', 'Net BTC', 'Net sats', ...(withGmt ? ['≈ in GOMINING*'] : [])],
        Object.entries(r.periods).map(([key, p]) => [
          PERIOD_LABELS[key], usdSmart(p.grossUsd), `−${usdSmart(p.electricityUsd)}`, `−${usdSmart(p.serviceUsd)}`, p.discountUsd ? `+${usdSmart(p.discountUsd)}` : '—',
          usdSmart(p.netUsd), num(p.netBtc, 8), num(p.netSats), ...(withGmt ? [num(p.netGomining, 2)] : []),
        ]));
      $('gc-note').textContent = `${v.powerTh} TH at ${v.efficiencyWth} W/TH, ${num(r.input.discountPct, 1)}% total maintenance discount, electricity ${usd(r.input.kwhPriceUsd, 3)}/kWh, ${basis}${sample}. Rewards are paid in BTC${withGmt ? '; *GOMINING is only a conversion at today\'s market price' : ''}. Rates held constant; BTC price, difficulty and fees will move. Payback depends heavily on these assumptions.`;
    } else {
      const listedPerTh = listedPricePerTh(state.market.presets, v.efficiencyWth);
      const pricePerThUsd = v.pricePerThUsd ?? listedPerTh;
      if (!pricePerThUsd) throw new Error(`GoMining doesn't list miners at ${v.efficiencyWth} W/TH: enter a price per TH.`);
      const plan = investmentPlan(income, {
        startTh: v.powerTh, efficiencyWth: v.efficiencyWth, monthlyUsd: v.monthlyUsd, months: v.months, pricePerThUsd, reinvest: v.reinvest, discountPct: v.discountPct,
        reinvestPricePerThUsd: v.reinvestPricePerThUsd, reinvestBonusPct: v.reinvestBonusPct, kwhPriceUsd: v.kwhPriceUsd, useAverageReward: v.useAverageReward,
      });
      const sum = plan.summary;
      $('gp-th').textContent = `${num(sum.finalTh, 1)} TH`;
      $('gp-th-sub').textContent = `Earning ${usdSmart(sum.monthlyIncomeUsdAtEnd)} a month by then`;
      $('gp-earned').textContent = usdSmart(sum.earnedUsd);
      $('gp-earned-sub').textContent = `${num(sum.earnedBtc, 6)} BTC · invested ${usd(sum.investedUsd, 0)}${sum.reinvestedUsd ? ` · ${usd(sum.reinvestedUsd, 0)} reinvested` : ''}`;
      $('gp-break').textContent = sum.breakEvenMonth ? `Month ${sum.breakEvenMonth}` : 'Not yet';
      $('gp-break-sub').textContent = sum.breakEvenMonth ? 'Total earned passes total invested' : `Not within ${plan.rows.length} months at today's rates`;
      legendInto($('gp-legend'), [['Total earned', SERIES[0]], ['Total invested', SERIES[1]]]);
      lineChart($('gp-chart'), {
        xLabels: plan.rows.map((row) => `M${row.month}`),
        series: [
          { name: 'Earned', color: SERIES[0], values: plan.rows.map((row) => row.earnedUsd) },
          { name: 'Invested', color: SERIES[1], values: plan.rows.map((row) => row.investedUsd) },
        ],
        format: (value) => usd(value, 0),
        tickFormat: (value) => `$${compact(value)}`,
        xTitle: 'Month',
        xTooltip: (_label, i) => `Month ${plan.rows[i].month} · ${num(plan.rows[i].th, 1)} TH`,
        zeroBased: true,
      });
      table($('gp-table'), ['Month', 'TH', 'Net this month', 'Total earned', 'Total invested'],
        plan.rows.map((row) => [row.month, num(row.th, 2), usd(row.netUsdMonth, 2), usd(row.earnedUsd, 2), usd(row.investedUsd, 2)]));
      const reinvestNote = v.reinvest
        ? ` Reinvesting at ${usd(v.reinvestPricePerThUsd || pricePerThUsd, 2)} per TH${v.reinvestPricePerThUsd ? '' : ' (same as new purchases: enter your power-upgrade price for accuracy)'}${v.reinvestBonusPct ? ` with a ${num(v.reinvestBonusPct, 1)}% bonus` : ''}; GoMining's reinvestment eligibility rules aren't checked.`
        : '';
      $('gc-note').textContent = `New purchases at ${usd(pricePerThUsd, 2)} per TH${v.pricePerThUsd ? '' : ' (GoMining new-miner list price)'}, ${v.efficiencyWth} W/TH, ${num(v.discountPct, 1)}% total maintenance discount, ${basis}${sample}.${reinvestNote} A simulation at constant rates, not a forecast.`;
    }
  } catch (error) {
    $('gc-note').textContent = error.message;
  }
}

$('gc-form').addEventListener('input', () => {
  clearTimeout(state.gcTimer);
  state.gcTimer = setTimeout(() => { renderCalculator(); renderAdvisor(); }, 120);
});
$('gc-form').addEventListener('submit', (event) => event.preventDefault());
for (const button of $('gc-mode').children) button.addEventListener('click', () => setMode(button.dataset.mode));

// ---------- My miners (this browser only) ----------
const MINERS_KEY = 'myMiners';
function loadMiners() {
  try {
    const list = JSON.parse(store.get(MINERS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((m) => m && m.powerTh > 0 && m.efficiencyWth > 0).slice(0, 200) : [];
  } catch {
    return [];
  }
}
const saveMiners = (list) => store.set(MINERS_KEY, JSON.stringify(list));
$('mm-discount').value = store.get('myDiscount') ?? '0';

function cell(row, text, className) {
  const td = row.insertCell();
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderMyMiners() {
  if (!state.market) return;
  const miners = loadMiners();
  const body = $('mm-body');
  if (!miners.length) {
    body.replaceChildren(empty('Add your miners above to see your own daily sats, monthly income and which upgrades pay off. They stay in this browser only.'));
    return;
  }
  const p = portfolio(state.market.income, miners, { discountPct: Number($('mm-discount').value) || 0, upgrades: state.market.upgrades });
  const t = p.totals;
  const summary = document.createElement('div');
  summary.className = 'mm-summary';
  for (const [label, value, sub] of [
    ['Total power', `${num(t.powerTh, t.powerTh < 10 ? 2 : 1)} TH`, `${t.miners} miner${t.miners === 1 ? '' : 's'}`],
    ['Average efficiency', `${num(t.avgEfficiencyWth, 1)} W/TH`, 'weighted by TH'],
    ['Net per day', `${num(t.netSatsDay)} sats`, usdSmart(t.netUsdDay)],
    ['Net per month', usdSmart(t.netUsdMonth), `${num(t.netBtcMonth, 6)} BTC`],
  ]) {
    const box = document.createElement('div');
    const l = document.createElement('span'); l.className = 'tile-label'; l.textContent = label;
    const v = document.createElement('strong'); v.textContent = value;
    const s = document.createElement('span'); s.className = 'tile-meta'; s.textContent = sub;
    box.append(l, v, s);
    summary.appendChild(box);
  }
  const tableEl = document.createElement('table');
  const head = tableEl.createTHead().insertRow();
  ['Miner', 'TH', 'W/TH', 'Net / day', 'Sats / day', 'Next upgrade', 'Pays back', ''].forEach((label, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    if (i > 0 && i < 7) th.className = 'num';
    head.appendChild(th);
  });
  const tbody = tableEl.createTBody();
  p.rows.forEach((row, index) => {
    const tr = tbody.insertRow();
    cell(tr, row.name || `Miner ${index + 1}`);
    cell(tr, num(row.powerTh, row.powerTh < 10 ? 2 : 1), 'num');
    cell(tr, num(row.efficiencyWth, 1), 'num');
    cell(tr, usdSmart(row.netUsdDay), `num${row.netUsdDay < 0 ? ' neg' : ''}`);
    cell(tr, num(row.netSatsDay), 'num');
    cell(tr, row.upgrade ? `→ ${row.upgrade.toWth} W/TH for ${usd(row.upgrade.costUsd, 2)}` : 'at best level', 'num');
    cell(tr, row.upgrade?.paybackDays ? `${num(row.upgrade.paybackDays)} days` : '—', 'num');
    const actions = tr.insertCell();
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mm-remove';
    remove.title = 'Remove this miner';
    remove.setAttribute('aria-label', `Remove ${row.name || `miner ${index + 1}`}`);
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      const list = loadMiners();
      list.splice(index, 1);
      saveMiners(list);
      renderMyMiners();
    });
    actions.appendChild(remove);
  });
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.appendChild(tableEl);
  body.replaceChildren(summary, wrap);
}

$('mm-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const f = event.target.elements;
  const powerTh = Number(f.powerTh.value);
  const efficiencyWth = Number(f.efficiencyWth.value);
  if (!(powerTh > 0) || !(efficiencyWth > 0)) return;
  const list = loadMiners();
  list.push({ name: f.name.value.trim().slice(0, 40), powerTh, efficiencyWth });
  saveMiners(list);
  event.target.reset();
  f.name.focus();
  renderMyMiners();
});
$('mm-discount').addEventListener('input', () => {
  store.set('myDiscount', $('mm-discount').value);
  renderMyMiners();
});
$('mm-clear').addEventListener('click', () => {
  if (loadMiners().length && confirm('Remove all your saved miners from this browser?')) {
    saveMiners([]);
    renderMyMiners();
  }
});

// ---------- Share a calculation (Discord) ----------
const SHARE_FIELDS = ['powerTh', 'efficiencyWth', 'discountPct', 'kwhPriceUsd', 'priceUsd', 'monthlyUsd', 'months', 'pricePerThUsd', 'reinvestPricePerThUsd', 'reinvestBonusPct'];

// Opening a shared link fills the calculator with the sender's numbers.
function applySharedLink() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (!hash.has('calc')) return;
  const f = $('gc-form').elements;
  for (const name of SHARE_FIELDS) {
    const value = hash.get(name);
    if (value !== null && /^\d+(\.\d+)?$/.test(value)) f[name].value = value;
  }
  f.reinvest.checked = hash.get('reinvest') === '1';
  f.average.checked = hash.get('average') === '1';
  state.gcMode = hash.get('calc') === 'plan' ? 'plan' : 'rewards';
}

function shareLink() {
  const f = $('gc-form').elements;
  const params = new URLSearchParams({ calc: state.gcMode });
  const fields = state.gcMode === 'plan'
    ? ['powerTh', 'efficiencyWth', 'discountPct', 'kwhPriceUsd', 'monthlyUsd', 'months', 'pricePerThUsd', 'reinvestPricePerThUsd', 'reinvestBonusPct']
    : ['powerTh', 'efficiencyWth', 'discountPct', 'kwhPriceUsd', 'priceUsd'];
  for (const name of fields) if (f[name].value !== '') params.set(name, f[name].value);
  if (state.gcMode === 'plan' && f.reinvest.checked) params.set('reinvest', '1');
  if (f.average.checked) params.set('average', '1');
  return `${location.origin}/#${params}`;
}

$('gc-share').addEventListener('click', async () => {
  const link = shareLink();
  const button = $('gc-share');
  try {
    await navigator.clipboard.writeText(link);
    button.textContent = 'Copied! Paste it in Discord';
  } catch {
    window.prompt('Copy this link and paste it in Discord:', link);
    button.textContent = 'Link ready';
  }
  button.classList.add('copied');
  setTimeout(() => {
    button.textContent = 'Copy link for Discord';
    button.classList.remove('copied');
  }, 2500);
});

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

applySharedLink();
setMode(state.gcMode);
load();
