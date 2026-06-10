# Aurum Quant Edge Backend

Cloudflare Worker backend for:

- OANDA price, account summary, open trades, and closed trade history
- bot state and bot controls
- market MTF payloads
- AI decision proxy
- settings and lightweight history persistence via KV

Expected Worker URL after deploy:

- `https://aurum-quant-edge.<workers-subdomain>.workers.dev`

Required secrets:

- `OANDA_API_TOKEN`
- `OANDA_ACCOUNT_ID`
- `OANDA_ENVIRONMENT`
- `TRADING_BOT_ALLOW_LIVE`
- `ADMIN_PASSWORD`
- `NVIDIA_API_KEY` optional

Required KV binding:

- `AURUM_KV`
