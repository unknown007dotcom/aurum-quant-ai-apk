# Aurum Quant AI — Android (Standalone APK)

A self-contained Android app (Capacitor) that runs the **backend on the phone** —
no Vercel, no Cloudflare. It calls OANDA / Twelve Data / NVIDIA **directly** from
the device, learns from its own trade history locally, and keeps watching for
entry zones in the background.

## ✅ What's inside
1. **On-device backend** (`www-extra/aurum-backend.js`) — a `fetch()` interceptor
   that answers the same API the UI already calls, but locally:
   - `/market-mtf`, `/live-price` → OANDA (fallback Twelve Data)
   - `/ai-decision` → NVIDIA chat completions (+ local learning memory injected)
   - `/settings`, `/history-log`, `/learning-context`, `/learning-feedback`, `/bot`
2. **Local self-learning** — stores every signal on the device, evaluates TP/SL,
   asks the AI **"why did this trade fail?"**, stores the lesson, and injects all
   past lessons into future analysis prompts so it avoids repeating mistakes.
3. **Background runner** (`www-extra/runners/aurum-runner.js`) via
   `@capacitor/background-runner` — runs ~every 15 min even when the app is
   closed: fetches price, and if price enters a pending signal's **entry zone**,
   fires a **local notification** (Buy/Sell + entry + TP1/TP2 + SL). Also logs
   TP/SL hits for the learning loop.
4. **15-min foreground loop** (`www-extra/mobile-runtime.js`) — full AI analysis
   while the app is open, plus entry-zone watching every ~5s.

## 🔑 Keys (you paste them, they're NOT shipped)
The app ships with **no** API keys. On first launch, open **Settings** and paste:
- your **NVIDIA `nvapi-` key** (required for AI analysis),
- your **OANDA API token** (for live gold price + candles), and/or
- a **Twelve Data key** (free fallback for price/candles).

These are stored on the device (Capacitor Preferences). The app holder is treated
as admin locally.

## 📲 Install
Prebuilt debug APK:
```
mobile/dist/aurum-quant-ai-debug.apk
```
Copy to your Android phone, enable "install unknown apps", open it, and **allow
notifications** when prompted.

### Make background alerts reliable (important)
Android kills background work to save battery. For the 15-min background scan to
keep running when the app is closed:
- Settings → Apps → Aurum Quant AI → **Battery → Unrestricted** (disable
  optimization).
- On Xiaomi/Oppo/Vivo/Samsung: also enable **Autostart** and **lock** the app in
  the recents screen.
Even then, the OS controls timing; the background interval is a *minimum* of ~15
min, not a guarantee.

## ⚠️ Honest limitations
- **The AI model never runs on the phone.** NVIDIA's Llama models run in the
  cloud; the app *calls* them. So AI analysis needs internet + your NVIDIA key.
- **No global learning.** Each phone learns only from its **own** history (no
  shared server). Local self-improvement works; cross-device learning does not.
- **Background timing is best-effort** (see above).
- This is a **debug** APK (unsigned). Good for sideloading on your own phone; for
  Play Store you'd build a signed release AAB.

## 🔁 Rebuild

### GitHub Actions (recommended)
Push `mobile/` + the workflow; the **Build Android APK** action produces a
downloadable APK artifact. (See `.github/workflows/android-apk.yml`.)

### Local
Requires Node 20, JDK 17, Android SDK (platform 34, build-tools 34.0.0).
```bash
cd mobile
npm install
npm run build:www        # builds www/ (UI + on-device backend + runner)
npx cap sync android
cd android
./gradlew assembleDebug  # -> app/build/outputs/apk/debug/app-debug.apk
```

## ⚙️ Configuration
- App id / name / background interval: `mobile/capacitor.config.json`
- Permissions: `mobile/android/app/src/main/AndroidManifest.xml`
- Default instrument: `XAU_USD` (change in app Settings)

## How the pieces talk
```
WebView (UI + app.js)
  └─ fetch() ─▶ aurum-backend.js (interceptor)
                 ├─ OANDA / Twelve Data  (price, candles)
                 ├─ NVIDIA               (AI decision + loss diagnosis)
                 ├─ local history + lessons (Preferences)
                 └─ KV bridge ─▶ Background Runner (runners/aurum-runner.js)
                                   └─ price check + entry-zone notifications
                                      (runs ~15 min even when app is closed)
```

## Project layout
```
mobile/
├── capacitor.config.json
├── package.json
├── scripts/build-www.mjs
├── www-extra/
│   ├── aurum-backend.js          # on-device backend (replaces Vercel/Cloudflare)
│   ├── mobile-runtime.js         # 15-min foreground loop + entry-zone watch
│   └── runners/aurum-runner.js   # background task (entry-zone alerts when closed)
├── www/                          # generated bundle (gitignored)
├── android/                      # native Android project
└── dist/aurum-quant-ai-debug.apk # prebuilt APK
```
```
