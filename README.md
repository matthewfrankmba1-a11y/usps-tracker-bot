# usps-tracker-bot

A Discord bot that stays online and polls the **USPS**, **UPS** and **FedEx**
tracking APIs every 20 minutes, posting an embed to your channel whenever a
package actually moves.

- 📦 `/track add` any USPS, UPS or FedEx number — the carrier is auto-detected
- 🔁 Polls every 20 minutes (configurable), with jitter and bounded concurrency
- 🤫 Only posts when something changes — repeat polls are silent
- 🧠 Shared shipments: five people watching one package still costs one API call
- 💾 Survives restarts (atomic JSON store) and reconnects on its own
- ❤️ `/healthz` endpoint for uptime monitors and container health checks

## Quick start

```bash
git clone https://github.com/matthewfrankmba1-a11y/usps-tracker-bot.git
cd usps-tracker-bot
npm install
cp .env.example .env    # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, carrier keys
npm start
```

Slash commands register themselves on startup. Set `DISCORD_GUILD_ID` while
developing so they appear instantly instead of taking up to an hour to
propagate globally.

## Commands

| Command | What it does |
| --- | --- |
| `/track add tracking_number:<n> [label] [carrier]` | Watch a package; updates post in the current channel |
| `/track remove tracking_number:<n>` | Stop watching it here (autocompletes from what you track) |
| `/track list [scope]` | Packages tracked in this channel, or everything you track |
| `/track check tracking_number:<n>` | Force a refresh now instead of waiting for the next poll |
| `/track status` | Uptime, next poll, package counts, carrier credential status |

Updates mention everyone in the channel who subscribed to that package, so two
people tracking the same number get one embed and two mentions.

## Discord setup

1. Create an application at <https://discord.com/developers/applications>.
2. **Bot → Reset Token** → copy into `DISCORD_TOKEN`; copy the Application ID
   from **General Information** into `DISCORD_CLIENT_ID`.
3. **Installation → Guild Install**, scopes `bot` + `applications.commands`,
   bot permissions: *Send Messages*, *Embed Links*, *View Channel*.
4. Invite the bot with the generated URL.

No privileged gateway intents are needed — the bot only uses slash commands.

## Tracking credentials

There are two ways to feed the bot. **EasyPost** is one key for all three
carriers with no approval queue; the **carriers' own APIs** are free but each
has its own onboarding.

### Option A — EasyPost (fastest)

Sign up at <https://www.easypost.com>, copy the API key from Account → API
Keys, and set it:

```bash
EASYPOST_API_KEY=EZAK...
```

That covers USPS, UPS and FedEx at once. EasyPost polls the carriers itself, so
the bot looks up an existing tracker per number and creates one the first time
it sees it. Check EasyPost's current pricing for tracker volume; personal use
sits inside the free tier.

### Option B — the carriers' own APIs

Each carrier uses OAuth 2.0 client credentials. The bot caches tokens and
refreshes them a minute before expiry.

| Carrier | Developer portal | Product to enable |
| --- | --- | --- |
| USPS | <https://developer.usps.com> | Tracking (3.0) |
| UPS | <https://developer.ups.com> | Tracking |
| FedEx | <https://developer.fedex.com> | Track API |

### Which one gets used

`TRACKING_PROVIDER` decides, and defaults to `auto`:

| Value | Behaviour |
| --- | --- |
| `auto` | A carrier's own API when it has credentials, otherwise EasyPost |
| `easypost` | Always EasyPost |
| `direct` | Only the carriers' own APIs |

So you can run on EasyPost today and, when USPS finally approves your
developer account, just set `USPS_CLIENT_ID`/`USPS_CLIENT_SECRET` — USPS
switches to its own API on the next restart while UPS and FedEx stay on
EasyPost. `/track status` shows which transport each carrier is using.

EasyPost is a transport, not a fourth carrier: shipments stay keyed by the real
carrier, detection is unchanged, and tracking links still point at USPS/UPS/FedEx.

Carriers you leave unconfigured are simply skipped: `/track add` still accepts
the number, tells you credentials are missing, and starts reporting as soon as
they are set. Point `*_BASE_URL` at each carrier's sandbox
(`https://apis-tem.usps.com`, `https://wwwcie.ups.com`,
`https://apis-sandbox.fedex.com`) to test without touching production quota.

### Tracking-number detection

| Pattern | Carrier |
| --- | --- |
| `1Z` + 16 alphanumerics, `T` + 10 digits | UPS |
| 20/22 digits starting `92`–`95`, 20 digits starting `70`–`91`, `XX#########XX` | USPS |
| 12 or 15 digits, 22 digits, 20/22 digits starting `96` | FedEx |

