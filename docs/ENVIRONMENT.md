# Environment variables

Everything the app reads, grouped by runtime. Copy `.env.example` to `.env` for
the Node/Vercel side; the Cloudflare Worker gets its values through
`wrangler secret put` (see `cloudflare-backend/wrangler.jsonc`).

`tests/env-docs.test.js` fails CI if the code starts reading a variable that is
not documented here and stubbed in `.env.example`, so this file cannot silently
drift from the code.

Legend: **Required** = the app will not work without it. **Recommended** = the
feature degrades without it. **Optional** = tuning.

---

## Node server / Vercel (`server.js`, `api/`, `api-handlers/`, `lib/`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | **Required for admin** | Unlocks the Settings panel, bot control and `GET /api/settings`. Empty means **every admin request is denied** — there is no default password. |
| `OANDA_API_TOKEN` | Recommended | OANDA practice/live API token. Without it the bot reports `OANDA is not configured` and data falls back to Twelve Data. |
| `OANDA_ACCOUNT_ID` | Recommended | Account id; discovered automatically from the token when omitted. |
| `OANDA_ENVIRONMENT` | Optional | `practice` (default) or `live`. |
| `OANDA_INSTRUMENT` | Optional | Default instrument, `XAU_USD`. |
| `TRADING_BOT_ALLOW_LIVE` | **Required to trade live** | Must be exactly `true`. Necessary but not sufficient — the risk limits below still apply. |
| `RISK_MAX_UNITS` | Optional | Hard cap on units per live order. Default `1000`. |
| `RISK_MAX_OPEN_POSITIONS` | Optional | Concurrent open trades allowed. Default `1`. |
| `RISK_MAX_DAILY_LOSS` | Optional | Realised loss per UTC day before trading halts. Default `100`. |
| `RISK_MAX_DAILY_ORDERS` | Optional | Live orders per UTC day. Default `20`. |
| `RISK_KILL_SWITCH` | Optional | `true` blocks every live order immediately. Default off. |
| `CRON_SECRET` | **Required for crons** | Bearer token for `/api/auto-analyze` and `/api/auto-learn`. Empty means both return **503** rather than running unauthenticated. Vercel injects it automatically for scheduled runs when set. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Recommended | Service-account JSON (single line). Enables Firestore persistence; without it the app uses `data/settings.json` + `data/institutional_history.db.json`. |
| `TWELVE_DATA_API_KEY` / `TWELVE_DATA_API_KEYS` | Recommended | Price/candle fallback when OANDA is unavailable. `_KEYS` accepts a comma-separated pool. |
| `POLYGON_API_KEY` / `POLYGON_API_KEYS` | Optional | Options contract data. |
| `ALPHA_VANTAGE_KEY` / `ALPHA_VANTAGE_KEYS` | Optional | Secondary market data. |
| `MASSIVE_API_KEY` / `MASSIVE_API_KEYS` | Optional | Options data provider. |
| `OPTIONS_DATA_API_KEY` / `OPTIONS_DATA_API_KEYS` | Optional | Alternate options provider. |
| `AUTO_ANALYZE_BASE_URL` | Optional | Base URL the cron handlers call back into. Defaults to the request host, then `https://aurum-quant-ai.vercel.app`. |
| `PORT` | Optional | Local server port. Default `3000`. |

## Cloudflare Worker (`cloudflare-backend/`)

Set with `wrangler secret put <NAME>`; bindings live in `wrangler.jsonc`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | **Required** | Same deny-by-default rule as the Node side (`assertAdmin`). |
| `OANDA_API_TOKEN` | Recommended | Live data + execution. |
| `OANDA_ACCOUNT_ID` | Recommended | OANDA account id. |
| `OANDA_ENVIRONMENT` | Optional | `practice` (default) or `live`. |
| `OANDA_INSTRUMENT` | Optional | Default `XAU_USD`. |
| `NVIDIA_API_KEY` | Optional | Worker-side AI calls when no key is stored in settings. |
| `AURUM_KV` | Optional (binding) | KV namespace for caching. |
| `LEARNING_STORE` | Optional (binding) | Durable object / KV for learning memory. |
| `CANDLE_CACHE` | Optional (binding) | KV namespace for candle caching. |

## Browser / Android

No credentials are ever shipped to the client. `app.js` and the APK read keys
from the admin-authenticated settings API or the device store; a missing key
falls back to the deterministic rule engine. `tests/no-secrets-in-client.test.js`
enforces this.

---

## Rotation checklist

If a key ever appears in git history, a screenshot, a public URL or a browser
bundle, **rotate it** — removing it from the working tree does not un-leak it:

1. OANDA → Manage API access → revoke and regenerate the token.
2. NVIDIA → build.nvidia.com → API keys → revoke and regenerate.
3. Provider keys (Twelve Data / Polygon / Alpha Vantage / Massive) → regenerate.
4. `ADMIN_PASSWORD` → change, then update the deployment env.
5. `CRON_SECRET` → change (Vercel picks it up for scheduled runs).
6. Re-save settings through the Settings panel so `admin/settings` no longer
   holds the old values.
