# Build the APK on GitHub (new/separate repo)

The compiled `.apk` doesn't persist reliably in the editor workspace, so we build
it on GitHub's servers instead. You get a permanent download link and a fresh APK
on every push. Follow these steps once.

## ⚠️ One key rule
The build bundles the web app from the **repo root** (`app.js`, `index.html`,
`modules/`, `lib/`, `styles.css`, ...) into the APK. So the new repo must contain
the **whole project**, not just the `mobile/` folder.

---

## Step 1 — Create a new empty repo on GitHub
On github.com → **New repository** → give it a name (e.g. `aurum-quant-ai-app`) →
**Create** (don't add a README/license; keep it empty). Copy its URL, e.g.
`https://github.com/YOURNAME/aurum-quant-ai-app.git`.

## Step 2 — Push this whole project into it
On your computer, in the project's root folder (the one that contains `app.js`
**and** the `mobile/` folder):

```bash
# from the project root
git init -b main                 # skip if it's already a git repo
git add .
git commit -m "Aurum Quant AI: web app + Android APK build (Capacitor)"
git remote add origin https://github.com/YOURNAME/aurum-quant-ai-app.git
git push -u origin main
```

> If the folder is already a git repo pointing somewhere else, instead do:
> ```bash
> git remote set-url origin https://github.com/YOURNAME/aurum-quant-ai-app.git
> git add . && git commit -m "Add Android APK build" && git push -u origin main
> ```

## Step 3 — Let GitHub build it
- Pushing to `main` (or `master`) **auto-triggers** the build.
- Or trigger it manually: repo → **Actions** tab → **Build Android APK** →
  **Run workflow**.

Wait ~3–5 minutes for the green checkmark.

## Step 4 — Download your APK (two ways)
**A) From the Release (easiest):** repo → **Releases** (right sidebar) →
**Aurum Quant AI - latest APK** → download **`aurum-quant-ai.apk`**.

**B) From the Actions run:** Actions → click the finished run → scroll to
**Artifacts** → download **`aurum-quant-ai-apk`** (a zip with the `.apk` inside).

## Step 5 — Install on your phone
1. Copy `aurum-quant-ai.apk` to your Android phone.
2. Open it; allow **"install unknown apps"** for your browser/file manager.
3. On first launch, **allow notifications**.
4. Open **Settings** in the app and paste your **NVIDIA `nvapi-` key** (for AI)
   and **OANDA token** / **Twelve Data key** (for price). Keys are stored only on
   your device.
5. For reliable background alerts: phone Settings → Apps → Aurum Quant AI →
   **Battery → Unrestricted** (and Autostart on Xiaomi/Samsung/etc.).

---

## Troubleshooting
- **"Run workflow" button missing** → make sure `.github/workflows/android-apk.yml`
  was pushed and you're on the **Actions** tab.
- **Build fails at "Build web assets"** → the repo is missing root files. Confirm
  `app.js`, `index.html`, `modules/`, `lib/rmi.js`, `styles.css` are in the repo
  root (Step 2 pushed the whole project, not just `mobile/`).
- **Release step fails with permissions** → the workflow already sets
  `permissions: contents: write`. If your org restricts this, use download
  method **B** (the Actions artifact) instead.
- **Want a signed Play Store build** → this produces a *debug* APK for sideloading.
  A signed release AAB needs a keystore + signing secrets; ask and I'll add it.
```
