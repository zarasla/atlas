import { columnChart, lineChart, splitBar } from './charts.js';
import { SIMPLE_EARN_ASSETS, VIP_LEVELS, atBtcPrice, simpleEarn, vipStatus, findListedPrice, investmentPlan, listedPricePerTh, maintenanceDiscount, minerWarsClanNet, minerWarsCycle, minerWarsVsSolo, portfolio, rewardsBreakdown, upgradeAdvisor } from '/lib/calc.js';

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

// "as of 14:05" when a feed is down and its last good answer is being shown.
const staleNote = (part) => (part?.stale && part.asOf ? ` · as of ${time(part.asOf)}` : '');

function renderKpis(b) {
  const m = state.market;
  const income = m.income;
  const btc = m.prices?.btc;
  $('k-btc').textContent = usd(btc?.usd ?? income.btcPriceUsd, 0);
  if (btc) setDelta($('k-btc-meta'), `24h${staleNote(m.prices)}`, btc.change24hPct);
  else $('k-btc-meta').textContent = `GoMining payout rate, ${day(income.payoutDate)}`;

  const gmt = m.prices?.gomining;
  $('k-gmt').textContent = gmt ? usd(gmt.usd, gmt.usd < 1 ? 4 : 2) : '—';
  if (gmt) setDelta($('k-gmt-meta'), `${gmt.marketCapUsd ? `24h · cap $${compact(gmt.marketCapUsd)}` : '24h'}${staleNote(m.prices)}`, gmt.change24hPct);
  else $('k-gmt-meta').textContent = 'Price feed unavailable';

  $('k-hashprice').textContent = `${usd(m.hashprice.usdPerPhDay, 2)}`;
  $('k-hashprice-meta').textContent = `per PH per day · ${num(m.hashprice.satsPerPhDay)} sats`;

  $('k-gross').textContent = usdSmart(income.rewardUsdPerThDay);
  if (m.payoutVsAveragePct !== null) setDelta($('k-gross-meta'), `vs 365-day avg · ${sats(income.rewardSatsPerThDay)}`, m.payoutVsAveragePct);
  else $('k-gross-meta').textContent = `${sats(income.rewardSatsPerThDay)} per day`;

  const net = m.network;
  $('k-hashrate').textContent = net?.hashrateEhs ? `${num(net.hashrateEhs, 0)} EH/s` : '—';
  $('k-hashrate-meta').textContent = net?.blockHeight ? `Block ${num(net.blockHeight)}${staleNote(net)}` : 'Network feed unavailable';
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
  const early = adj.progressPct !== null && adj.progressPct < 25 ? ' (early estimate: it firms up as the period goes on)' : '';
  sub.textContent = adj.estimatedChangePct === null || adj.estimatedChangePct === 0 ? 'No change expected yet'
    : adj.estimatedChangePct > 0 ? `Expected difficulty rise: slightly fewer sats per TH after it${early}` : `Expected difficulty drop: slightly more sats per TH after it${early}`;
  top.append(change, sub);
  const impact = state.market.outlook?.difficulty;
  if (impact) {
    const line = document.createElement('p');
    line.className = 'impact';
    const powerTh = Number($('gc-form').elements.powerTh.value) || 0;
    const perDay = powerTh > 0 ? ` · your ${num(powerTh, powerTh < 10 ? 1 : 0)} TH: ` : '';
    line.append('Your payout: ', bold(`${num(impact.satsPerThNow, 1)} → ${num(impact.satsPerThAfter, 1)} sats per TH`), ` (${pct(impact.payoutChangePct)})`);
    if (perDay) line.append(perDay, bold(`${impact.satsPerThAfter >= impact.satsPerThNow ? '+' : '−'}${num(Math.abs((impact.satsPerThAfter - impact.satsPerThNow) * powerTh), 0)} sats/day`));
    top.appendChild(line);
  }
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

const bold = (text) => { const b = document.createElement('b'); b.textContent = text; return b; };
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

// ---------- Outlook ----------
function renderOutlook() {
  const outlook = state.market.outlook ?? {};
  renderBreakEven(outlook.breakEven);
  renderHalving(outlook.halving);
  renderFearGreed(outlook.sentiment);
}

function renderBreakEven(be) {
  const body = $('be-body');
  if (!be?.rows?.length) { body.replaceChildren(empty('Break-even prices need GoMining payout data.')); return; }
  const btc = be.btcPriceUsd;
  const selected = be.rows.find((row) => row.efficiencyWth === Math.round(state.efficiency)) ?? be.rows[0];
  const head = el('div', 'be-head');
  const big = el('p', 'big-number', usd(selected.breakEvenBtcUsd, 0));
  big.appendChild(el('small', '', `at ${selected.efficiencyWth} W/TH`));
  head.appendChild(big);
  const sub = el('p', 'card-sub');
  const above = selected.headroomPct;
  const word = el('span', above >= 0 ? 'good' : 'bad', `${num(Math.abs(above), 0)}% ${above >= 0 ? 'above' : 'below'}`);
  sub.append('BTC is ', word, ` break-even (${usd(btc, 0)}, the rate GoMining used for the ${day(state.market.income.payoutDate)} payout; at today's difficulty, pre-halving)`);
  const scale = Math.max(btc, ...be.rows.map((row) => row.breakEvenBtcUsd)) * 1.08;
  const list = el('div', 'be-list');
  list.setAttribute('role', 'list');
  for (const row of be.rows) {
    const line = el('div', `be-row${row === selected ? ' sel' : ''}${row.breakEvenBtcUsd > btc ? ' over' : ''}`);
    line.setAttribute('role', 'listitem');
    const track = el('div', 'be-track');
    const fill = el('span', 'be-fill');
    fill.style.width = `${(row.breakEvenBtcUsd / scale) * 100}%`;
    track.appendChild(fill);
    line.append(el('span', 'be-w', `${row.efficiencyWth} W/TH`), track, el('span', 'be-val', usd(row.breakEvenBtcUsd, 0)));
    list.appendChild(line);
  }
  const now = el('div', 'be-now');
  now.style.left = `calc(var(--label) + 10px + (100% - var(--label) - var(--value) - 20px) * ${btc / scale})`;
  now.appendChild(el('span', '', `GoMining rate ${usd(btc, 0)}`));
  now.setAttribute('aria-hidden', 'true');
  list.appendChild(now);
  body.replaceChildren(head, sub, list);
}

function renderHalving(h) {
  const body = $('hv-body');
  if (!h) { body.replaceChildren(empty('Block height is unavailable right now (mempool.space).')); return; }
  $('hv-sub').textContent = `Block reward halves at block ${num(h.nextHalvingHeight)}`;
  const big = el('p', 'big-number', `~${num(h.daysLeft)} days`);
  const meter = el('div', 'meter');
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-label', 'Progress to the next halving');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', String(h.progressPct));
  const fill = el('span');
  fill.style.width = `${h.progressPct}%`;
  meter.appendChild(fill);
  const mini = el('p', 'mini');
  const est = new Date(h.estimatedDate).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  const group = (...parts) => { const span = el('span'); span.append(...parts); return span; };
  mini.append(group(bold(num(h.blocksLeft)), ' blocks to go'), group('est. ', bold(est)));
  const after = el('p', 'impact');
  after.append(`Reward ${h.subsidyBtcNow} → ${h.subsidyBtcAfter} BTC per block. At today's difficulty that's about `, bold(`${num(h.satsPerThAfter ?? 0, 1)} sats/TH`), ' a day.');
  const note = el('p', 'fine', 'Counted at 10-minute blocks. The rest of this site uses today\'s pre-halving payout: what BTC\'s price does after the halving can\'t be predicted, so it isn\'t modelled.');
  body.replaceChildren(big, meter, mini, after, note);
}

