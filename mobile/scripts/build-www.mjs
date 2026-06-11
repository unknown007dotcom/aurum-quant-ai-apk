// Builds the Capacitor `www/` folder from the existing web app at the repo root.
// It copies the static frontend assets (NOT the server-side api-handlers / lib server code)
// so the UI is bundled inside the APK. The app still talks to the remote backend
// (Cloudflare Worker) for market data + AI, exactly like the website does.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MOBILE_DIR, "..");
const WWW = path.join(MOBILE_DIR, "www");

// Top-level files needed by the frontend
const FILES = [
  "index.html",
  "history.html",
  "app.js",
  "history.js",
  "styles.css",
  "favicon.svg",
  "logo.svg",
];

// Directories the frontend imports at runtime (ES modules + client-safe libs)
const DIRS = ["modules"];

// Only these files inside lib/ are imported by the browser bundle.
const LIB_CLIENT_FILES = ["rmi.js"];

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function copyDir(src, dest) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else {
      await copyFile(s, d);
    }
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await rmrf(WWW);
  await fs.mkdir(WWW, { recursive: true });

  for (const f of FILES) {
    const src = path.join(REPO_ROOT, f);
    if (await exists(src)) {
      await copyFile(src, path.join(WWW, f));
      console.log("copied", f);
    } else {
      console.warn("skip (missing)", f);
    }
  }

  // Patch app.js so EDGE_API_BASE respects a global override set by the mobile shim.
  // On the website this code path treats localhost as a dev worker; inside the APK
  // (served from https://localhost) we must force the real production backend.
  const appJsPath = path.join(WWW, "app.js");
  if (await exists(appJsPath)) {
    let appJs = await fs.readFile(appJsPath, "utf8");
    const marker = "const EDGE_API_BASE = (typeof window !== \"undefined\"";
    if (appJs.includes(marker)) {
      appJs = appJs.replace(
        /const EDGE_API_BASE = \(typeof window[\s\S]*?\n    : "\/api";/,
        'const EDGE_API_BASE = (typeof window !== "undefined" && window.__AURUM_API_BASE__)\n    ? String(window.__AURUM_API_BASE__).replace(/\\/+$/, "")\n    : "";'
      );
      await fs.writeFile(appJsPath, appJs, "utf8");
      console.log("patched EDGE_API_BASE in app.js for mobile");
    }
  }

  for (const d of DIRS) {
    const src = path.join(REPO_ROOT, d);
    if (await exists(src)) {
      await copyDir(src, path.join(WWW, d));
      console.log("copied dir", d);
    }
  }

  // client-safe lib files (modules import ../lib/rmi.js)
  for (const f of LIB_CLIENT_FILES) {
    const src = path.join(REPO_ROOT, "lib", f);
    if (await exists(src)) {
      await copyFile(src, path.join(WWW, "lib", f));
      console.log("copied lib/" + f);
    }
  }

  // Copy the mobile runtime shim into www/
  const shimSrc = path.join(MOBILE_DIR, "www-extra", "mobile-runtime.js");
  if (await exists(shimSrc)) {
    await copyFile(shimSrc, path.join(WWW, "mobile-runtime.js"));
    console.log("copied mobile-runtime.js");
  } else {
    console.warn("WARNING: www-extra/mobile-runtime.js missing");
  }

  // Copy the on-device backend into www/
  const backendSrc = path.join(MOBILE_DIR, "www-extra", "aurum-backend.js");
  if (await exists(backendSrc)) {
    await copyFile(backendSrc, path.join(WWW, "aurum-backend.js"));
    console.log("copied aurum-backend.js");
  } else {
    console.warn("WARNING: www-extra/aurum-backend.js missing");
  }

  // Copy the background runner task(s) into www/runners/
  const runnersDir = path.join(MOBILE_DIR, "www-extra", "runners");
  if (await exists(runnersDir)) {
    await copyDir(runnersDir, path.join(WWW, "runners"));
    console.log("copied runners/");
  } else {
    console.warn("WARNING: www-extra/runners missing");
  }

  // Inject the mobile scripts into index.html and history.html so the
  // bundled app points at the remote backend and enables native features.
  for (const page of ["index.html", "history.html"]) {
    const p = path.join(WWW, page);
    if (!(await exists(p))) continue;
    let html = await fs.readFile(p, "utf8");
    if (!html.includes("aurum-backend.js")) {
      // Load the on-device backend FIRST (installs fetch interceptor), then the
      // mobile runtime shim, both BEFORE app.js so the backend is active before
      // any request fires and app.js picks up window.__AURUM_API_BASE__.
      html = html.replace(
        /<head(.*?)>/i,
        (m) =>
          `${m}\n  <script src="./aurum-backend.js"></script>\n  <script src="./mobile-runtime.js"></script>`
      );
      await fs.writeFile(p, html, "utf8");
      console.log("injected aurum-backend.js + mobile-runtime.js into", page);
    }
  }

  console.log("\nwww/ build complete ->", WWW);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
