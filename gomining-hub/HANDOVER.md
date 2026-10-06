# HONKSQUAD · Mining HQ — handover

Everything a new team needs to run, change and deploy the website at **https://thegooses.online** and to set up the GoMining MCP connectors for Claude. Written 6 October 2026. Read sections 1–4 before touching anything.

> No secrets are in this file or anywhere in the repo (a test enforces it). The server address, SSH key and MCP access key are handed over privately by the owner — see [§11 Access checklist](#11-access-checklist).

---

## 1. Status at handover (6 Oct 2026)

| Item | State |
|---|---|
| Website https://thegooses.online | **Live**, HTTP 200, running commit `af22634` |
| Our remote MCP (`/mcp/<key>` on the same domain) | **Up**, 20 public-data tools |
| Our local MCP (stdio, on a PC) | Works; account tools only with the user's own token |
| GoMining's **official** MCP `https://mcp.gomining.com/mcp` | **Down** — the hostname does not exist in DNS (NXDOMAIN from Google and Cloudflare, checked 4 and 6 Oct). GoMining's docs still list it. Nothing we can fix; see §7.3 |
| Tests | 77 / 77 passing (`npm test`) |
| Code | Branch `claude/inspiring-gates-3sh557` of `github.com/zarasla/atlas`, folder `gomining-hub/` |
| Pull request | [zarasla/atlas#2](https://github.com/zarasla/atlas/pull/2), **open, not merged** (base: `claude/eager-wright-7pk1uh`, which is also the repo's default branch). Production is deployed from the PR branch |
| Miner Wars section | **Hidden** on the site at the owner's request (code kept, see §6) |

---

## 2. What the product is

A free, public GoMining website plus an MCP server for Claude. Both run on one shared data layer, so the numbers on the page and the numbers Claude quotes are always the same. It is **not** affiliated with GoMining.

Visitors use calculators on GoMining's live public data. They **never log in** and the site never touches anyone's GoMining account. For their *own* balances and rewards, players are pointed to GoMining's official MCP connector in Claude (currently down, §7.3).

Branding: the name stays **HONKSQUAD** ("HONKSQUAD · The Goose's · Mining HQ"), but the site shows **no HONKSQUAD clan data** (no member lists, no clan standings). That was an explicit owner decision.

---

## 3. The one rule: 100% accurate data

The owner's hard requirement. Every number on the site must come from:

1. **GoMining's live public API** (`https://api.gomining.com/api`, no token), or
2. **GoMining's own documentation** — https://docs.gomining.com (rules, formulas, tables) and the official VIP table at https://gomining.com/vip, or
3. A named public source: **mempool.space** (Bitcoin network), **CoinGecko** (prices), **alternative.me** (Fear & Greed).

Anything GoMining shows **only inside a user's account** is typed in by the visitor and **never guessed or defaulted**:

- the **Mining mode discount** (GoMining changes it weekly with the veGOMINING vote),
- **Simple Earn APRs** (set by GoMining, change often),
- a miner's **power-upgrade price** (depends on the miner's power level and isn't published).

Past mistakes that were removed, so they must not come back:

| Removed | Why |
|---|---|
| "Mining mode ≈ 1.2%" and "30.2% max discount" | Guessed. GoMining publishes only 20% (GOMINING) + 6% (VIP) + 3% (Service Button) = 29%, plus a variable Mining mode discount |
| VIP "referral activity" USD thresholds | Never published by GoMining (app-only) |
| Hard-coded Simple Earn APRs | Stale; the user enters their wallet's rate |
| Hard-coded Miner Wars league ids and Roman-numeral Dune names | Leagues now come from GoMining's league list (Dune 1–29, ids 5–33) |
| "Average multiplier ×2" | GoMining's published odds give ×2.5 |

**How to change a number safely:** find its source (doc page or endpoint), cite it in a code comment next to the constant, add or adjust a test in `test/`, and note the check date. Where the site *estimates* (projections, BTC price scenarios), the page must say so in plain words.

Key rules and where they come from (all docs.gomining.com, checked 4 Oct 2026):

| Rule | Value | Doc page |
|---|---|---|
| Net reward | payout − (electricity + service) × (1 − discounts) | Maintenance fees and discounts |
| GOMINING discount | 1% per 18 days of maintenance covered by wallet + locked GOMINING, max 20% at 360 days | same |
| VIP discount | 0% Bronze I … 6% Elite (full table in `src/core/calc.js` `VIP_LEVELS`, from gomining.com/vip) | VIP program |
| Service Button | +0.3% per consecutive UTC day, max 3% after 10 days | same |
| Reinvest into TH | miner 10–5,000 TH, better than 20 W/TH, ≥ $0.10/day; bonus +5% from Silver I, +10% from Diamond I; no fee | Rewards |
| Reinvest into GOMINING | 2.25% fee | Rewards |
| Simple Earn | min balance per full 4-hour cycle (6/day), APR × VIP multiplier, paid in BTC, or TH with +10% if the cycle earns ≥ $0.10 | Simple Earn |
| Miner Wars PPS | TH × 20 / W/TH | Game Mechanics |
| Miner Wars maintenance | full week on all TH, floored at zero; excess over Mining-mode output at league average W/TH and discount; joining day earns no Mining mode reward | Rewards (Miner Wars) |
| veGOMINING votes | tokens × lock days / 1,461 (4 years), falling linearly to 0 — matches GoMining's own lock statistics | veGOMINING & Locks |
| Burn & Mint | minted = (1 − V × (1 − C)) × burned; epoch table with C = 0.80…0.99 | Voting, Epochs |

GoMining's open-source AI skills (`github.com/gomining-ai/gomining-agent-skills`) are **less reliable** than the docs and the VIP page; don't use them as a source.

---

## 4. Architecture

```
gomining-hub/
  src/core/
    client.js      GoMining HTTP client; refuses any host but api.gomining.com; token only if configured
    calc.js        ALL the maths (fees, discounts, VIP, Simple Earn, plans, Miner Wars, veGOMINING, Burn & Mint).
                   Served unchanged to the browser at /lib/calc.js, so page and server compute identically
    market.js      payout, miner prices, upgrade rates (5-min cache, sample-data fallback, daily history file)
    external.js    mempool.space, CoinGecko (prices, top coins minus stablecoins, 365-day history), alternative.me
    platform.js    platform stats, marketplace stats, veGOMINING stats, Burn & Mint, epochs, spells
    minerwars.js   leagues, any league's clan board, clan search across leagues
    cache.js       shared TTL cache: one request per key per period, 10-min back-off after failure, stale fallback
    ticker.js      ticker bar data (BTC + GOMINING pinned, top coins scrolling)
    config.js      wires everything from environment variables
  src/web/server.js   static site + JSON API + remote MCP endpoint (no framework, Node 20+)
  src/mcp/            MCP server (server.js = tools, index.js = stdio entry for local use)
  public/             the page: index.html, app.css, app.js (main), ui.js (helpers), charts.js (SVG charts),
                      planning.js, token.js, platform.js, minerwars.js (currently not loaded)
  data/               sample-snapshot.json (offline fallback); history.json written at runtime locally
  deploy/             install.sh, update.sh, check.sh, switch-domain.sh, systemd unit, nginx/Caddy examples
  test/               node:test suite against a fake GoMining API (fake-api.js)
```

Data flow: browser → our server (`/api/...`) → cached calls to GoMining/CoinGecko/mempool. **Visitors never call GoMining or CoinGecko directly**, so a busy page can't get the server rate-limited. Every cache backs off after a failure and serves the last good answer, marked as stale.

When GoMining is unreachable, payout, prices and upgrade rates fall back to `data/sample-snapshot.json` (real responses from 9 Sep 2026). The page then shows a yellow "Sample data" badge, and MCP tools return `dataSource: "sample"`. Other parts show "unavailable", never invented numbers.

### Public GoMining endpoints used (no token)

| Endpoint | Used for |
|---|---|
| `POST /nft-income-aggregation/get-last` | daily payout per TH, BTC rate used, electricity per W/TH, service fee |
| `GET /nft-collection/find-all-generative` | new miners GoMining sells, with prices |
| `POST /nft/get-upgrade-rate` | W/TH upgrade step prices |
| `POST /nft-game/league/index` (body `calculatedAt` = cycle start, Tuesday 00:00 UTC) | Miner Wars leagues and multiplier odds |
| `POST /nft-game/clan-leaderboard/index-v2` (50 per page max) | clan boards |
| `POST /nft-game/nft-game-ability/find-all` | spells and prices |
| `GET /platform-statistics`, `POST /nft/marketplace-statistics` | platform counters |
| `POST /ve-gomining-lock/statistics` | veGOMINING totals and `yearlyIncomePerVote` |
| `POST /mint-and-burn/index`, `POST /mint-and-burn/get-epoch-start-date` | Burn & Mint history, epoch start |

GoMining's own calculator page uses `https://gomining.com/api/nft-income-statistic?limit=1`. It gives the same sats/TH and is a good cross-check.

---

## 5. The website today

Section menu: **Today · Calculators · Planning · GOMINING · Platform · Market & miners · History**

- **Today:**
  - Net reward per TH and the main stats.
  - Break-even BTC price per W/TH.
  - Halving countdown and Fear & Greed.
- **Calculators:**
  - Goose Calculator: rewards by period, plus an investment plan that reinvests day by day under GoMining's rules.
  - Discount builder, with the Mining mode % typed in.
  - VIP level (official table) and Simple Earn (7 assets, APR typed in, BTC or TH rewards).
  - "My miners", stored in the browser only.
  - Copy-link sharing for Discord.
- **Planning:**
  - Profit matrix by BTC price × W/TH.
  - Better efficiency or more TH: every split of a budget, extra TH from a new miner or the user's own upgrade price, halving note.
  - Simple Earn or mining: 4-hourly vs daily payouts, Simple Earn in TH, optional BTC compounding, 1–3 year chart, and what the miner must still be worth to beat Simple Earn. No winner is crowned, on purpose.
- **GOMINING:**
  - Burn & Mint history since 2023 and epoch progress.
  - veGOMINING lock simulator.
  - Price calendar heatmap for BTC and GOMINING.
- **Platform:**
  - GoMining's public counters.
  - "Your own stats in Claude": steps for GoMining's official MCP (currently down, see §10).
- **Market & miners:** payout split, net by efficiency, difficulty adjustment, miner payback, miner prices, upgrade advisor.
- **History:** recorded once per payout day by our server, because GoMining has no history endpoint.
- **Header:**
  - Ticker: BTC and GOMINING pinned. The other top coins scroll **with stablecoins removed**, using CoinGecko's stablecoin category. It **always rotates**, at half speed for reduced-motion users; the owner asked for that.
  - "Feed the Goose" BTC donation address.

Owner decisions to respect:
- Keep the HONKSQUAD name.
- No clan data.
- The ticker always rotates and shows no stablecoins.
- Never guess account-only numbers.
- Don't crown a winner where capital is kept on one side and spent on the other.
- Mobile layout must work at 375 px with no sideways scroll.

---

## 6. Miner Wars (hidden for now)

Removed from the page in commit `af22634` at the owner's request. Still in place:

- `public/minerwars.js` (league explorer, clan search, week-in-a-clan vs mining, best clan for your miners with a "blocks vs power" ratio, PPS and odds, spells).
- API routes `/api/minerwars/leagues`, `/board?league=`, `/search?q=`, `/spells`.
- MCP tools `gomining_miner_wars_leagues`, `gomining_miner_wars_board`, `gomining_clan_finder`, `gomining_spells`.

**To bring it back:** restore the `g-mw` section in `public/index.html` from commit `37df028`, plus the menu link and the three `minerwars.js` lines in `public/app.js` (import, `refreshMinerWars()` in `renderAll`, `initMinerWars(shared)` at the bottom). `git diff 37df028 af22634 -- gomining-hub/public` shows exactly what was removed.

---

## 7. MCP connectors — how to set them up ("rig")

There are three different things. Don't mix them up.

### 7.1 Our remote MCP (public data, for anyone with the URL)

- URL: `https://thegooses.online/mcp/<MCP_ACCESS_KEY>`. The key is 64 hex characters, generated on the server by `install.sh`. It lives in `/etc/gomining-hub.env` (root-only), and the owner hands it over privately. **The full URL is the secret**: anyone with it can use the tools, so never commit it or paste it publicly.
- Any other path, or a wrong key, gets a plain 404.
- Tools (20): `daily_reward, miner_prices, upgrade_rates, efficiency_curve, miner_roi, upgrade_advisor, network_stats, outlook, maintenance_discount, vip, miner_wars_leagues, miner_wars_board, clan_finder, spells, platform_stats, tokenomics, planner, calculate_earnings, payout_history, status` (all prefixed `gomining_`).
- It **never loads a GoMining token** and has **no raw API passthrough**, so a leaked URL can't reach anyone's account.
- **Connect in Claude:** Customize → Connectors → + → Add custom connector → name "GoMining Hub" → paste the URL → Add. Test it with "Run gomining_status": it should answer `marketData: "live"`.
- **Rotate the key** if it leaks: on the server, edit `MCP_ACCESS_KEY` in `/etc/gomining-hub.env` (keep it 32+ characters, e.g. `openssl rand -hex 32`), run `systemctl restart gomining-hub`, and re-add the connector everywhere with the new URL.

### 7.2 Our local MCP (on a PC, can use the user's own GoMining token)

Adds `gomining_api_request`, which can call any GoMining endpoint with the user's token. Set it up only for someone who understands that the token is **full access to their GoMining account**.

```bash
claude mcp add gomining -e GOMINING_TOKEN=<token> -- node /path/to/atlas/gomining-hub/src/mcp/index.js
```

Or in Claude Desktop's `claude_desktop_config.json`: `"command": "node", "args": ["<path>/gomining-hub/src/mcp/index.js"], "env": { "GOMINING_TOKEN": "" }`. Leave the token empty for public tools only.

- **Getting a token:** log in at app.gomining.com, open DevTools → Network, filter `api.gomining.com`, and copy the `Authorization` value after `Bearer `. It expires; HTTP 401 means copy a fresh one.
- **Safeguards built in:**
  - The token is only ever sent to `https://api.gomining.com`.
  - Writes (PUT, PATCH, DELETE) are blocked unless `GOMINING_ALLOW_WRITES=1`.
  - GoMining uses POST for some actions, so check what an endpoint does before calling it.

### 7.3 GoMining's official MCP (personal account data, read-only) — currently DOWN

- Documented at docs.gomining.com → GoMining AI → MCP Server. URL `https://mcp.gomining.com/mcp`. It signs in with the user's GoMining account (OAuth), and has read-only tools for wallet, miners, rewards, VIP, Simple Earn (including live APRs), staking, cards, referrals, marketplace and Miner Wars income.
- **Status: the hostname doesn't resolve** (NXDOMAIN, checked 4 Oct and 6 Oct 2026), even though `app.` and `api.gomining.com` work. It's offline or moved on GoMining's side.
- **Check before telling anyone it works:**
  ```bash
  curl -s "https://dns.google/resolve?name=mcp.gomining.com&type=A"
  ```
  `"Status":0` with an `Answer` means it's back; `"Status":3` means still missing. Then test with a POST `initialize` request: a 401 or an OAuth challenge means it's alive.
- **When it's back:** sign in at app.gomining.com in the browser, then in Claude go to Customize → Connectors → + → Add custom connector → name "GoMining" → URL `https://mcp.gomining.com/mcp` → Connect, and approve GoMining's consent screen.
- **Impact on our site:** the Platform card "Your own stats in Claude" tells players to use this URL. The owner was offered two fixes, not yet decided: (a) a live up/down badge checked by our server, or (b) hiding the card until it's back. Ask the owner.

---

## 8. Hosting and operations

**Server:** Ubuntu 24.04 VPS, Node 22, **nginx** with Let's Encrypt via certbot (auto-renew timer active). Domain `thegooses.online` (+ `www`). The owner's PC reaches it with the SSH alias `goose-vps` (root, key auth). The address and key are not in this repo.

| What | Where |
|---|---|
| App code (what runs) | `/opt/gomining-hub` (owned by root, read-only to the service) |
| Deploy checkout | `/tmp/atlas` (git clone of the repo on the PR branch) |
| Service | `gomining-hub.service`, user `gominghub` (no shell), listens on `127.0.0.1:4173` only |
| Secrets | `/etc/gomining-hub.env` (root-only): `MCP_ACCESS_KEY` set; `GOMINING_TOKEN` is commented out and must stay out (the site never uses it) |
| Payout history | `/var/lib/gomining-hub/history.json` (kept across deploys; GoMining has no history API, so don't delete it) |
| nginx site | `/etc/nginx/sites-enabled/gomining-hub` → proxy to 127.0.0.1:4173 |

**The same VPS runs other people's services. Do not stop, restart or edit them:** `mw-bot*` (GoMining Discord bot plus browser/VNC), `casahunter*`, `goose-dashboard-*`, `sentinela`, `hyperscalp`, and the nginx sites `casahunter`, `hyperscalp`, `sentinela`, `tiago-costa`. Only ever reload nginx after `nginx -t` passes. Disk: about 12 GB free of 38 GB.

### Deploy an update (what we did for every release)

```bash
# 1. on your PC: test, commit and push the branch
cd gomining-hub && npm test
git push origin claude/inspiring-gates-3sh557
# 2. on the server: pull and run the updater
ssh goose-vps 'cd /tmp/atlas && git fetch -q origin && git reset -q --hard origin/claude/inspiring-gates-3sh557 && bash gomining-hub/deploy/update.sh'
# 3. check
curl -s -o /dev/null -w "%{http_code}\n" https://thegooses.online/api/market   # expect 200
```

`update.sh` rsyncs the app into `/opt/gomining-hub` (keeping history, env and node_modules out of the copy), runs `npm ci --omit=dev`, reinstalls the systemd unit and restarts the service. It checks `/api/market` and prints the journal if the service doesn't come back. It doesn't touch nginx, certificates, the env file or other services.

To confirm the server runs exactly the commit you pushed:

```bash
ssh goose-vps 'git -C /tmp/atlas log --oneline -1; diff -rq --exclude node_modules --exclude docs --exclude test --exclude history.json /tmp/atlas/gomining-hub /opt/gomining-hub && echo LIVE == COMMIT'
```

**Rollback:** run the same deploy with `git reset --hard <previous-commit>` in `/tmp/atlas`, then `update.sh`.

**Logs and health:** `systemctl status gomining-hub`, `journalctl -u gomining-hub -f`. `bash deploy/check.sh thegooses.online` is a read-only overview of the box.

**Known operational quirk:** CoinGecko's free API rate-limits by IP. Two restarts within a few minutes can give HTTP 429 for about 2 minutes, during which the ticker is empty and prices show "unavailable". It recovers by itself; don't restart again to "fix" it.

---

## 9. Local development

```bash
cd gomining-hub
npm install
npm test        # 77 tests, includes a scan that fails on any committed secret or public IP address
npm start       # http://127.0.0.1:4173 (PORT / HOST to change)
```

- The owner's Claude Code desktop preview config is a `gomining-hub` entry in `D:\.claude\launch.json` (port 4173).
- Design: dark navy / electric blue / gold (Russo One headings). Charts are a small SVG kit in `public/charts.js` with tooltips. All text goes in via `textContent`, never HTML. Strict Content-Security-Policy (same-origin only, Google Fonts allowed).
- **Line endings:** some files are CRLF (Windows). Multi-line search-and-replace in scripts can silently miss; check that a replace actually changed something.

---

## 10. Open items / backlog (prioritised)

1. **Official GoMining MCP down** (§7.3): decide with the owner between a live status badge on the Platform card and hiding the card.
2. **Merge strategy:** PR #2 is open into `claude/eager-wright-7pk1uh` (the repo's default branch, an unusual name for a main branch). Agree with the owner which branch is "main", then merge, and deploy from that branch from then on. Update §8's commands.
3. **Screenshot:** `docs/dashboard.png` is an old screenshot of the dashboard (README deploy and design notes were updated with this handover).
4. **Ticker:** tokenized dollar funds (BUIDL, USYC, USDY, FIGR_HELOC) and gold tokens (XAUT, PAXG) still show; they aren't in CoinGecko's stablecoin category. The owner was asked whether to remove them; no answer yet.
5. **Estimates to keep clearly labelled:**
   - Simple Earn TH rewards are priced at the new-miner list price; GoMining uses its power-upgrade price on the day, which isn't public.
   - Miner Wars weekly projections treat rounds as equal, because multipliers can't be known in advance.
   - All plans are pre-halving, at today's BTC price and difficulty.
6. **Miner Wars:** hidden (§6). If restored, re-check the clan finder against a real cycle: spell-driven clans make projections volatile.
7. **gominingcalculator.com features deliberately not built:** round replay "DVR", live sales stream, chat, bounties, GoBox odds. They need logins, private data or user accounts, and can't meet the accuracy rule.

---

## 11. Access checklist

The owner (GitHub `zarasla`) must give the new team, privately:

- [ ] Write access to `github.com/zarasla/atlas`.
- [ ] SSH access to the VPS: the address, plus the team's own SSH public key added to the server. Don't share the owner's key.
- [ ] The current `MCP_ACCESS_KEY`, or rotate it (§7.1) and share the new connector URL.
- [ ] Access to the domain registrar / DNS for `thegooses.online`, if DNS changes are expected.
- [ ] Contact for the other services on the same VPS (Discord bot etc.), so nobody disrupts them.

Never needed and never to be stored anywhere: anyone's GoMining login or bearer token. The site doesn't use one.

---

## 12. Change log of this rebuild (most recent first)

| Commit | Change |
|---|---|
| `af22634` | Miner Wars section taken off the site (code kept) |
| `37df028` | Planning cards developed: budget splits, Simple Earn 4-hourly vs mining daily, TH rewards, compounding, chart |
| `cf3ce15` | Stablecoins removed from the ticker (CoinGecko category) |
| `74eba9a` | Ticker rotates again with reduced motion (half speed) |
| `3370ed1` | Rebuild: official data only, HONKSQUAD clan data removed, new planning/token/platform tools, generic Miner Wars, MCP tools to match |
| `5cdaec1` and earlier | Original dashboard, calculator, discount builder, VIP/Simple Earn, ticker, deploy scripts |