function renderFearGreed(fg) {
  const body = $('fg-body');
  if (!fg) { body.replaceChildren(empty('Fear & Greed is unavailable right now.')); return; }
  const big = el('p', 'big-number', String(fg.value));
  big.appendChild(el('small', '', fg.label));
  const scaleBar = el('div', 'fg-scale');
  scaleBar.setAttribute('role', 'meter');
  scaleBar.setAttribute('aria-label', `Fear and Greed ${fg.value} of 100, ${fg.label}`);
  scaleBar.setAttribute('aria-valuemin', '0');
  scaleBar.setAttribute('aria-valuemax', '100');
  scaleBar.setAttribute('aria-valuenow', String(fg.value));
  const mark = el('span', 'fg-mark');
  mark.style.left = `${Math.min(100, Math.max(0, fg.value))}%`;
  scaleBar.appendChild(mark);
  const legend = el('div', 'fg-legend');
  legend.append(el('span', '', 'Extreme fear'), el('span', '', 'Neutral'), el('span', '', 'Extreme greed'));
  const mini = el('p', 'mini');
  const group = (...parts) => { const span = el('span'); span.append(...parts); return span; };
  if (fg.yesterday !== null) mini.append(group('Yesterday ', bold(String(fg.yesterday))));
  if (fg.lastWeek !== null) mini.append(group('Last week ', bold(String(fg.lastWeek))));
  body.replaceChildren(big, scaleBar, legend, mini);
}

