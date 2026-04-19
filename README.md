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
| `DATABASE_PATH` | no | SQLite path, default `./data/lumpbot.sqlite` |
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

## VPS deployment

The bot is a single long-running Node process that needs outbound HTTPS and a writable data directory. Any VPS (Hetzner, Fly.io, Railway, Render, DigitalOcean) will do.

### 1. Provision

Pick a small Ubuntu 22.04/24.04 LTS instance (512 MB RAM is enough). SSH in:

```bash
sudo apt update && sudo apt install -y build-essential git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 2. Deploy

```bash
git clone https://github.com/scream2tv/lumpbot.git /opt/lumpbot
cd /opt/lumpbot
npm ci
cp .env.example .env
nano .env   # populate secrets
npm run build
npm run deploy   # register slash commands in your guild
```

### 3. Run under pm2

```bash
pm2 start dist/index.js --name lumpbot --time
pm2 save
pm2 startup systemd -u $USER --hp $HOME
# run the command pm2 prints
```

Useful commands:

```bash
pm2 logs lumpbot
pm2 restart lumpbot
pm2 stop lumpbot
```

### 4. Keep it healthy

- Rotate logs: `pm2 install pm2-logrotate`
- Back up `./data/lumpbot.sqlite` daily (cron + `sqlite3 .backup`).
- Set firewall rules to deny all inbound except SSH.

### systemd alternative

If you prefer systemd over pm2:

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

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lumpbot
sudo journalctl -u lumpbot -f
```

## Commands

| Command | Description |
| --- | --- |
| `/verify add policy_id:<id> [label:<name>]` | Track a policy for enhanced alerts (requires `Manage Guild`) |
| `/verify remove policy_id:<id>` | Untrack a policy |
| `/verify list` | Show all tracked policies |
| `/lookup target:<policy_id or asset1…>` | Manually generate an embed for a policy or fingerprint |

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
