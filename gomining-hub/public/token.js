// GOMINING token: Burn & Mint history and epoch progress, the veGOMINING lock simulator and a daily
// price calendar for BTC and GOMINING.

import { calendarHeatmap, lineChart } from './charts.js';
import { veLock } from '/lib/calc.js';
import { $, SERIES, bold, compact, day, el, empty, fieldNumber, getJson, legendInto, num, stat, store, table, usd } from './ui.js';

let shared;
const tk = { data: null, history: null, asset: store.get('heatAsset') === 'gomining' ? 'gomining' : 'btc' };

export function initToken(context) {
  shared = context;
  const form = $('ve-form');
  for (const name of ['amount', 'lockDays']) {
    const saved = store.get(`ve:${name}`);
    if (saved !== null) form.elements[name].value = saved;
  }
  form.addEventListener('input', (event) => {
    if (event.target.name) store.set(`ve:${event.target.name}`, event.target.value);
    renderVe();
  });
  form.addEventListener('submit', (event) => event.preventDefault());
  for (const button of $('heat-asset').children) {
    button.addEventListener('click', () => {
      tk.asset = button.dataset.asset;
      store.set('heatAsset', tk.asset);
      renderHeat();
    });
  }
  getJson('/api/tokenomics').then((data) => { tk.data = data; renderToken(); })
    .catch((error) => { $('bm-stats').replaceChildren(empty(`GoMining's Burn & Mint record is unavailable right now (${error.message}).`)); renderVe(); });
  getJson('/api/prices/history').then((data) => { tk.history = data; renderHeat(); })
    .catch((error) => { $('heat-chart').replaceChildren(empty(`Price history is unavailable right now (${error.message}).`)); });
}

export function renderToken() {
  renderBurnMint();
  renderVe();
  renderHeat();
}

function renderBurnMint() {
  const data = tk.data;
  if (!data) return;
  const w = data.latest;
  const e = data.epoch;
  $('bm-sub').textContent = `Every Tuesday GoMining burns the GOMINING paid for maintenance and mints fewer back · ${num(data.totals.cycles)} cycles since ${day(data.weeks[0].date)}`;
  const strip = el('div', 'stat-strip');
  strip.append(
    stat('Burned last cycle', `${compact(w.burned, 2)}`, `GOMINING · ${day(w.date)}`),
    stat('Minted back', `${compact(w.minted, 2)}`, `${num((w.minted / w.burned) * 100, 1)}% of the burn`),
    stat('Net burned', `${compact(w.netBurned, 2)}`, `${num(w.burnVotePct ?? 0, 1)}% of votes for burning`),
    stat('To veGOMINING', `${compact(w.toVeHolders, 2)}`, 'GOMINING to vote holders'),
    stat('Burned since 2023', `${compact(data.totals.burned, 1)}`, `net ${compact(data.totals.netBurned, 1)} removed`),
    stat('veGOMINING income', data.ve?.yearlyIncomePerVote ? `${num(data.ve.yearlyIncomePerVote, 2)}` : '—', 'GOMINING per vote per year'),
  );
  const nodes = [strip];
  if (e) {
    const box = el('div', 'epoch');
    const line = el('p', 'impact');
    line.append('Epoch ', bold(String(e.number)), ` (mint coefficient ${e.coefficient}) since ${e.startDate ? day(e.startDate) : '—'}: `, bold(e.burned === null ? '—' : `${compact(e.burned, 2)} of ${compact(e.toBurn, 0)}`), ' burned');
    const meter = el('div', 'meter');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', `Epoch ${e.number} progress`);
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', String(e.progressPct ?? 0));
    const fill = el('span');
    fill.style.width = `${e.progressPct ?? 0}%`;
    meter.appendChild(fill);
    const after = el('p', 'fine', e.cyclesLeft ? `About ${num(e.cyclesLeft)} more weekly cycles at this epoch's average burn; epoch ${e.number + 1} mints with coefficient ${(e.coefficient + 0.01).toFixed(2)}.` : '');
    box.append(line, meter, after);
    nodes.push(box);
  }
  $('bm-stats').replaceChildren(...nodes);
  // Minted is ~98% of burned, so the two lines would sit on top of each other: chart the burn (the
  // GOMINING members paid for maintenance each week) and keep minted and net in the tiles and table.
  const recent = data.weeks.slice(-52);
  legendInto($('bm-legend'), [['GOMINING burned per weekly cycle (paid for maintenance), last 52 cycles', SERIES[1]]]);
  lineChart($('bm-chart'), {
    xLabels: recent.map((row) => new Date(row.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })),
    series: [{ name: 'Burned', color: SERIES[1], values: recent.map((row) => row.burned) }],
    format: (v) => `${num(v)} GOMINING`,
    tickFormat: (v) => compact(v, 1),
    xTooltip: (_label, i) => `Cycle of ${day(recent[i].date)} · epoch ${recent[i].epoch} · minted ${compact(recent[i].minted, 2)} · ${recent[i].burnVotePct ?? '—'}% voted burn`,
    zeroBased: true,
    height: 220,
  });
  table($('bm-table'), ['Cycle', 'Epoch', 'Burned', 'Minted', 'Net burned', 'Votes for burning', 'To veGOMINING'], [...data.weeks].reverse().map((row) => [
    day(row.date), row.epoch, num(row.burned), num(row.minted), num(row.netBurned), row.burnVotePct === null ? '—' : `${num(row.burnVotePct, 1)}%`, num(row.toVeHolders),
  ]));
}