USPS IMpb labels scanned with the `420` + ZIP routing prefix are trimmed
automatically. Pass `carrier:` explicitly to override a wrong guess.

## Staying online

The bot is a long-running process — run it somewhere that restarts it.

**Docker Compose** (`restart: unless-stopped`, state on a named volume):

```bash
docker compose up -d --build
docker compose logs -f
```

**systemd** — see [`deploy/usps-tracker-bot.service`](deploy/usps-tracker-bot.service)
(`Restart=always`).

**Fly.io** — [`fly.toml`](fly.toml) is committed: one always-on machine and a
persistent volume, no public URL.

```bash
fly auth login
fly launch --no-deploy --copy-config --name usps-tracker-bot --region iad
fly volumes create tracker_data --size 1 --region iad
fly secrets set DISCORD_TOKEN=... DISCORD_CLIENT_ID=... \
  USPS_CLIENT_ID=... USPS_CLIENT_SECRET=...
fly deploy
fly logs
```

Secrets go in with `fly secrets set`, never in `fly.toml`. Keep
`auto_stop_machines` unset (as it is here) — a suspended machine stops polling.
Pushing to `main` redeploys automatically once `FLY_API_TOKEN` (from
`fly tokens create deploy`) is set as a GitHub Actions secret; see
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

**Other PaaS** (Railway, Render): run `node src/index.js` as a worker process,
mount a persistent volume at `DATA_DIR`, and point the platform's health check
at `GET /healthz`, which returns:

```json
{
  "status": "ok",
  "uptimeSeconds": 4210,
  "discord": { "ready": true, "wsPing": 62, "guilds": 2 },
  "poller": { "lastPollAt": "…", "nextPollAt": "…", "lastCycle": { "checked": 7, "updates": 1 } },
  "store": { "shipments": 7, "subscriptions": 9 }
}
```

It returns `503` until the gateway connection is ready, so uptime monitors and
orchestrators notice a wedged process. discord.js handles gateway reconnects
itself; `SIGTERM`/`SIGINT` flush the store and disconnect cleanly.

## Configuration

Every setting is an environment variable (see [`.env.example`](.env.example)).

| Variable | Default | Notes |
| --- | --- | --- |
| `EASYPOST_API_KEY` | unset | One key for USPS, UPS and FedEx |
| `TRACKING_PROVIDER` | `auto` | `auto`, `easypost` or `direct` |
| `POLL_INTERVAL_MINUTES` | `20` | How often every tracked package is refreshed |
| `POLL_JITTER_SECONDS` | `30` | Random spread so cycles do not align exactly |
| `POLL_CONCURRENCY` | `3` | Simultaneous carrier lookups per cycle |
| `DELIVERED_RETENTION_HOURS` | `48` | Delivered packages stop being polled, then drop |
| `UNKNOWN_RETENTION_HOURS` | `336` | Numbers no carrier ever recognises expire after 14 days |
| `MAX_PACKAGES_PER_USER` | `25` | Guardrail against one person burning the API quota |
| `DATA_DIR` | `./data` | Holds `tracker.json` |
| `HEALTH_SERVER` / `PORT` | `true` / `8080` | Health endpoint |
| `HTTP_TIMEOUT_MS` / `HTTP_RETRIES` | `15000` / `2` | Per carrier request; retries 429/5xx with backoff |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` — JSON lines |
| `SKIP_COMMAND_REGISTRATION` | unset | Set to `1` to skip auto-registering slash commands |

### API quota

Each cycle makes one request per *distinct* tracked number. With 20-minute
polling that is 72 lookups per package per day; the free carrier tiers handle a
few hundred packages comfortably. Delivered packages stop being polled.

## How updates are detected

Each carrier response is normalised to a shared shape (status, latest scan,
estimated delivery, history) and hashed into a fingerprint. The poller notifies
only when the fingerprint changes, so a package sitting in transit for three
days stays quiet, and a new scan pings you once. Four consecutive lookup
failures for the same package post a single warning rather than a wall of
errors.

## Development

```bash
npm test     # 49 unit tests: detection, parsing, storage, poll/diff logic
npm run dev  # node --watch
npm run register  # re-register slash commands without starting the bot
```

```
src/
  index.js            # client wiring, notification fan-out, shutdown
  poller.js           # 20-minute cycle, diffing, retries, retention
  store.js            # atomic JSON persistence
  health.js           # /healthz
  carriers/           # usps.js, ups.js, fedex.js, easypost.js, detection, normalisation
  discord/            # slash commands, embeds, registration
```

Adding a carrier means adding one module that exports `isConfigured()`,
`track()` and `trackingUrl()`, returning `makeResult(...)` — plus a detection
rule in `src/carriers/index.js`.

## License

MIT — see [LICENSE](LICENSE).