// ---------- Discount builder ----------
function renderBuilder() {
  const out = $('db-out');
  if (!state.market) return;
  const f = $('db-form').elements;
  const v = formValues();
  // The ticker's price is a fallback when the market reading has none.
  const gmt = state.market.prices?.gomining?.usd ?? state.ticker?.gomining?.priceUsd;
  try {
    if (!(v.powerTh > 0) || !(v.efficiencyWth > 0)) throw new Error('Enter your power and efficiency in the calculator above.');
    const d = maintenanceDiscount(state.market.income, {
      powerTh: v.powerTh, efficiencyWth: v.efficiencyWth, kwhPriceUsd: v.kwhPriceUsd, gominingUsd: gmt,
      gominingHeld: Number(f.gominingHeld.value) || 0, vipLevel: f.vipLevel.value, serviceButtonDays: Number(f.serviceButtonDays.value) || 0, miningMode: f.miningMode.checked,
    });
    store.set('dbVip', f.vipLevel.value);
    state.builtDiscount = d.totalPct;
    state.builtBonus = d.reinvestBonusPct;
    const total = el('span', 'db-total', `${num(d.totalPct, 1)}%`);
    const parts = el('span');
    parts.append('= ', bold(`${d.tokenPct}%`), ' GOMINING + ', bold(`${num(d.vipPct, 1)}%`), ' VIP + ', bold(`${num(d.serviceButtonPct, 1)}%`), ' Service Button');
    if (d.miningModePct) parts.append(' + ', bold(`${num(d.miningModePct, 1)}%`), ' Mining mode');
    const cover = el('span');
    const next = el('span');
    if (!gmt) {
      cover.append('The GOMINING price is unavailable for a moment, so the GOMINING part counts as 0% until it\'s back. The other parts are included.');
    } else {
      cover.append('Your GOMINING covers ', bold(`${num(d.coverageDays)} days`), ` of maintenance (${usdSmart(d.dailyMaintenanceUsd)}/day at ${usd(gmt, 4)} per GOMINING).`);
    }
    if (!gmt) { /* nothing to suggest without a price */ } else if (d.next) next.append('Next step (', bold(`${d.next.pct}%`), '): hold ', bold(`${num(d.next.gominingNeeded)} GOMINING`), '. Full 20%: ', bold(`${num(d.gominingForMax)} GOMINING`), '.');
    else next.append('You have the full 20% GOMINING discount.');
    const bonus = el('span');
    if (d.reinvestBonusPct) bonus.append(`${d.vipLevel} also gives `, bold(`+${d.reinvestBonusPct}% TH`), ' when reinvesting (used in the Investment plan).');
    out.replaceChildren(total, parts, cover, next, bonus);
    $('db-apply').disabled = false;
  } catch (error) {
    state.builtDiscount = null;
    out.replaceChildren(el('span', '', error.message));
    $('db-apply').disabled = true;
  }
}

// ---------- VIP level and Simple Earn ----------
const big = (n) => (n >= 1e6 ? `${num(n / 1e6, n % 1e6 ? 1 : 0)}M` : n >= 1e3 ? `${num(n / 1e3, n % 1e3 ? 1 : 0)}K` : num(n, 0));

function renderVip({ sync = false } = {}) {
  const f = $('vip-form').elements;
  const status = vipStatus({ powerTh: Number(f.powerTh.value), veGomining: Number(f.veGomining.value), referralUsd: Number(f.referralUsd.value) });
  const lvl = status.level;
  const head = el('div', 'vip-head');
  head.append(el('span', 'vip-name', lvl.name), el('span', 'card-sub', status.reachedBy.length ? `reached by ${status.reachedBy.map((k) => ({ th: 'mining power', veGomining: 'veGOMINING', referralUsd: 'referrals' })[k]).join(' and ')}` : 'the starting level'));
  const perks = el('p', 'vip-perks');
  const perk = (label, value) => { const span = el('span'); span.append(`${label} `, bold(value)); return span; };
  perks.append(perk('Maintenance discount', `${num(lvl.discountPct, 1)}%`), perk('Simple Earn', `×${lvl.simpleEarnMultiplier}`), perk('Reinvest bonus', lvl.reinvestBonusPct ? `+${lvl.reinvestBonusPct}% TH` : '—'), perk('Referral royalty', `${lvl.royaltyPct}%`));
  const nodes = [head, perks];
  if (status.next) {
    const n = status.next;
    const box = el('div', 'vip-next');
    const title = el('span');
    title.append('Next: ', el('strong', '', n.level.name), ' — any one of:');
    const needs = el('span');
    needs.append(bold(`+${big(n.needs.th)} TH`), ' or ', bold(`+${big(n.needs.veGomining)} veGOMINING`), ' or ', bold(`+$${big(n.needs.referralUsd)} referrals`));
    const gains = el('span');
    const g = n.gains;
    const parts = [g.discountPct ? `+${num(g.discountPct, 1)}% discount` : null, g.simpleEarnMultiplier ? `Simple Earn ×${n.level.simpleEarnMultiplier}` : null, g.reinvestBonusPct ? `reinvest bonus +${n.level.reinvestBonusPct}%` : null, g.royaltyPct ? `royalty ${n.level.royaltyPct}%` : null].filter(Boolean);
    gains.textContent = `Gives you ${parts.join(', ')}.`;
    box.append(title, needs, gains);
    nodes.push(box);
  } else {
    nodes.push(el('p', 'vip-next', 'Elite is the top level.'));
  }
  $('vip-out').replaceChildren(...nodes);
  table($('vip-table'), ['Level', 'TH', 'veGOMINING', 'Referrals', 'Discount', 'Simple Earn', 'Reinvest', 'Royalty'],
    VIP_LEVELS.map((r) => [r.name, big(r.th), big(r.veGomining), `$${big(r.referralUsd)}`, `${num(r.discountPct, 1)}%`, `×${r.simpleEarnMultiplier}`, r.reinvestBonusPct ? `+${r.reinvestBonusPct}%` : '—', `${r.royaltyPct}%`]),
    { highlight: (i) => VIP_LEVELS[i] === lvl });
  // Editing the VIP card carries the level into the discount builder and Simple Earn.
  if (sync) {
    $('db-vip').value = lvl.name;
    $('se-vip').value = lvl.name;
    store.set('dbVip', lvl.name);
    renderBuilder();
    renderEarn();
  }
}

