// Planning tools: profit by BTC price and efficiency, efficiency-vs-power upgrades, and Simple Earn
// versus mining. Everything runs in the browser on the same maths the server uses (/lib/calc.js).

import { lineChart } from './charts.js';
import { VIP_LEVELS, breakEvenMatrix, earnVsMinePlan, listedPricePerTh, upgradeComparison } from '/lib/calc.js';
import { $, SERIES, el, empty, fieldNumber, legendInto, num, store, table, usd, usdSmart } from './ui.js';

let shared;
// Columns around today's GoMining BTC rate (which is its own column).
const MULTIPLIERS = [0.5, 0.75, 1.25, 1.5, 2];

export function initPlanning(context) {
  shared = context;
  for (const id of ['uc-form', 'evm-form']) {
    const form = $(id);
    for (const field of form.elements) {
      const saved = store.get(`${id}:${field.name}`);
      if (saved !== null && field.name) field.value = saved;
    }
    form.addEventListener('input', (event) => {
      if (event.target.name) store.set(`${id}:${event.target.name}`, event.target.value);
      renderPlanning();
    });
    form.addEventListener('submit', (event) => event.preventDefault());
  }
  $('mx-custom').addEventListener('input', () => renderMatrix());
}

export function renderPlanning() {
  if (!shared?.market) return;
  renderMatrix();
  renderUpgrade();
  renderEarnVsMine();
}

const settings = () => {
  const calc = shared.calculator();
  return { discountPct: calc.discountPct ?? 0, kwhPriceUsd: calc.kwhPriceUsd };
};

function renderMatrix() {
  const income = shared.market.income;
  const { discountPct, kwhPriceUsd } = settings();
  const today = Math.round(income.btcPriceUsd);
  const custom = Number($('mx-custom').value) || null;
  const prices = [...MULTIPLIERS.map((k) => Math.round((today * k) / 1000) * 1000), today, ...(custom ? [custom] : [])];
  const m = breakEvenMatrix(income, { btcPrices: prices, discountPct, kwhPriceUsd });
  $('mx-sub').textContent = `Net reward per TH per day at ${num(m.satsPerThDay, 1)} sats per TH, after your ${num(m.discountPct, 1)}% discount (set in the calculator), at today's difficulty`;
  const todayIndex = m.btcPrices.indexOf(today);
  const headers = ['W/TH', 'Break-even BTC', ...m.btcPrices.map((p, i) => (i === todayIndex ? `Today ${usd(p, 0)}` : usd(p, 0)))];
  table($('mx-table'), headers, m.rows.map((row) => [
    `${row.efficiencyWth} W/TH`, row.breakEvenBtcUsd ? usd(row.breakEvenBtcUsd, 0) : '—', ...row.netUsdPerThDay.map((v) => usdSmart(v)),
  ]), {
    cellClass: (r, c) => (c < 2 ? '' : `${m.rows[r].netUsdPerThDay[c - 2] >= 0 ? 'heat-pos' : 'heat-neg'}${c - 2 === todayIndex ? ' today' : ''}`),
    highlight: (r) => m.rows[r].efficiencyWth === Math.round(shared.calculator().efficiencyWth ?? 0),
  });
}

// GoMining's new miners at each efficiency it sells, at their list price per TH.
const listedMiners = () => [...new Set(shared.market.presets.map((row) => row.efficiencyWth))].sort((a, b) => a - b)
  .map((wth) => ({ efficiencyWth: wth, pricePerThUsd: listedPricePerTh(shared.market.presets, wth) }))
  .filter((m) => m.pricePerThUsd > 0);

// Fills a select once (or when the options change) and keeps the saved or current choice.
function fillSelect(select, options, key) {
  const values = options.map(([value]) => value);
  if ([...select.options].map((o) => o.value).join() !== values.join()) {
    const chosen = select.value || store.get(key);
    select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
    if (chosen && values.includes(chosen)) select.value = chosen;
  }
}

const halvingNote = () => {
  const h = shared.market.outlook?.halving;
  return h ? `The next halving (about ${new Date(h.estimatedDate).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}, in ~${num(h.daysLeft)} days) halves the BTC a TH earns; electricity saved by a better W/TH is paid in USD and doesn't halve.` : '';
};

