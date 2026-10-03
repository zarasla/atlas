import { columnChart, lineChart, splitBar } from './charts.js';
import { SIMPLE_EARN_ASSETS, SIMPLE_EARN_RULES, VIP_LEVELS, GOMINING_REINVEST_FEE_PCT, TH_REINVEST_RULES, atBtcPrice, simpleEarn, vipStatus, findListedPrice, investmentPlan, listedPricePerTh, maintenanceDiscount, portfolio, rewardsBreakdown, upgradeAdvisor } from '/lib/calc.js';
import { $, PERIOD_LABELS, SERIES, bold, compact, day, el, empty, getJson, legendInto, num, pct, sats, setDelta, staleNote, store, table, tick, time, usd, usdSmart } from './ui.js';
import { initMinerWars, refreshMinerWars } from './minerwars.js';
import { initPlanning, renderPlanning } from './planning.js';
import { initToken, renderToken } from './token.js';
import { initPlatform } from './platform.js';

const state = { market: null, history: [], efficiency: Number(store.get('efficiency')) || 15, historyMetric: store.get('historyMetric') || 'sats' };
// The other modules read the market data and the calculator's inputs through this.
const shared = {
  get market() { return state.market; },
  get ticker() { return state.ticker; },
  calculator: () => formValues(),
  vipLevel: () => $('db-vip').value,
  discountPct: () => Number($('gc-form').elements.discountPct.value) || 0,
};

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
      gominingHeld: Number(f.gominingHeld.value) || 0, vipLevel: f.vipLevel.value, serviceButtonDays: Number(f.serviceButtonDays.value) || 0, miningModePct: Number(f.miningModePct.value) || 0,
    });
    store.set('dbVip', f.vipLevel.value);
    store.set('dbMiningMode', f.miningModePct.value);
    state.builtDiscount = d.totalPct;
    state.builtBonus = d.reinvestBonusPct;
    const total = el('span', 'db-total', `${num(d.totalPct, 1)}%`);
    const parts = el('span');
    parts.append('= ', bold(`${d.tokenPct}%`), ' GOMINING + ', bold(`${num(d.vipPct, 1)}%`), ' VIP + ', bold(`${num(d.serviceButtonPct, 1)}%`), ' Service Button');
    if (d.miningModePct) parts.append(' + ', bold(`${num(d.miningModePct, 2)}%`), ' Mining mode');
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
  const status = vipStatus({ powerTh: Number(f.powerTh.value), veGomining: Number(f.veGomining.value) });
  const lvl = status.level;
  const head = el('div', 'vip-head');
  head.append(el('span', 'vip-name', lvl.name), el('span', 'card-sub', status.reachedBy.length ? `reached by ${status.reachedBy.map((k) => ({ th: 'mining power', veGomining: 'veGOMINING' })[k]).join(' and ')}` : 'the starting level'));
  const perks = el('p', 'vip-perks');
  const perk = (label, value) => { const span = el('span'); span.append(`${label} `, bold(value)); return span; };
  perks.append(
    perk('Maintenance discount', `${num(lvl.discountPct, 1)}%`), perk('Simple Earn', `×${lvl.simpleEarnMultiplier}`), perk('Reinvest bonus', lvl.reinvestBonusPct ? `+${lvl.reinvestBonusPct}% TH` : '—'),
    perk('Instant Funds fee', `${num(lvl.instantFundsFeePct, 2)}%`), perk('Launchpad', lvl.launchpad ? `×${lvl.launchpad.multiplier} (tier ${lvl.launchpad.tier})` : '—'), perk('Referral royalty', `${lvl.royaltyPct}%`),
    ...(lvl.clanOwner ? [perk('Miner Wars', 'can own a clan')] : []), ...(lvl.vipManager ? [perk('Support', 'VIP manager')] : []),
  );
  const nodes = [head, perks];
  if (status.next) {
    const n = status.next;
    const box = el('div', 'vip-next');
    const title = el('span');
    title.append('Next: ', el('strong', '', n.level.name), ' — either:');
    const needs = el('span');
    needs.append(bold(`+${big(n.needs.th)} TH`), ' or ', bold(`+${big(n.needs.veGomining)} veGOMINING`));
    const gains = el('span');
    const g = n.gains;
    const parts = [g.discountPct ? `+${num(g.discountPct, 1)}% discount` : null, g.simpleEarnMultiplier ? `Simple Earn ×${n.level.simpleEarnMultiplier}` : null, g.reinvestBonusPct ? `reinvest bonus +${n.level.reinvestBonusPct}%` : null, g.royaltyPct ? `royalty ${n.level.royaltyPct}%` : null].filter(Boolean);
    gains.textContent = parts.length ? `Gives you ${parts.join(', ')}.` : '';
    box.append(title, needs, gains);
    nodes.push(box);
  } else {
    nodes.push(el('p', 'vip-next', 'Elite is the top level.'));
  }
  $('vip-out').replaceChildren(...nodes);
  table($('vip-table'), ['Level', 'TH', 'veGOMINING', 'Discount', 'Simple Earn', 'Instant Funds', 'Launchpad', 'Reinvest', 'Royalty'],
    VIP_LEVELS.map((r) => [r.name, big(r.th), big(r.veGomining), `${num(r.discountPct, 1)}%`, `×${r.simpleEarnMultiplier}`, `${num(r.instantFundsFeePct, 2)}%`, r.launchpad ? `×${r.launchpad.multiplier}` : '—', r.reinvestBonusPct ? `+${r.reinvestBonusPct}%` : '—', `${r.royaltyPct}%`]),
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

// Prices for Simple Earn assets: BTC from the price feed, stablecoins at $1, the rest from the ticker
// (CoinGecko top coins). GRAM isn't in the ticker, so its price is typed in.
function assetPrice(asset) {
  const btcUsd = state.ticker?.btc?.priceUsd ?? state.market?.prices?.btc?.usd ?? state.market?.income?.btcPriceUsd;
  if (asset === 'BTC') return btcUsd;
  if (asset === 'USDT' || asset === 'USDC') return 1;
  return state.ticker?.coins?.find((c) => c.symbol === asset)?.priceUsd;
}

function renderEarn() {
  const f = $('se-form').elements;
  const out = $('se-out');
  const btcUsd = assetPrice('BTC');
  const asset = f.asset.value;
  const known = assetPrice(asset);
  const priceField = $('se-form').querySelector('[data-se-price]');
  priceField.hidden = Boolean(known);
  const assetPriceUsd = known ?? (Number(f.assetPriceUsd.value) || undefined);
  const thPriceUsd = listedPricePerTh(state.market?.presets ?? [], 15) ?? undefined;
  try {
    if (f.aprPct.value === '') throw new Error(`Enter the ${asset} APR your GoMining wallet shows (Wallet → Simple Earn). GoMining changes these rates often, so this site never assumes one.`);
    if (!assetPriceUsd) throw new Error(`Enter the ${asset} price in USD.`);
    const r = simpleEarn({ amount: Number(f.amount.value), assetPriceUsd, aprPct: Number(f.aprPct.value), vipLevel: f.vipLevel.value, btcPriceUsd: btcUsd, rewardInTh: f.rewardInTh.checked, thPriceUsd });
    store.set(`seApr:${asset}`, f.aprPct.value);
    const head = el('div', 'se-head');
    const col = (label, value, sub) => { const box = el('div'); box.append(el('p', 'eyebrow', label), el('p', 'calc-big', value), el('p', 'calc-sub', sub)); return box; };
    head.append(
      col('Your APR', `${num(r.effectiveAprPct, 2)}%`, `${num(r.baseAprPct, 2)}% × ${r.multiplier} (${r.vipLevel})`),
      col('Per month', r.rewardType === 'TH' && r.periods.month.th !== null ? `${num(r.periods.month.th, 3)} TH` : `${num(r.periods.month.sats)} sats`, `≈ ${usdSmart(r.periods.month.usd)} on ${usdSmart(r.valueUsd)}`),
    );
    const wrap = el('div', 'table-wrap');
    const notes = [];
    if (r.thNote) notes.push(el('p', 'fine', `${r.thNote}.`));
    if (r.rewardType === 'TH') notes.push(el('p', 'fine', `Paid in TH with ${SIMPLE_EARN_RULES.thBonusPct}% more TH, priced here at GoMining's new-miner list price at 15 W/TH (${thPriceUsd ? usd(thPriceUsd, 2) : '—'}/TH); GoMining uses its upgrade price on the day.`));
    out.replaceChildren(head, wrap, ...notes);
    const withTh = r.rewardType === 'TH' && r.periods.day.th !== null;
    table(wrap, ['Period', 'BTC', 'Sats', 'USD', ...(withTh ? ['TH'] : [])], Object.entries(r.periods).map(([k, p]) => [PERIOD_LABELS[k], num(p.btc, 8), num(p.sats), usdSmart(p.usd), ...(withTh ? [num(p.th, 4)] : [])]));
  } catch (error) {
    out.replaceChildren(el('p', 'fine', error.message));
  }
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
  renderRoi();
  renderPrices();
  renderAdvisor();
  renderHistory();
  renderPlanning();
  renderToken();
  refreshMinerWars();
}

// ---------- Goose Calculator ----------
state.gcMode = store.get('gcMode') === 'plan' ? 'plan' : 'rewards';

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
      $('gc-note').textContent = `${v.powerTh} TH at ${v.efficiencyWth} W/TH, ${num(r.input.discountPct, 1)}% total maintenance discount, electricity ${usd(r.input.kwhPriceUsd, 3)}/kWh, ${basis}${sample}. Rewards are paid in BTC${withGmt ? `; *GOMINING is only a conversion at today's market price (auto-reinvesting into GOMINING costs a ${GOMINING_REINVEST_FEE_PCT}% fee)` : ''}. Pre-halving rates held constant; BTC price, difficulty and fees will move. Payback depends heavily on these assumptions.${scenarioNote}`;
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
      const blocked = Object.entries(sum.reinvestBlockedDays ?? {});
      const reinvestNote = v.reinvest
        ? ` Reinvesting daily at ${usd(v.reinvestPricePerThUsd || pricePerThUsd, 2)} per TH${v.reinvestPricePerThUsd ? '' : ' (same as new purchases: enter your power-upgrade price for accuracy)'}${v.reinvestBonusPct ? ` with a ${num(v.reinvestBonusPct, 1)}% VIP bonus` : ''}, under GoMining's rules: ${TH_REINVEST_RULES.minTh}–${num(TH_REINVEST_RULES.maxTh)} TH, better than ${TH_REINVEST_RULES.maxEfficiencyWth} W/TH, at least $${TH_REINVEST_RULES.minUsdPerDay.toFixed(2)} a day.${blocked.length ? ` Paid in BTC instead on ${blocked.map(([why, days]) => `${num(days)} days (${why})`).join(', ')}: ${usd(sum.paidOutUsd, 2)} in total.` : ''}`
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
  state.gcTimer = setTimeout(() => { renderCalculator(); renderAdvisor(); renderBuilder(); renderNetwork(); renderPlanning(); }, 120);
});
$('db-vip').replaceChildren(...VIP_LEVELS.map((row) => new Option(`${row.name} · ${num(row.discountPct, 1)}%`, row.name)));
$('se-vip').replaceChildren(...VIP_LEVELS.map((row) => new Option(`${row.name} · ×${row.simpleEarnMultiplier}`, row.name)));
$('db-vip').value = $('se-vip').value = VIP_LEVELS.some((row) => row.name === store.get('dbVip')) ? store.get('dbVip') : 'Bronze I';
$('db-form').elements.miningModePct.value = store.get('dbMiningMode') ?? '';
$('se-form').elements.asset.replaceChildren(...SIMPLE_EARN_ASSETS.map((asset) => new Option(asset, asset)));
$('se-form').elements.asset.value = 'USDT';
$('se-form').elements.aprPct.value = store.get('seApr:USDT') ?? '';
$('vip-form').addEventListener('input', () => renderVip({ sync: true }));
$('vip-form').addEventListener('submit', (event) => event.preventDefault());
$('se-form').addEventListener('input', (event) => {
  // Each asset remembers the APR typed for it in this browser.
  if (event.target.name === 'asset') $('se-form').elements.aprPct.value = store.get(`seApr:${event.target.value}`) ?? '';
  if (event.target === $('se-vip')) { $('db-vip').value = $('se-vip').value; store.set('dbVip', $('se-vip').value); renderBuilder(); renderPlanning(); }
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
initPlanning(shared);
initMinerWars(shared);
initToken(shared);
initPlatform(shared);
load();