function renderEarn() {
  const f = $('se-form').elements;
  const out = $('se-out');
  const btcUsd = state.ticker?.btc?.priceUsd ?? state.market?.prices?.btc?.usd ?? state.market?.income?.btcPriceUsd;
  const asset = f.asset.value;
  const assetPriceUsd = asset === 'BTC' ? btcUsd : asset === 'BNB' ? state.ticker?.coins?.find((c) => c.symbol === 'BNB')?.priceUsd : 1;
  try {
    const r = simpleEarn({ amount: Number(f.amount.value), assetPriceUsd, aprPct: Number(f.aprPct.value), vipLevel: f.vipLevel.value, btcPriceUsd: btcUsd });
    const head = el('div', 'se-head');
    const col = (label, value, sub) => { const box = el('div'); box.append(el('p', 'eyebrow', label), el('p', 'calc-big', value), el('p', 'calc-sub', sub)); return box; };
    head.append(
      col('Your APR', `${num(r.effectiveAprPct, 2)}%`, `${num(r.baseAprPct, 2)}% × ${r.multiplier} (${r.vipLevel})`),
      col('Per month', `${num(r.periods.month.sats)} sats`, `≈ ${usdSmart(r.periods.month.usd)} on ${usdSmart(r.valueUsd)}`),
    );
    const wrap = el('div', 'table-wrap');
    out.replaceChildren(head, wrap);
    table(wrap, ['Period', 'BTC', 'Sats', 'USD'], Object.entries(r.periods).map(([k, p]) => [PERIOD_LABELS[k], num(p.btc, 8), num(p.sats), usdSmart(p.usd)]));
  } catch (error) {
    out.replaceChildren(el('p', 'fine', error.message));
  }
}

// ---------- HONKSQUAD in Miner Wars ----------
const btcFmt = (value) => `${num(value, value < 0.01 ? 6 : 4)} BTC`;
const ZONE_LABEL = { promotion: 'Promotion', safe: 'Safe', relegation: 'Relegation' };

async function loadMinerWars() {
  try {
    state.mw = await getJson('/api/minerwars');
  } catch (error) {
    state.mw = { status: 'unavailable', error: error.message };
  }
  renderMinerWars();
  clearTimeout(state.mwTimer);
  // The member list is built in the background on the server; look again shortly while it loads.
  state.mwTimer = setTimeout(loadMinerWars, state.mw?.members?.status === 'loading' ? 20_000 : 5 * 60_000);
}

