# Aurum Quant AI — Code & Architecture Review

**Repo:** `unknown007dotcom/aurum-quant-ai`
**Live:** `aurum-quant-ai.vercel.app`
**Reviewed:** 2026-06-10 · commit `d2c8319`
**Scope:** ~24k LOC — static frontend (`index.html`/`app.js`), Vercel serverless API (`api/` + `api-handlers/`), Cloudflare Worker backend (`cloudflare-backend/`), SMC/ICT engines (`lib/`, `modules/`), Firestore persistence, OANDA execution.

---

## TL;DR

The project is genuinely impressive in ambition and breadth — a full SMC/ICT institutional-style analysis stack with multi-timeframe data, a liquidity engine, an AI "Arbiter Council," auto-learning from closed trades, and live OANDA execution. The engineering instincts (fallbacks, key rotation, graceful degradation, modular engines) are solid.

**But there are 🔴 CRITICAL security issues that must be fixed immediately — before anything else.** Live API credentials and the admin password are committed to the public repo and served by the live site, and they currently work. Anyone can become admin and read your OANDA + AI keys right now.

Priority order: **(1) rotate & remove secrets → (2) fix auth model → (3) clean up architecture/dead code → (4) polish.**

---

## 🔴 CRITICAL — Fix immediately (security)

### 1. Live secrets committed to a public repo AND served by the live site
- `data/settings.json` contains a real **OANDA API token** (`8497d6...edb`) and a real **NVIDIA `nvapi-...` key**, repeated across several model entries.
- `modules/config.js` contains the **Firebase web config**, the **admin password**, a **"basic" password**, and a shared **Twelve Data key**.
- `api-handlers/market-data.js`, `live-price.js`, and `cloudflare-backend/src/index.js` hardcode the same Twelve Data key (`23c57edf...`).
- `polygon_test.json` is a committed API response dump.

**Verified live exposure (not just in the repo):**
- `https://aurum-quant-ai.vercel.app/app.js` serves the admin password in plaintext (`SETTINGS_PASSWORD = "Aviraj@api7"`).
- `https://aurum-quant-ai.vercel.app/modules/config.js` serves the Firebase key + password.
- `GET /api/settings` with header `x-admin-password: Aviraj@api7` returns `isAdmin: true` **and the OANDA token + NVIDIA key in the response body.** This works against production right now.

**Impact:** Anyone can (a) drain your Twelve Data / NVIDIA quota, (b) read your OANDA token and place/close trades on your account, (c) flip the bot to `live` mode and modify settings. This is a full account-takeover of the trading backend.

