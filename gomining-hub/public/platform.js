// GoMining platform statistics, and the copy button for the official MCP connector URL.

import { $, compact, el, empty, getJson, num, stat, time, usd } from './ui.js';

export function initPlatform() {
  $('mcp-copy').addEventListener('click', async () => {
    const button = $('mcp-copy');
    const url = $('mcp-url').textContent;
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = 'Copied!';
    } catch {
      window.prompt('Copy the GoMining MCP server URL:', url);
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 2000);
  });
  load();
  setInterval(load, 10 * 60_000);
}

async function load() {
  try {
    render(await getJson('/api/platform'));
  } catch (error) {
    $('pf-body').replaceChildren(empty(`GoMining's statistics are unavailable right now (${error.message}).`));
  }
}

const plus = (value) => (value === null || value === undefined ? ' ' : `${value >= 0 ? '+' : ''}${num(value)} in a day`);
const big = (value, digits = 2) => (value === null || value === undefined ? '—' : compact(value, digits));

function render(p) {
  $('pf-sub').textContent = `GoMining's public statistics, with its own one-day changes · updated ${time(p.asOf ?? p.updatedAt)}${p.stale ? ' (last good reading)' : ''}`;
  const strip = el('div', 'stat-strip');
  strip.append(
    stat('Users mining', big(p.users.mining), plus(p.lastDay.miningUsers)),
    stat('Total hashrate', p.hashrateTh === null ? '—' : `${num(p.hashrateTh / 1e6, 2)} EH/s`, p.lastDay.hashrateTh === null ? ' ' : `${p.lastDay.hashrateTh >= 0 ? '+' : ''}${num(p.lastDay.hashrateTh)} TH in a day`),
    stat('Registered users', big(p.users.registered), plus(p.lastDay.registered)),
    stat('Miner holders', big(p.users.holders), p.miners.total === null ? ' ' : `${big(p.miners.total)} miners`),
    stat('Upgrades made', big(p.miners.upgrades), plus(p.lastDay.upgrades)),
    stat('BTC paid out', p.btcPaid.total === null ? '—' : `${num(p.btcPaid.total, 0)} BTC`, p.btcPaid.minerWars === null ? ' ' : `${num(p.btcPaid.minerWars, 0)} BTC in Miner Wars`),
    stat('Miner Wars players', big(p.users.minerWars), 'registered'),
    stat('Simple Earn users', big(p.users.simpleEarn), plus(p.lastDay.simpleEarn)),
    stat('GOMINING locked', big(p.tokensLocked), p.lastDay.tokensLocked === null ? ' ' : `${p.lastDay.tokensLocked >= 0 ? '+' : ''}${compact(p.lastDay.tokensLocked, 1)} in a day`),
    stat('veGOMINING votes', p.ve ? big(p.ve.votes) : '—', p.ve?.yearlyIncomePerVote ? `${num(p.ve.yearlyIncomePerVote, 2)} GOMINING per vote a year` : ' '),
    stat('Secondary market', p.secondaryMarket.totalUsd === null ? '—' : `$${compact(p.secondaryMarket.totalUsd, 1)}`, p.secondaryMarket.lastWeekUsd === null ? ' ' : `${usd(p.secondaryMarket.lastWeekUsd, 0)} last week`),
    stat('Cards issued', big(p.users.cards, 1), 'GoMining Visa'),
  );
  $('pf-body').replaceChildren(strip);
}