function renderClock() {
  const cycle = state.mw?.cycle ?? minerWarsCycle();
  const left = Math.max(0, new Date(cycle.end) - Date.now());
  const d = Math.floor(left / 86_400_000);
  const h = Math.floor((left % 86_400_000) / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  $('mw-clock').replaceChildren(document.createTextNode(`Cycle ${cycle.number} ends in`), bold(`${d}d ${h}h ${m}m`));
}

function stat(label, value, meta, valueNode) {
  const box = el('div', 'mw-stat');
  box.append(el('p', 'tile-label', label));
  const v = el('p', 'tile-value');
  if (valueNode) v.append(valueNode); else v.textContent = value;
  box.append(v, el('p', 'tile-meta', meta ?? '\u00a0'));
  return box;
}

function renderMinerWars() {
  renderClock();
  const mw = state.mw;
  const body = $('mw-body');
  if (!mw || mw.status !== 'live') {
    body.replaceChildren(empty(`The Miner Wars leaderboard is unavailable right now${mw?.error ? ` (${mw.error})` : ''}. It comes back by itself.`));
    $('mw-panels').hidden = true;
    $('mw-vs').hidden = true;
    return;
  }
  const { league, clan } = mw;
  $('mw-sub').textContent = `${league.name} league · live from GoMining's public leaderboard · updated ${time(mw.updatedAt)}`;
  const zone = el('span', `zone ${clan.zone}`, ZONE_LABEL[clan.zone]);
  const rank = el('span');
  rank.append(`#${clan.position} `, zone);
  const zoneMeta = clan.zone === 'promotion' ? `of ${league.clans} · top ${league.promotedUpTo} go up`
    : clan.zone === 'relegation' ? `of ${league.clans} · from #${league.relegatedFrom} go down`
    : `of ${league.clans}${league.promotedUpTo ? ` · top ${league.promotedUpTo} go up` : ''}`;
  const stats = el('div', 'mw-stats');
  stats.append(
    stat('League', league.name, `${num(league.clans)} clans · ${btcFmt(league.btcFund)} prize fund`),
    stat('Rank', null, zoneMeta, rank),
    stat('Blocks won', num(clan.blocks), `${num(clan.blockSharePct ?? 0, 1)}% of the league's ${num(league.totalBlocks)}`),
    stat('Clan power', `${num(clan.powerTh, 0)} TH`, `${num((clan.powerTh / league.totalPowerTh) * 100, 1)}% of the league`),
    stat('BTC so far (gross)', btcFmt(clan.btcSoFar), `before maintenance · ~${btcFmt(league.btcPerBlock)} per block`),
    stat('This cycle (projected, gross)', clan.btcWeekProjected === null ? '—' : btcFmt(clan.btcWeekProjected), clan.blocksWeekProjected === null ? 'Cycle just started' : `before maintenance · ~${num(clan.blocksWeekProjected)} blocks at this pace`),
  );
  body.replaceChildren(stats);
  const clanNet = state.market ? minerWarsClanNet(state.market.income, { btcWeek: clan.btcWeekProjected ?? clan.btcSoFar, clanPowerTh: clan.powerTh, leagueEfficiencyWth: league.avgEfficiencyWth, leagueDiscountPct: league.avgDiscountPct ?? 0 }) : null;
  if (clanNet) {
    body.appendChild(el('p', 'fine', `Maintenance comes out of this: GoMining charges a full week on every member's TH, and a share smaller than that pays nothing. At the league's average ${num(league.avgEfficiencyWth, 1)} W/TH and ${num(league.avgDiscountPct ?? 0, 1)}% discount, a week for the clan's ${num(clan.powerTh, 0)} TH is about ${btcFmt(clanNet.maintenanceBtc)}, which would leave about ${btcFmt(clanNet.netBtc)} for the clan. Use the comparison below for your own miners.`));
  }
  if (mw.warning) body.appendChild(el('p', 'fine', mw.warning));

  const isUs = (row) => row.clanId === clan.clanId;
  const clanRows = (rows) => rows.map((row) => [`#${row.position}`, row.name || 'Unnamed clan', num(row.blocks), num(row.powerTh, 0), ZONE_LABEL[row.zone]]);
  table($('mw-neighbours'), ['Rank', 'Clan', 'Blocks', 'TH', 'Zone'], clanRows(mw.neighbours), { highlight: (i) => isUs(mw.neighbours[i]), text: [1, 4] });
  table($('mw-board-table'), ['Rank', 'Clan', 'Blocks', 'TH', 'Zone'], clanRows(mw.board), { highlight: (i) => isUs(mw.board[i]), text: [1, 4] });

  const members = mw.members;
  if (members.status === 'live' && members.rows.length) {
    $('mw-members-note').textContent = `${members.count} players mined for the clan this cycle · updated ${time(members.updatedAt)}`;
    table($('mw-members'), ['#', 'Member', 'Blocks', 'TH', 'Boosts', 'League rank'],
      members.rows.map((row, i) => [i + 1, row.alias, num(row.blocks), num(row.powerTh, row.powerTh < 10 ? 1 : 0), num(row.boostsUsed), `#${num(row.leaguePosition)}`]), { text: [1] });
    $('mw-members').appendChild(el('p', 'fine', `From the league's player board, so it can include players who left the clan during the cycle (this is why it may show more players and TH than the app's member count). The clan's ${num(clan.powerTh, 0)} TH from the clan board is the figure GoMining shows.`));
  } else {
    $('mw-members-note').textContent = '';
    $('mw-members').replaceChildren(empty(members.status === 'loading' ? 'Building the member list from the league board… (about a minute)' : `Member list unavailable right now${members.error ? ` (${members.error})` : ''}.`));
  }
  $('mw-panels').hidden = false;

  const select = $('vs-form').elements.member;
  const chosen = select.value;
  state.mwMembers = members.rows ?? [];
  select.replaceChildren(new Option('Choose…', ''), ...state.mwMembers.map((row, i) => new Option(`${row.alias} · ${num(row.powerTh, 1)} TH`, String(i))));
  if ([...select.options].some((o) => o.value === chosen)) select.value = chosen;
  $('mw-vs').hidden = false;
  renderVs();
}

function renderVs() {
  const mw = state.mw;
  if (!state.market || mw?.status !== 'live') return;
  const f = $('vs-form').elements;
  const powerTh = Number(f.powerTh.value);
  const efficiencyWth = Number(f.efficiencyWth.value);
  const out = $('vs-out');
  if (!(powerTh > 0) || !(efficiencyWth > 0)) { out.replaceChildren(el('p', 'fine', 'Enter your TH and W/TH.')); return; }
  const blocks = mw.clan.blocksWeekProjected ?? mw.clan.blocks;
  const r = minerWarsVsSolo(state.market.income, {
    powerTh, efficiencyWth, discountPct: Number(f.discountPct.value) || 0, joining: f.joining.checked,
    clanBlocksWeek: blocks, btcPerBlock: mw.league.btcPerBlock, clanPowerTh: mw.clan.powerTh,
    leagueEfficiencyWth: mw.league.avgEfficiencyWth, leagueDiscountPct: mw.league.avgDiscountPct ?? undefined,
  });
  const col = (label, btc, win, sub) => {
    const box = el('div');
    box.append(el('p', 'eyebrow', label), el('p', `calc-big${win ? ' win' : ''}`, btcFmt(btc)), el('p', 'calc-sub', sub));
    return box;
  };
  const mwWins = r.better === 'minerWars';
  const mwSub = r.minerWars.flooredAtZero
    ? `Your share (${btcFmt(r.minerWars.grossBtc)}) is smaller than a week's maintenance (${btcFmt(r.minerWars.maintenanceBtc)}), so GoMining pays 0 and charges nothing more`
    : `${btcFmt(r.minerWars.grossBtc)} share − ${btcFmt(r.minerWars.maintenanceBtc)} maintenance ≈ ${usdSmart(r.minerWars.netUsd)} net`;
  const verdict = el('div');
  verdict.append(el('p', 'eyebrow', 'Verdict'), el('p', `calc-big${mwWins ? ' win' : ''}`, mwWins ? 'Miner Wars' : 'Plain mining'),
    el('p', 'calc-sub', r.differencePct === null ? 'Plain mining loses money at these settings; Miner Wars never goes below 0' : `${r.differencePct >= 0 ? '+' : ''}${num(r.differencePct, 0)}% vs plain mining`));
  out.replaceChildren(
    col('Miner Wars with HONKSQUAD', r.minerWars.netBtc, mwWins, `${num(r.sharePct, 2)}% of the clan's ~${num(blocks)} blocks. ${mwSub}`),
    col('Plain mining', r.solo.netBtc, !mwWins, `≈ ${usdSmart(r.solo.netUsd)} net a week`),
    verdict,
  );
  $('vs-note').textContent = `A week at the clan's current pace (${num(blocks)} blocks × ~${btcFmt(mw.league.btcPerBlock)}), shared by TH out of ${num(r.clanPowerTh, 0)} TH${f.joining.checked ? ' (the clan plus yours)' : ''}. GoMining takes a full week of maintenance on all your TH from your share, never below zero; any reward above what Mining mode would pay is charged at the league's average ${num(mw.league.avgEfficiencyWth ?? efficiencyWth, 1)} W/TH. Plain mining doesn't include the Mining mode discount; add it to your discount there if you want. Spells and GOMINING rewards aren't included. Pre-halving rates. An estimate, not a promise.`;
}

function empty(message) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = message;
  return div;
}

