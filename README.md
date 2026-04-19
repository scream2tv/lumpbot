# Lump Bot

Production-ready Discord bot for Cardano native-asset intelligence, inspired by Rick App on Solana. Lump Bot listens for Cardano Policy IDs in monitored channels, enriches them with on-chain and market data, and posts a clean embed to an alert channel.

## Features

- **Policy ID auto-detection** — regex scan of every message for 56-char hex Policy IDs (and asset fingerprints, auto-resolved to a policy).
- **On-chain metadata** — assets under the policy, sample asset names, first mint tx via [Blockfrost](https://blockfrost.io) with optional [Koios](https://koios.rest) fallback.
- **Market data** — price, liquidity, 24h volume, 24h change and trading pairs via [DexHunter](https://dexhunter.io).
- **Alpha alerts** — first-ever sighting of a Policy ID pings a configurable `@Alpha` role with a dedicated color.
- **Tracked policies** — add/remove/list Policy IDs via `/verify` for enhanced alerts.
- **Manual lookup** — `/lookup` for ad-hoc Policy ID or asset-fingerprint queries.
- **Resilient** — graceful DexHunter → skip, Blockfrost → Koios fallback, rate limiting, per-channel debounce, SQLite persistence, optional external webhook fanout.

## Project layout

```
src/
├── commands/       Slash commands (/verify, /lookup)
├── events/         Discord event handlers (ready, messageCreate, interactionCreate)
├── services/       Blockfrost, DexHunter, Storage, Alert pipeline
├── utils/          Logger, regex, formatters, rate limiter, embed builder
├── botContext.ts   DI container shared across handlers
├── config.ts       Environment loader & validation
├── deploy-commands.ts  CLI to register slash commands
└── index.ts        Bot entry point
```

## Requirements

- Node.js 18.17+ (Node 20 LTS recommended)
- A Discord application and bot token (Developer Portal → Applications → New Application)
- Intents enabled: **Message Content Intent** and **Server Members Intent** (optional for role mentions)
- A Blockfrost mainnet project (`mainnetXXXX`)
- Optional: DexHunter partner API credentials

## Setup

```bash
git clone https://github.com/scream2tv/lumpbot.git
cd lumpbot
npm install
cp .env.example .env
# fill in the values
```

Invite the bot to your guild with permissions `Send Messages`, `Embed Links`, `Read Message History`, and the `applications.commands` scope.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token |
| `CLIENT_ID` | yes | Application/client ID |
| `GUILD_ID` | yes | Primary guild (used for guild-scoped slash command registration) |
| `ALERT_CHANNEL_ID` | yes | Channel where embeds are posted |
| `MONITORED_CHANNEL_IDS` | no | Comma-separated channel allow-list; empty = all channels the bot can read |
| `ALPHA_ROLE_ID` | no | Role pinged on first-seen policies |
| `BLOCKFROST_API_KEY` | yes | Blockfrost project ID |
| `BLOCKFROST_NETWORK` | no | `mainnet` (default), `preprod`, or `preview` |
| `DEXHUNTER_API_KEY` | no | DexHunter partner key (optional) |
| `DEXHUNTER_PARTNER_ID` | no | DexHunter partner ID (optional) |
| `KOIOS_BASE_URL` | no | Koios fallback base URL |
| `KOIOS_API_KEY` | no | Koios bearer token (optional) |
| `SNEK_BASE_URL` | no | Snek.fun analytics base URL, default `https://analytics.snek.fun` |
| `DATABASE_PATH` | no | SQLite path, default `./data/lumpbot.sqlite`. On Railway set to `/data/lumpbot.sqlite` |
| `EXTERNAL_WEBHOOK_URL` | no | POST each alert payload to this URL |
| `LOG_LEVEL` | no | `debug` / `info` / `warn` / `error` |

### Register slash commands

Guild-scoped (instant, recommended while developing):

```bash
npm run build
npm run deploy
```

Global (rolls out in up to an hour):

```bash
npm run deploy -- --global
```

### Run locally

```bash
npm run dev        # ts-node-dev with hot reload
# or
npm run build && npm start
```

Post a message containing a 56-char hex Policy ID in a monitored channel; the embed should land in `ALERT_CHANNEL_ID`.

## Deploying to Railway

Railway is the fastest managed path: connect the repo, set env vars, attach a volume for the SQLite file. A `railway.json` in the repo pins the builder and restart policy.

### 1. Create the project

- Sign in at https://railway.com and create a new project.
- Choose **Deploy from GitHub repo** and pick your fork of `lumpbot`.
- Railway will auto-detect Node via Nixpacks, run `npm install && npm run build`, and start with `npm start`.

### 2. Attach a persistent volume

The SQLite database (sightings, tracked policies, call records) must survive restarts/redeploys.

- In the service's **Settings → Volumes**, add a new volume.
- Mount path: `/data`
- Size: 1 GB is plenty.

### 3. Set environment variables

In the service's **Variables** tab, paste the contents of your filled-in `.env` (omit comments). Add one extra var so SQLite writes to the mounted volume:

```
DATABASE_PATH=/data/lumpbot.sqlite
```

See [Environment variables](#environment-variables) for the full list.

### 4. Register slash commands (one-off)

Slash commands have to be registered once per guild. Easiest way: run the deploy script from your laptop against the same secrets:

```bash
npm run deploy
```

That calls the Discord REST API directly; it doesn't need the bot to be running on Railway. Re-run only when you add or rename commands.

### 5. Verify & tail logs

- Railway's **Deployments → Logs** should show `Lump Bot is online as ...` within a few seconds.
- Post a 56-char policy ID (or a full asset id) in a monitored channel — the embed should land in `ALERT_CHANNEL_ID`.

### Backups

Railway volumes are replicated but not versioned. For off-box backups, add a lightweight cron (e.g. a second Railway service, GitHub Actions, or a local script) that runs:

```bash
sqlite3 /data/lumpbot.sqlite ".backup '/data/lumpbot-$(date -u +%F).sqlite'"
```

and rotates old copies.

### Postgres (optional, not required)

The bot runs on SQLite by default because a single Discord bot instance gets no benefit from a shared database. If you later want managed backups or plan to run multiple instances, the storage layer can be swapped to Railway's managed Postgres plugin without changing anything else in the app — the public `StorageService` API is already abstracted from its SQL dialect. Not implemented yet; open an issue if you want this.

## VPS deployment (alternative)

Any small Ubuntu box works if you'd rather self-host than use Railway. Install Node 20 and pm2, clone the repo, populate `.env`, then:

```bash
npm ci
npm run build
npm run deploy
pm2 start dist/index.js --name lumpbot --time
pm2 save && pm2 startup
```

Back up `./data/lumpbot.sqlite` on a cron. If you prefer systemd, a minimal unit file:

```ini
# /etc/systemd/system/lumpbot.service
[Unit]
Description=Lump Bot (Cardano Discord)
After=network.target

[Service]
Type=simple
User=lumpbot
WorkingDirectory=/opt/lumpbot
EnvironmentFile=/opt/lumpbot/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Commands

| Command | Description |
| --- | --- |
| `/verify add policy_id:<id> [label:<name>]` | Track a policy for enhanced alerts (requires `Manage Guild`) |
| `/verify remove policy_id:<id>` | Untrack a policy |
| `/verify list` | Show all tracked policies |
| `/lookup target:<policy_id or asset1…>` | Manually generate an embed for a policy or fingerprint |

## FDV and Snek.fun data

The primary market stat in the embed and in the "first caller" footer is **FDV** (fully-diluted value), sourced from Snek.fun's `analytics.snek.fun` API. Specifically:

- **FDV** — `metrics.marketCap` from `GET /v1/pools-feed/initial/state`. Cardano bonding-curve tokens mint their full supply at launch, so market cap and FDV are the same number in practice. Amounts come back in lovelace; Lump Bot divides by 1,000,000 for ADA display.
- **Bonding-curve %** — `percent` string from `GET /v1/pools-feed/curve/progress`, parsed to a float. Only rendered when present and within `[0, 100]`.
- **Socials** — `socials.twitter` / `discord` / `telegram` / `website` from `GET /v1/asset-info`. Emitted as links only when the value is already an absolute `https://` URL; raw handles are ignored rather than guessed.
- **Liquidity / price** — derived from the pool reserves (`pool.y.amount` ADA-side lovelace, `pool.x.amount` token-side smallest-unit). Price is used only as a last-resort multiplier fallback when FDV is missing.

Ratios in the "First @ …" line are computed as `now_fdv / call_fdv` and stored per-call so results are consistent across refreshes. When FDV is unavailable the line falls back to a price-based ratio and labels it `(px)` so it's not mistaken for FDV math.

## How detection works

1. `messageCreate` receives a message in a monitored (or any) channel.
2. The regex `/\b[a-f0-9]{56}\b/i` extracts candidate Policy IDs. Asset fingerprints (`asset1…`) are resolved to a policy via Blockfrost.
3. `AlertService` checks the per-channel debounce table (10 min window) and the in-flight set.
4. Blockfrost and DexHunter calls run in parallel, each through a dedicated rate limiter.
5. `buildPolicyEmbed` assembles the Discord embed with colors depending on whether the policy is new, tracked, or normal.
6. Post to `ALERT_CHANNEL_ID`, record the sighting, optionally POST to `EXTERNAL_WEBHOOK_URL`.

First-ever sightings tag `ALPHA_ROLE_ID` (if set) and include the phrase *"First time this policy has been detected by Lump Bot"*.

## Troubleshooting

- **"Used disallowed intents"** — enable the *Message Content Intent* toggle in the Discord Developer Portal.
- **Bot ignores my messages** — confirm the bot has `View Channel` + `Read Message History` on the channel, and that the channel is in `MONITORED_CHANNEL_IDS` (or that var is empty).
- **Blockfrost 403** — the project ID does not match `BLOCKFROST_NETWORK`.
- **No price data** — DexHunter may not list the token yet; the embed still shows Blockfrost metadata.
- **"Not a postable channel"** — `ALERT_CHANNEL_ID` must be a standard text, news, or thread channel.

## License

MIT