function renderVe() {
  const form = $('ve-form');
  const out = $('ve-out');
  const gominingUsd = shared.market?.prices?.gomining?.usd ?? shared.ticker?.gomining?.priceUsd;
  try {
    const r = veLock({ amount: fieldNumber(form, 'amount'), lockDays: fieldNumber(form, 'lockDays'), yearlyIncomePerVote: tk.data?.ve?.yearlyIncomePerVote, gominingUsd });
    const strip = el('div', 'stat-strip');
    strip.append(
      stat('veGOMINING votes', num(r.votes, r.votes < 100 ? 2 : 0), `${num(r.votesPerToken, 3)} per token, falling to 0`),
      stat('VIP level', r.vipLevel, r.vipHoldsDays === null ? 'from votes alone' : r.vipHoldsDays > 0 ? `for about ${num(r.vipHoldsDays)} days` : 'only at the start'),
      stat('Rewards over the lock', r.rewardsTotal === null ? '—' : `${num(r.rewardsTotal, 0)} GOMINING`, r.rewardsTotalUsd ? `≈ ${usd(r.rewardsTotalUsd, 2)} today` : 'needs GoMining\'s income per vote'),
      stat('First year', r.rewardsFirstYear === null ? '—' : `${num(r.rewardsFirstYear, 0)} GOMINING`, r.yearlyIncomePerVote ? `${num(r.yearlyIncomePerVote, 2)} per vote per year now` : ' '),
    );
    out.replaceChildren(strip);
    lineChart($('ve-chart'), {
      xLabels: r.schedule.map((row) => (row.day >= 365 ? `${num(row.day / 365, 1)}y` : `${row.day}d`)),
      series: [{ name: 'Votes', color: SERIES[0], values: r.schedule.map((row) => row.votes) }],
      format: (v) => `${num(v, v < 100 ? 2 : 0)} votes`,
      tickFormat: (v) => compact(v, 1),
      xTooltip: (_label, i) => `Day ${num(r.schedule[i].day)} · ${r.schedule[i].vipLevel}`,
      zeroBased: true,
      height: 200,
    });
  } catch (error) {
    out.replaceChildren(el('p', 'fine', error.message));
    $('ve-chart').replaceChildren();
  }
}

function renderHeat() {
  for (const button of $('heat-asset').children) button.setAttribute('aria-checked', String(button.dataset.asset === tk.asset));
  const rows = tk.history?.[tk.asset];
  if (!tk.history) return;
  if (!rows?.length) { $('heat-chart').replaceChildren(empty('No price history for this asset right now.')); return; }
  const name = tk.asset === 'btc' ? 'BTC' : 'GOMINING';
  const days = rows.slice(1).map((row, i) => {
    const change = ((row.usd / rows[i].usd) - 1) * 100;
    return { date: row.date, value: change, title: day(row.date), rows: [{ value: `${change >= 0 ? '+' : ''}${num(change, 2)}%`, label: 'that day' }, { value: usd(row.usd, row.usd < 1 ? 4 : 0), label: 'close (UTC)' }] };
  });
  const first = rows[0].usd;
  const last = rows.at(-1).usd;
  const up = days.filter((d) => d.value > 0).length;
  $('heat-sub').textContent = `${name}: daily change over the last year (CoinGecko closes, UTC) · ${num(((last / first) - 1) * 100, 1)}% over the year · ${up} up days, ${days.length - up} down`;
  calendarHeatmap($('heat-chart'), { days, format: (v) => `${v >= 0 ? '+' : ''}${num(v, 2)}%`, cap: tk.asset === 'btc' ? 5 : 10 });
  const legend = $('heat-legend');
  legend.replaceChildren(el('span', '', `−${tk.asset === 'btc' ? 5 : 10}% or more`), el('span', 'heat-scale'), el('span', '', `+${tk.asset === 'btc' ? 5 : 10}% or more`));
}