function table(container, headers, rows, { highlight, text = [] } = {}) {
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
    if (highlight?.(index)) tr.className = 'highlight';
    cells.forEach((value, i) => {
      const td = tr.insertCell();
      td.textContent = value;
      if (i > 0 && !text.includes(i)) td.className = 'num';
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
  renderOutlook();
  renderBuilder();
  renderEarn();
  if (state.mw) renderMinerWars();
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
    // A BTC price scenario, or undefined for the current price.
    btcPriceUsd: f.btcScenario.value === 'custom' ? n('btcPriceCustom') : f.btcScenario.value === 'current' ? undefined : Number(f.btcScenario.value),
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
  $('gc-form').querySelector('[data-btc-custom]').hidden = $('gc-form').elements.btcScenario.value !== 'custom';
  // Everything below runs on the chosen BTC price; sats per TH and USD fees stay as they are.
  const income = atBtcPrice(state.market.income, v.btcPriceUsd);
  const scenario = income !== state.market.income;
  const scenarioNote = scenario ? ` BTC price scenario ${usd(income.btcPriceUsd, 0)} (current ${usd(state.market.income.btcPriceUsd, 0)}), difficulty held constant.` : '';
  // The GOMINING conversion only makes sense at today's prices.
  const gmt = scenario ? undefined : state.market.prices?.gomining?.usd;
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
      const fees = $('gc-fees');
      fees.replaceChildren('Maintenance after discount: ', bold(`${usdSmart(d.feesUsd)}/day`), ' · ', bold(`${usdSmart(m.feesUsd)}/month`));
      if (m.feesGomining !== null) fees.append(' · paid in GOMINING ≈ ', bold(`${num(m.feesGomining, 0)} GOMINING/month`), ` (${num(d.feesGomining, 1)}/day)`);
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
      $('gc-note').textContent = `${v.powerTh} TH at ${v.efficiencyWth} W/TH, ${num(r.input.discountPct, 1)}% total maintenance discount, electricity ${usd(r.input.kwhPriceUsd, 3)}/kWh, ${basis}${sample}. Rewards are paid in BTC${withGmt ? '; *GOMINING is only a conversion at today\'s market price' : ''}. Pre-halving rates held constant; BTC price, difficulty and fees will move. Payback depends heavily on these assumptions.${scenarioNote}`;
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
      $('gc-note').textContent = `New purchases at ${usd(pricePerThUsd, 2)} per TH${v.pricePerThUsd ? '' : ' (GoMining new-miner list price)'}, ${v.efficiencyWth} W/TH, ${num(v.discountPct, 1)}% total maintenance discount, ${basis}${sample}.${reinvestNote} A simulation at constant pre-halving rates, not a forecast.${scenarioNote}`;
    }
  } catch (error) {
    $('gc-note').textContent = error.message;
    // Don't leave the previous result showing next to an error.
    for (const id of state.gcMode === 'plan' ? ['gp-th', 'gp-earned', 'gp-break'] : ['gc-day', 'gc-month', 'gc-payback']) $(id).textContent = '—';
  }
}