**Action — do these in order, today:**
1. **Rotate every exposed credential now**, assuming all are compromised:
   - OANDA: revoke the token, generate a new one (and confirm no live orders were placed).
   - NVIDIA: revoke the `nvapi-...` key.
   - Twelve Data: rotate the `23c57edf...` key.
   - Firebase: rotate the web API key and, crucially, **lock down Firestore Security Rules** (see #3). Restrict the API key in Google Cloud Console to your domains/APIs.
2. **Remove secrets from the repo and from git history** (not just the latest commit):
   ```bash
   git rm --cached data/settings.json polygon_test.json
   echo -e "data/settings.json\npolygon_test.json" >> .gitignore
   # purge history (BFG is easiest):
   #   bfg --delete-files settings.json
   #   bfg --replace-text passwords.txt   # map old secrets -> ***REMOVED***
   git reflog expire --expire=now --all && git gc --prune=now --aggressive
   git push --force
   ```
   A `data/settings.example.json` with empty strings is fine to keep.
3. **Stop hardcoding the admin password.** Read it only from `process.env.ADMIN_PASSWORD` / Worker `env.ADMIN_PASSWORD`, and remove the `|| "Aviraj@api7"` fallback in `settings.js`, `bot.js`, and `cloudflare-backend/src/index.js`. With no env var set, default to "deny," never to a known string.

### 2. The admin "password" is a client-side secret — the whole model is broken
`app.js` (shipped to every browser) holds `SETTINGS_PASSWORD` and sends it as `x-admin-password`. A secret that lives in client JS is not a secret. Even after rotation, this design means the admin key is always public.

**Action:** Move all privileged operations behind real server-side auth that the browser never holds in cleartext:
- Use a proper login (e.g., Firebase Auth) and verify an ID token server-side, **or**
- At minimum, a server-set, `HttpOnly`, `Secure`, `SameSite` session cookie issued after a password check done *on the server* — the browser never stores the raw admin secret.
- Privileged endpoints (`settings` POST, `bot` POST, live trading) must be authorized server-side only.

### 3. Firestore likely world-readable/writable
`history-log` writes to `analysis_history` and `lib/firebase-admin.js` uses admin SDK, but the web app also ships a Firebase web config. If Firestore rules are in test mode (`allow read, write: if true`), anyone with the public config (now everyone) can read/write your collections directly, bypassing your API.

**Action:** Audit and tighten `firestore.rules`. Default deny; only allow what authenticated users need. Verify in the Firebase console that rules aren't in test mode. Commit the rules file to the repo.

### 4. Unauthenticated state-changing endpoints
- `POST /api/history-log` has **no auth** — anyone can inject arbitrary "analysis history," which then feeds the auto-learn loop (data-poisoning your model's learning).
- `CRON_SECRET` checks in `auto-analyze`/`auto-learn` are bypassed if the env var is unset (`if (cronAuth && ...)`), and also trust the `x-vercel-cron: 1` header, which a client can spoof when calling the public URL directly.

**Action:** Require auth on `history-log` (session/token + rate limiting + payload validation). For crons, require `CRON_SECRET` unconditionally (deny if unset) and don't rely solely on a spoofable header.

### 5. CORS is fully open on the Worker
`corsHeaders()` reflects the request `Origin` back as `Access-Control-Allow-Origin` (effectively `*`) for all routes, including admin ones. Combined with the public password, any website can drive your backend.

**Action:** Allow-list your own origins only (`aurum-quant-ai.vercel.app`, localhost during dev). Never reflect arbitrary origins on authenticated endpoints.

---

## 🟠 High — architecture & correctness

### 6. Two parallel, diverging backends
You maintain both a **Vercel** API (`api-handlers/*`) and a **Cloudflare Worker** (`cloudflare-backend/src/index.js`, 2,737 lines) that reimplement the same logic — but the frontend (`app.js`, `EDGE_API_BASE`) actually talks to the **Cloudflare Worker** in production, while `vercel.json` crons hit the **Vercel** handlers. So logic is duplicated and can silently drift (different defaults, different fixes). This is a major maintenance hazard.

**Action:** Pick one runtime as the source of truth. If the Worker is production, either (a) extract shared logic into a runtime-agnostic package consumed by both, or (b) retire the Vercel handlers and move crons to Cloudflare Cron Triggers. Document the chosen topology in the README (the README currently describes a third, local-only `server.js` setup that doesn't match either deployment).

### 7. Two parallel *frontends* too (dead modular code)
`index.html` loads only `app.js` (a 4,724-line monolith). The clean `modules/` tree (`MixerEngine`, `FVGEngine`, `SweepEngine`, `state.js`, `ui.js`, etc.) is **not imported anywhere** except internally — `grep` shows `MixerEngine` is referenced only by `analysis.js`/itself. So there's a well-structured modular refactor sitting unused next to the monolith that's actually shipped.

**Action:** Decide which is canonical. The `modules/` architecture is clearly the better design — finish migrating `index.html` to it (ES module entrypoint) and delete the duplicated logic from `app.js`, or remove `modules/` if abandoned. Shipping both confuses readers and doubles bug surface.

### 8. `app.js` is a 4.7k-line monolith
Hard to test, review, or reason about. Constants (`STORAGE_KEY`, password, config) are re-declared here separately from `modules/config.js`, so they drift.

**Action:** Break into ES modules (you already have the skeleton). Single source of truth for config.

### 9. No tests, no CI, no linting, scratch files committed
- Root has `test-history.js`, `test-regex.js`, `test-write.txt`, `extract-engine.js`, `polygon_test.json` — these look like scratch/dev artifacts, not a test suite.
- No `package.json` `scripts`, no test runner, no lint config, no CI workflow.
- For a system that places **real money trades**, this is risky — the SMC/liquidity/Fibonacci math has zero automated coverage.

**Action:** Add a real test runner (Vitest/Jest), unit-test the pure engines (`FVGEngine`, `SweepEngine`, `FibonacciEngine`, `rmi`, liquidity pool computation) with fixture candle data, add ESLint + Prettier, and a GitHub Actions CI that runs lint+test on PRs. Remove scratch files (or move to a `scratch/` that's git-ignored).

### 10. Live-trading safety rails are thin
`runBotTick` does gate live orders behind `TRADING_BOT_ALLOW_LIVE` and a trading-window/cooldown check — good. But: position sizing is a fixed `botUnits` with no max-exposure / daily-loss / max-open-risk guard, SL/TP are simple fixed offsets, and the only "one trade at a time" guard is `listOpenTrades` filtered by instrument. Given the auth holes above, a hijacked admin could set `botMode: live` + flip the env and trade.

**Action:** Add hard server-side risk limits independent of UI input (max units, max daily loss, kill-switch), and make `live` mode require an explicit, separately-stored confirmation. Treat `TRADING_BOT_ALLOW_LIVE` as necessary-but-not-sufficient.

---

## 🟡 Medium — quality & robustness

- **README is stale / leaks local paths.** It documents a `node server.js` local-only flow and contains absolute Windows paths (`C:\Users\DELL\...`). It doesn't describe the actual Vercel + Cloudflare + Firebase deployment, required env vars, or setup. Rewrite it to match reality and add an env-var table.
- **`.env.example` is incomplete.** It's missing `TWELVE_DATA_API_KEYS`, `FIREBASE_SERVICE_ACCOUNT_JSON`, NVIDIA key vars, and the Cloudflare Worker vars. List every env var both runtimes read.
- **No `LICENSE`.** Add one (or mark explicitly proprietary) so usage terms are clear.
- **`type: "commonjs"` but `modules/` uses ESM** and `cloudflare-backend` is `type: "module"`. The mixed module systems are a footgun; document/segment clearly.
- **Error handling swallows context.** Many `catch {}` blocks return `{}` or empty arrays silently (`firebase-admin`, `market-data`, body parsers). Good for resilience, bad for debugging — add structured logging (without logging secrets).
- **`history-log` payload is unbounded/unvalidated** — spread of `...entry` straight into Firestore. Validate a schema and cap sizes.
- **Random key selection** (`keys[Math.floor(Math.random()*…)]`) for Twelve Data is fine, but there's no per-key rate-limit tracking, so you can hammer an already-exhausted key. Consider round-robin with cooldown memory.
- **`persistence.js` comments oversell it** ("Bloomberg Comdb2-Ready," "institutional integrity") for what is a JSON file with `slice(-1000)`. Harmless, but the aspirational/marketing comments throughout (e.g. "Ported from Institutional Bloomberg patterns" in `rmi.js`, where RMI is just `price/EMA30*100`) can mislead future maintainers about what the code actually does. Prefer comments that state what the code *is*.
- **Chart.js loaded from CDN** in `index.html` — fine for the deployed site, but means the in-app/offline preview degrades. Acceptable; just be aware.

---

## 🟢 What's done well

- **Genuinely broad, coherent feature set:** MTF data, liquidity pools by tier, CRT event detection, multi-TF Fibonacci OTE, RMI, AI summary + debate "council," auto-learning from closed trades. That's a lot, and it hangs together conceptually.
- **Good resilience patterns:** OANDA→Twelve Data fallback, multi-key rotation, symbol-candidate fallback, graceful `metrics` defaults on failure.
- **The `modules/engines/` design** (separate `FVG`/`Sweep`/`Trend`/`Fibonacci`/`Mixer` engines with pure-ish functions) is clean and testable — exactly the right direction. Finish adopting it.
- **Sensible live-trade gating** (`TRADING_BOT_ALLOW_LIVE`, trading window, cooldown, single-open-trade) — the right *idea*, just needs hardening.
- **Caching/KV work** in the Worker and `maxDuration` tuning show real operational awareness.

---

## Suggested 7-step action plan

1. **Today:** Rotate all 4 credential types (OANDA, NVIDIA, Twelve Data, Firebase). Confirm no unauthorized OANDA activity.
2. **Today:** Remove secrets from repo + git history; add to `.gitignore`; force-push; remove the hardcoded password fallbacks.
3. **This week:** Replace client-side password with real server-side auth (Firebase Auth or HttpOnly session). Lock Firestore rules. Restrict CORS to your origins. Add auth to `history-log`; make `CRON_SECRET` mandatory.
4. **This week:** Add server-side hard risk limits + kill-switch for live trading.
5. **Next:** Choose one backend runtime; extract shared logic; retire the duplicate. Same for frontend (`app.js` vs `modules/`).
6. **Next:** Add Vitest tests for the engines, ESLint/Prettier, and GitHub Actions CI. Remove scratch files.
7. **Polish:** Rewrite README to match real deployment, complete `.env.example`, add LICENSE, add structured logging.

---

*This review is technical and not financial/trading advice. Given real-money execution is involved, prioritize the security and risk-limit items before adding features.*
