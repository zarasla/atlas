# GoMining MCP

An MCP server that lets Claude (Desktop or Claude Code) read GoMining data: the daily payout per TH, the miners GoMining sells and their prices, upgrade price tables, earnings and payback estimates, and, with your token, your own account data.

## Tools

| Tool | What it does | Needs token |
|---|---|---|
| `gomining_daily_reward` | Latest payout per TH (USD and sats), the BTC price used, electricity per W/TH, kWh price, service fee | No |
| `gomining_miner_prices` | Miners GoMining sells: TH, W/TH, price, price per TH. Filter by efficiency or budget | No |
| `gomining_upgrade_rates` | Per-W/TH valuation table and upgrade cost table | No |
| `gomining_calculate_earnings` | Daily and period gross, electricity, service and net (USD, sats, BTC), payback days and annual return | No |
| `gomining_api_request` | Calls any `https://api.gomining.com/api/...` endpoint and returns the JSON | For account endpoints |
| `gomining_status` | Shows the base URL, whether a token is set, whether writes are allowed | No |

The first four use GoMining's public endpoints, the same ones app.gomining.com calls without logging in:

- `POST /api/nft-income-aggregation/get-last`
- `GET /api/nft-collection/find-all-generative`
- `POST /api/nft/get-upgrade-rate`

Results are cached for 5 minutes. The payout changes once a day.

Earnings use today's payout and fees held constant: net = payout − (electricity per W/TH × W/TH) − service, per TH. Discounts from paying fees in GOMINING, VIP level and clan or league boosts are not included, so the net figure is a conservative baseline.

## Install

Requires Node.js 20 or newer.

```bash
cd gomining-mcp
npm install
npm test
```

## Connect it to Claude

### Claude Desktop

Edit `claude_desktop_config.json` (on Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "gomining": {
      "command": "node",
      "args": ["D:\\Projects\\atlas\\gomining-mcp\\src\\index.js"],
      "env": {
        "GOMINING_TOKEN": ""
      }
    }
  }
}
```

Change the path to wherever you cloned the repo. Leave `GOMINING_TOKEN` empty to use only the public tools.

### Claude Code

```bash
claude mcp add gomining -e GOMINING_TOKEN=your-token -- node /path/to/atlas/gomining-mcp/src/index.js
```

## Account data (token)

GoMining has no public API key for account data. The server uses the same bearer token the web app sends:

1. Log in at app.gomining.com in Chrome.
2. Open DevTools (F12) and go to the **Network** tab. Filter by `api.gomining.com`.
3. Click around the app (miners, wallet, clan) and select any request.
4. Under **Request Headers**, copy the value of `Authorization` after `Bearer `.
5. Put it in `GOMINING_TOKEN`.

The token gives full access to your GoMining account, so treat it like a password. Never commit it, and keep it only in your local Claude config. It expires when the web session does; when calls start returning HTTP 401, copy a fresh one.

GoMining does not document its account endpoints. To find one, look at the request path and body in the same Network tab, then ask Claude to call it, for example: "call `/nft/get-my-nfts` with body `{...}` via gomining_api_request". If you already mapped endpoints for the Mighty Goose bot, those paths work here too.

### Safety limits

- The token is only ever sent to the API host (`https://api.gomining.com`). Absolute URLs, `//host` and `..` paths are refused.
- The public market tools never send the token.
- `PUT`, `PATCH` and `DELETE` are blocked unless you set `GOMINING_ALLOW_WRITES=1`. GoMining also uses `POST` for some actions, so `POST` can't be blocked without blocking reads. Check what an endpoint does before asking Claude to call it.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GOMINING_TOKEN` | unset | Bearer token for account endpoints. A leading `Bearer ` is stripped |
| `GOMINING_BASE_URL` | `https://api.gomining.com/api` | API base URL |
| `GOMINING_ALLOW_WRITES` | unset | `1` allows PUT, PATCH and DELETE |

## Layout

```
src/index.js    stdio entry point, reads the environment
src/server.js   MCP tool definitions
src/client.js   HTTP client for api.gomining.com
src/calc.js     payout, price and earnings maths
test/           node:test suite against a fake GoMining API
```