$('gc-form').addEventListener('input', () => {
  clearTimeout(state.gcTimer);
  state.gcTimer = setTimeout(() => { renderCalculator(); renderAdvisor(); renderBuilder(); renderNetwork(); }, 120);
});
$('db-vip').replaceChildren(...VIP_LEVELS.map((row) => new Option(`${row.name} · ${num(row.discountPct, 1)}%`, row.name)));
$('se-vip').replaceChildren(...VIP_LEVELS.map((row) => new Option(`${row.name} · ×${row.simpleEarnMultiplier}`, row.name)));
$('db-vip').value = $('se-vip').value = VIP_LEVELS.some((row) => row.name === store.get('dbVip')) ? store.get('dbVip') : 'Bronze I';
$('vip-form').addEventListener('input', () => renderVip({ sync: true }));
$('vip-form').addEventListener('submit', (event) => event.preventDefault());
$('se-form').addEventListener('input', (event) => {
  if (event.target.name === 'asset') $('se-form').elements.aprPct.value = String(SIMPLE_EARN_ASSETS[event.target.value]);
  if (event.target === $('se-vip')) { $('db-vip').value = $('se-vip').value; store.set('dbVip', $('se-vip').value); renderBuilder(); }
  renderEarn();
});
$('se-form').addEventListener('submit', (event) => event.preventDefault());
renderVip();
$('db-form').addEventListener('input', (event) => {
  // The VIP level is one setting: picking it here also sets it for Simple Earn.
  if (event.target === $('db-vip')) { $('se-vip').value = $('db-vip').value; renderEarn(); }
  renderBuilder();
});
$('db-form').addEventListener('submit', (event) => event.preventDefault());
$('db-apply').addEventListener('click', () => {
  if (state.builtDiscount === null || state.builtDiscount === undefined) return;
  const input = $('gc-form').elements.discountPct;
  input.value = String(state.builtDiscount);
  if (state.builtBonus !== null && state.builtBonus !== undefined) $('gc-form').elements.reinvestBonusPct.value = String(state.builtBonus);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  $('db-apply').textContent = 'Applied ✓';
  setTimeout(() => { $('db-apply').textContent = 'Use this discount'; }, 1500);
});
$('vs-form').addEventListener('input', (event) => {
  if (event.target.name === 'member' && event.target.value) {
    const member = state.mwMembers?.[Number(event.target.value)];
    if (member) { $('vs-form').elements.powerTh.value = String(member.powerTh); $('vs-form').elements.joining.checked = false; }
  }
  renderVs();
});
$('vs-form').addEventListener('submit', (event) => event.preventDefault());
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
const SHARE_FIELDS = ['btcPriceCustom', 'powerTh', 'efficiencyWth', 'discountPct', 'kwhPriceUsd', 'priceUsd', 'monthlyUsd', 'months', 'pricePerThUsd', 'reinvestPricePerThUsd', 'reinvestBonusPct'];

