// Planning tools: profit by BTC price and efficiency, efficiency-vs-power upgrades, and Simple Earn
// versus mining. Everything runs in the browser on the same maths the server uses (/lib/calc.js).

import { breakEvenMatrix, listedPricePerTh, simpleEarnVsMining, upgradeComparison } from '/lib/calc.js';
import { $, bold, el, empty, fieldNumber, num, store, table, usd, usdSmart } from './ui.js';

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

function renderUpgrade() {
  const form = $('uc-form');
  const out = $('uc-out');
  const presets = shared.market.presets;
  const powerTh = fieldNumber(form, 'powerTh');
  const efficiencyWth = fieldNumber(form, 'efficiencyWth');
  const listed = efficiencyWth ? listedPricePerTh(presets, Math.round(efficiencyWth)) : null;
  form.elements.powerPricePerThUsd.placeholder = listed ? `List price ${usd(listed, 2)}` : 'Your power-upgrade price';
  const { discountPct, kwhPriceUsd } = settings();
  try {
    const powerPricePerThUsd = fieldNumber(form, 'powerPricePerThUsd') ?? listed ?? undefined;
    const r = upgradeComparison(shared.market.income, shared.market.upgrades, { powerTh, efficiencyWth, budgetUsd: fieldNumber(form, 'budgetUsd'), discountPct, kwhPriceUsd, powerPricePerThUsd });
    const nodes = [];
    const verdict = el('p', 'verdict');
    if (!r.verdict) verdict.append('Enter a budget to compare.');
    else if (r.verdict === 'efficiency') verdict.append('Better: ', bold(`upgrade to ${r.bestEfficiency.toWth} W/TH`), ` for ${usd(r.bestEfficiency.costUsd, 2)}, +${usdSmart(r.bestEfficiency.gainUsdDay)} a day.`);
    else verdict.append('Better: ', bold(`add ${num(r.power.addedTh, 2)} TH`), ` for ${usd(r.power.costUsd, 2)}, +${usdSmart(r.power.gainUsdDay)} a day.`);
    nodes.push(verdict);
    if (r.power) {
      nodes.push(el('p', 'fine', `More TH: ${num(r.power.addedTh, 2)} TH at ${usd(r.power.pricePerThUsd, 2)}/TH${fieldNumber(form, 'powerPricePerThUsd') ? '' : ' (GoMining new-miner list price)'} earns ${usdSmart(r.power.gainUsdDay)} a day at ${usdSmart(r.netPerThDayUsd)} per TH net${r.power.paybackDays ? ` and pays back in ${num(r.power.paybackDays)} days` : ', which never pays back at today\'s rates'}.`));
    } else if (!listed) {
      nodes.push(el('p', 'fine', `GoMining lists no new miners at ${Math.round(efficiencyWth)} W/TH: enter your power-upgrade price per TH to compare.`));
    }
    const wrap = el('div', 'table-wrap');
    nodes.push(wrap);
    out.replaceChildren(...nodes);
    if (!r.efficiency.length) { wrap.replaceChildren(empty('Already at the best efficiency GoMining upgrades to, or no step prices available.')); return; }
    table(wrap, ['Upgrade to', 'Cost', 'Saves / day', 'Pays back', 'In budget'], r.efficiency.map((row) => [
      `${row.toWth} W/TH`, usd(row.costUsd, 2), usdSmart(row.gainUsdDay), row.paybackDays ? `${num(row.paybackDays)} d` : 'never', row.affordable === null ? '—' : row.affordable ? 'yes' : 'no',
    ]), { highlight: (i) => r.verdict === 'efficiency' && r.efficiency[i] === r.bestEfficiency });
  } catch (error) {
    out.replaceChildren(el('p', 'fine', error.message));
  }
}

function renderEarnVsMine() {
  const form = $('evm-form');
  const out = $('evm-out');
  const presets = shared.market.presets;
  const select = form.elements.efficiencyWth;
  const efficiencies = [...new Set(presets.map((row) => row.efficiencyWth))].sort((a, b) => a - b);
  if (select.options.length !== efficiencies.length) {
    const chosen = select.value || store.get('evm-form:efficiencyWth');
    select.replaceChildren(...efficiencies.map((e) => new Option(`${e} W/TH · ${usd(listedPricePerTh(presets, e), 2)}/TH`, String(e))));
    if (chosen && efficiencies.includes(Number(chosen))) select.value = chosen;
  }
  const efficiencyWth = Number(select.value);
  const { discountPct, kwhPriceUsd } = settings();
  try {
    if (form.elements.aprPct.value === '') throw new Error('Enter the Simple Earn APR your GoMining wallet shows for the asset you would hold.');
    const r = simpleEarnVsMining(shared.market.income, {
      capitalUsd: fieldNumber(form, 'capitalUsd'), aprPct: fieldNumber(form, 'aprPct'), vipLevel: shared.vipLevel(),
      efficiencyWth, pricePerThUsd: listedPricePerTh(presets, efficiencyWth), discountPct, kwhPriceUsd,
    });
    const col = (label, value, sub, win) => { const box = el('div'); box.append(el('p', 'eyebrow', label), el('p', `calc-big${win ? ' win' : ''}`, value), el('p', 'calc-sub', sub)); return box; };
    const head = el('div', 'vs-out');
    head.append(
      col('Simple Earn', `${usdSmart(r.simpleEarn.yearUsd)}/yr`, `${num(r.simpleEarn.aprPct, 2)}% APR with your VIP · ${usdSmart(r.simpleEarn.monthUsd)}/month · capital kept`, r.better === 'simpleEarn'),
      col('Mining', `${usdSmart(r.mining.yearUsd)}/yr`, `${num(r.mining.th, 2)} TH at ${efficiencyWth} W/TH · ${num(r.mining.returnPct, 1)}% a year${r.mining.paybackDays ? ` · pays back in ${num(r.mining.paybackDays)} d` : ''}`, r.better === 'mining'),
    );
    out.replaceChildren(head);
  } catch (error) {
    out.replaceChildren(el('p', 'fine', error.message));
  }
}