function renderUpgrade() {
  const form = $('uc-form');
  const out = $('uc-out');
  const miners = listedMiners();
  fillSelect(form.elements.thSource, [
    ...miners.map((m) => [`new:${m.efficiencyWth}`, `A new GoMining miner · ${m.efficiencyWth} W/TH · ${usd(m.pricePerThUsd, 2)}/TH`]),
    ['upgrade', 'A power upgrade on this miner (your price)'],
  ], 'uc-form:thSource');
  const choice = form.elements.thSource.value;
  form.querySelector('[data-uc-price]').hidden = choice !== 'upgrade';
  const newMiner = choice.startsWith('new:') ? miners.find((m) => `new:${m.efficiencyWth}` === choice) : null;
  const powerTh = fieldNumber(form, 'powerTh');
  const efficiencyWth = fieldNumber(form, 'efficiencyWth');
  const budgetUsd = fieldNumber(form, 'budgetUsd');
  const { discountPct, kwhPriceUsd } = settings();
  try {
    const powerPricePerThUsd = choice === 'upgrade' ? fieldNumber(form, 'powerPricePerThUsd') : undefined;
    if (choice === 'upgrade' && !(powerPricePerThUsd > 0)) throw new Error('Enter the power-upgrade price per TH your app shows for this miner (My miners → Upgrade → Power), or pick a new GoMining miner instead.');
    const r = upgradeComparison(shared.market.income, shared.market.upgrades, { powerTh, efficiencyWth, budgetUsd, discountPct, kwhPriceUsd, powerPricePerThUsd, newMiner });
    const effOnly = r.bestEfficiency;
    const col = (label, value, sub, win) => { const box = el('div'); box.append(el('p', 'eyebrow', label), el('p', `calc-big${win ? ' win' : ''}`, value), el('p', 'calc-sub', sub)); return box; };
    const perDay = (row) => (row ? `+${usdSmart(row.gainUsdDay)}/day` : '—');
    const thWhere = r.power ? (r.power.source === 'newMiner' ? `on a new ${r.power.efficiencyWth} W/TH miner` : 'on this miner') : '';
    const head = el('div', 'vs-out');
    head.append(
      col('All on efficiency', perDay(effOnly), effOnly ? `→ ${effOnly.toWth} W/TH for ${usd(effOnly.costUsd, 2)} · ${usd(effOnly.gainUsdDay * 365, 2)}/yr · pays back in ${num(effOnly.paybackDays)} d` : 'The budget doesn\'t reach the next W/TH step', r.verdict === 'efficiency'),
      col('All on more TH', perDay(r.power), r.power ? `${num(r.power.addedTh, 2)} TH ${thWhere} · ${usd(r.power.gainUsdDay * 365, 2)}/yr${r.power.paybackDays ? ` · pays back in ${num(r.power.paybackDays)} d` : ' · never pays back at today\'s rates'}` : 'Choose where extra TH come from', r.verdict === 'power'),
      col('Best split', r.best ? perDay(r.best) : '—', r.best ? (r.best.toWth === null ? 'All on TH is best' : r.best.addedTh > 0 ? `→ ${r.best.toWth} W/TH (${usd(r.best.upgradeUsd, 2)}) + ${num(r.best.addedTh, 2)} TH (${usd(r.best.thUsd, 2)}) · pays back in ${num(r.best.paybackDays)} d` : 'All on efficiency is best') : 'Enter a budget', r.verdict === 'split'),
    );
    out.replaceChildren(head);
    if (r.combos.length) {
      table($('uc-combos'), ['Upgrade to', 'Upgrade cost', 'Extra TH', 'TH cost', 'Gain / day', 'Gain / year', 'Pays back'], r.combos.map((row) => [
        row.toWth === null ? 'no upgrade' : `${row.toWth} W/TH`, row.upgradeUsd ? usd(row.upgradeUsd, 2) : '—', row.addedTh ? num(row.addedTh, 2) : '—', row.thUsd ? usd(row.thUsd, 2) : '—',
        usdSmart(row.gainUsdDay), usd(row.gainUsdYear, 2), row.paybackDays ? `${num(row.paybackDays)} d` : 'never',
      ]), { highlight: (i) => r.combos[i] === r.best });
    } else $('uc-combos').replaceChildren(empty('Enter a budget to see the splits.'));
    if (r.efficiency.length) {
      table($('uc-steps'), ['Upgrade to', 'Cost', 'Saves / day', 'Pays back', 'In budget'], r.efficiency.map((row) => [
        `${row.toWth} W/TH`, usd(row.costUsd, 2), usdSmart(row.gainUsdDay), row.paybackDays ? `${num(row.paybackDays)} d` : 'never', row.affordable === null ? '—' : row.affordable ? 'yes' : 'no',
      ]));
    } else $('uc-steps').replaceChildren(empty('Already at the best efficiency GoMining upgrades to, or no step prices available.'));
    $('uc-note').textContent = `Efficiency steps are GoMining's live upgrade prices per TH, one W/TH at a time, so a deeper upgrade costs the sum of the steps. ${r.power?.source === 'newMiner' ? `Extra TH here are a new ${r.power.efficiencyWth} W/TH GoMining miner at its list price; a power upgrade on your own miner can cost less, and then mines at your miner's W/TH (after any upgrade): pick "A power upgrade on this miner" to use your app's price.` : 'Extra TH are a power upgrade on this miner at your price, so they mine at its W/TH after any upgrade in the same split.'} Uses the ${num(discountPct, 1)}% discount and the electricity rate from the calculator, at today's payout. ${halvingNote()}`;
  } catch (error) {
    out.replaceChildren(el('p', 'fine', error.message));
    $('uc-combos').replaceChildren();
    $('uc-steps').replaceChildren();
    $('uc-note').textContent = '';
  }
}