// Opening a shared link fills the calculator with the sender's numbers.
function applySharedLink() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (!hash.has('calc')) return;
  const f = $('gc-form').elements;
  for (const name of SHARE_FIELDS) {
    const value = hash.get(name);
    if (value !== null && /^\d+(\.\d+)?$/.test(value)) f[name].value = value;
  }
  const scenario = hash.get('btc');
  if (scenario && [...f.btcScenario.options].some((o) => o.value === scenario)) f.btcScenario.value = scenario;
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
  if (f.btcScenario.value !== 'current') params.set('btc', f.btcScenario.value);
  if (f.btcScenario.value === 'custom' && f.btcPriceCustom.value) params.set('btcPriceCustom', f.btcPriceCustom.value);
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
  renderBreakEven(state.market?.outlook?.breakEven);
});

$('refresh').addEventListener('click', () => load({ refresh: true }));

// ---------- Ticker bar ----------
const coinPrice = (value) => (value >= 1000 ? usd(value, 0) : value >= 1 ? usd(value, 2) : usd(value, value >= 0.01 ? 4 : 6));

function changeSpan(el, value) {
  el.replaceChildren();
  if (value === null || value === undefined) return;
  el.className = `tk-ch ${value > 0 ? 'arrow-up good' : value < 0 ? 'arrow-down bad' : ''}`;
  el.textContent = `${num(Math.abs(value), 2)}%`;
}

function tickerItem(coin) {
  const item = document.createElement('span');
  item.className = 'tk';
  item.title = `#${coin.rank ?? '?'} ${coin.name}`;
  const sym = document.createElement('span'); sym.className = 'tk-sym'; sym.textContent = coin.symbol;
  const price = document.createElement('b'); price.textContent = coinPrice(coin.priceUsd);
  const change = document.createElement('span'); changeSpan(change, coin.change24hPct);
  item.append(sym, price, change);
  return item;
}

async function loadTicker() {
  try {
    const data = await getJson('/api/ticker');
    state.ticker = data;
    renderEarn();
    $('tk-btc').textContent = data.btc ? coinPrice(data.btc.priceUsd) : '—';
    changeSpan($('tk-btc-ch'), data.btc?.change24hPct);
    $('tk-gmt').textContent = data.gomining ? coinPrice(data.gomining.priceUsd) : '—';
    changeSpan($('tk-gmt-ch'), data.gomining?.change24hPct);
    const move = $('ticker-move');
    if (!data.coins.length) {
      move.replaceChildren();
      const note = document.createElement('span');
      note.className = 'tk-sym';
      note.textContent = 'Top coins unavailable right now';
      move.appendChild(note);
      move.style.animation = 'none';
      return;
    }
    // Two copies side by side so the scroll loops without a gap; ~1.6s per coin keeps it readable.
    const items = data.coins.map(tickerItem);
    const copy = data.coins.map(tickerItem);
    copy.forEach((node) => node.setAttribute('aria-hidden', 'true'));
    move.replaceChildren(...items, ...copy);
    move.style.animation = '';
    move.style.setProperty('--ticker-duration', `${Math.max(30, data.coins.length * 1.6)}s`);
  } catch {
    // Keep whatever is showing; the next refresh tries again.
  }
}
loadTicker();
setInterval(loadTicker, 60 * 1000);

// Feed the Goose: copy the full donation address.
$('donate-copy').addEventListener('click', async () => {
  const button = $('donate-copy');
  const address = button.dataset.address;
  try {
    await navigator.clipboard.writeText(address);
    button.textContent = 'Copied!';
  } catch {
    window.prompt('Copy the bitcoin address:', address);
  }
  button.classList.add('copied');
  setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('copied'); }, 2000);
});

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

// The section menu sticks just under the header, whose height changes with the screen width.
const setTopHeight = () => document.documentElement.style.setProperty('--top-h', `${document.querySelector('.top').offsetHeight}px`);
setTopHeight();
window.addEventListener('resize', setTopHeight);
const jumpLinks = [...document.querySelectorAll('#jump a')];
const jumpTargets = jumpLinks.map((a) => document.querySelector(a.getAttribute('href')));
const markCurrent = () => {
  const line = document.querySelector('.top').offsetHeight + 80;
  let current = 0;
  jumpTargets.forEach((target, i) => { if (target && target.getBoundingClientRect().top <= line) current = i; });
  jumpLinks.forEach((a, i) => {
    const active = i === current;
    if (active && a.getAttribute('aria-current') !== 'true') {
      // Keep the active section's link visible in the scrollable menu on phones.
      const nav = a.parentElement;
      nav.scrollTo({ left: a.offsetLeft - (nav.clientWidth - a.offsetWidth) / 2, behavior: 'auto' });
    }
    a.setAttribute('aria-current', String(active));
  });
};
window.addEventListener('scroll', () => requestAnimationFrame(markCurrent), { passive: true });
markCurrent();

applySharedLink();
setMode(state.gcMode);
load();
loadMinerWars();
setInterval(renderClock, 30_000);