function renderEarnVsMine() {
  const form = $('evm-form');
  const out = $('evm-out');
  const miners = listedMiners();
  fillSelect(form.elements.efficiencyWth, miners.map((m) => [String(m.efficiencyWth), `New miner · ${m.efficiencyWth} W/TH · ${usd(m.pricePerThUsd, 2)}/TH`]), 'evm-form:efficiencyWth');
  fillSelect(form.elements.vipLevel, VIP_LEVELS.map((row) => [row.name, `${row.name} · ×${row.simpleEarnMultiplier}`]), 'evm-form:vipLevel');
  if (!store.get('evm-form:vipLevel') && form.elements.vipLevel.dataset.synced !== '1') { form.elements.vipLevel.value = shared.vipLevel(); form.elements.vipLevel.dataset.synced = '1'; }
  const miner = miners.find((m) => String(m.efficiencyWth) === form.elements.efficiencyWth.value);
  const { discountPct, kwhPriceUsd } = settings();
  try {
    if (form.elements.aprPct.value === '') throw new Error('Enter the Simple Earn APR your GoMining wallet shows for the asset you would hold (Wallet → Simple Earn).');
    const r = earnVsMinePlan(shared.market.income, {
      capitalUsd: fieldNumber(form, 'capitalUsd'), aprPct: fieldNumber(form, 'aprPct'), btcAprPct: fieldNumber(form, 'btcAprPct'), vipLevel: form.elements.vipLevel.value,
      miner, discountPct, kwhPriceUsd, days: fieldNumber(form, 'days'),
    });
    const se = r.payouts.simpleEarn;
    const mn = r.payouts.mining;
    // How each one pays.
    const pays = el('div', 'evm-pays');
    const payBox = (title, every, value, sub) => { const box = el('div', 'mini-stat'); box.append(el('p', 'tile-label', title), el('p', 'tile-value', value), el('p', 'tile-meta', `${every} · ${sub}`)); return box; };
    pays.append(
      payBox('Simple Earn pays', 'every 4 hours, 6 times a day', `${num(se.sats)} sats`, `≈ ${usdSmart(se.usd)} each at ${num(r.effectiveAprPct, 2)}% APR (${r.vipLevel})`),
      payBox('A new miner pays', 'once a day', `${num(mn.sats)} sats`, `≈ ${usdSmart(mn.usd)} net from ${num(r.end.mining.th, 2)} TH at ${miner.efficiencyWth} W/TH`),
      payBox('Simple Earn in TH adds', 'once a day', r.simpleEarnTh.available ? `${num(r.simpleEarnTh.thPerDay, 4)} TH` : '—', r.simpleEarnTh.available ? `10% more TH, at ${usd(r.simpleEarnTh.thPriceUsd, 2)}/TH, mining at ${r.simpleEarnTh.thEfficiencyWth} W/TH` : r.simpleEarnTh.reason),
    );
    const wrap = el('div', 'table-wrap');
    // What each strategy leaves you with at the end.
    const years = r.days / 365;
    const span = years === 1 ? '1 year' : `${num(years, years % 1 ? 1 : 0)} years`;
    const endCol = (label, value, lines, win) => { const box = el('div'); box.append(el('p', 'eyebrow', label), el('p', `calc-big${win ? ' win' : ''}`, value), ...lines.map((line) => el('p', 'calc-sub', line))); return box; };
    const e = r.end;
    // No winner is crowned: Simple Earn keeps the capital, the miner spends it and is kept, and
    // what a miner sells for later can't be known. The miner column says what it would have to be
    // worth by then to come out ahead.
    const ends = el('div', 'vs-out');
    ends.append(
      endCol(`Simple Earn, after ${span}`, `+${usdSmart(e.simpleEarn.rewardsUsd)}`, [`${num(e.simpleEarn.rewardsBtc, 6)} BTC in rewards${e.simpleEarn.compounding ? ', compounding at the BTC rate' : ''}`, `plus your ${usd(e.simpleEarn.capitalUsd, 0)}, still yours: ${usd(e.simpleEarn.capitalUsd + e.simpleEarn.rewardsUsd, 2)} in all`]),
      endCol(`Simple Earn in TH, after ${span}`, r.simpleEarnTh.available ? `${num(e.simpleEarnTh.th, 2)} TH` : `+${usdSmart(e.simpleEarnTh.paidInBtcUsd)}`, r.simpleEarnTh.available
        ? [`≈ ${usd(e.simpleEarnTh.thAtListPriceUsd, 2)} at today's list price, plus ${usdSmart(e.simpleEarnTh.minedUsd)} (${num(e.simpleEarnTh.minedBtc, 6)} BTC) mined by them`, `plus your ${usd(e.simpleEarnTh.capitalUsd, 0)}, still yours`]
        : [r.simpleEarnTh.reason]),
      endCol(`New miner, after ${span}`, `+${usdSmart(e.mining.minedUsd)}`, [
        `${num(e.mining.minedBtc, 6)} BTC mined by ${num(e.mining.th, 2)} TH; ${e.mining.paybackDay ? `the ${usd(e.mining.capitalSpentUsd, 0)} paid back on day ${num(e.mining.paybackDay)}` : `the ${usd(e.mining.capitalSpentUsd, 0)} isn't paid back yet`}`,
        e.mining.worthAtLeastUsd > 0 ? `Beats Simple Earn only if the miner is still worth over ${usd(e.mining.worthAtLeastUsd, 2)} (${usd(e.mining.worthAtLeastPerThUsd, 2)}/TH) by then` : 'Ahead of Simple Earn even if the miner were worth nothing by then',
      ]),
    );
    out.replaceChildren(pays, wrap, ends);
    const P = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };
    table(wrap, ['Period', 'Simple Earn (sats)', 'Simple Earn (USD)', 'New miner (sats)', 'New miner (USD)'], Object.keys(P).map((k) => [P[k], num(se.periods[k].sats), usdSmart(se.periods[k].usd), num(mn.periods[k].sats), usdSmart(mn.periods[k].usd)]));
    legendInto($('evm-legend'), [['Simple Earn rewards', SERIES[0]], ['New miner, mined', SERIES[1]], ...(r.simpleEarnTh.available ? [['Simple Earn in TH, mined by the TH', SERIES[2]]] : [])]);
    lineChart($('evm-chart'), {
      xLabels: r.months.map((row) => `M${Math.round(row.day / 30.4375)}`),
      series: [
        { name: 'Simple Earn', color: SERIES[0], values: r.months.map((row) => row.simpleEarnUsd) },
        { name: 'Miner', color: SERIES[1], values: r.months.map((row) => row.miningUsd) },
        ...(r.simpleEarnTh.available ? [{ name: 'In TH', color: SERIES[2], values: r.months.map((row) => row.simpleEarnThMinedUsd) }] : []),
      ],
      format: (v) => usd(v, 2),
      tickFormat: (v) => usd(v, 0),
      xTooltip: (_label, i) => `Day ${num(r.months[i].day)}${r.simpleEarnTh.available ? ` · ${num(r.months[i].simpleEarnTh, 2)} TH from Simple Earn` : ''}`,
      zeroBased: true,
      height: 240,
    });
  } catch (error) {
    out.replaceChildren(el('p', 'fine', error.message));
    $('evm-chart').replaceChildren();
    $('evm-legend').replaceChildren();
  }
}
