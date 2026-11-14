/**
 * Static file resolution for server.js.
 *
 * The server previously served anything under the project root, so
 * `/.git/config`, `/data/settings.json` (which holds OANDA + NVIDIA keys once the
 * app saves settings) and `/.env` were all downloadable by anyone who could
 * reach the port — including another device on the same Wi-Fi, or a tunnel.
 *
 * The rules here are deliberately allow-by-nothing / deny-by-default:
 *   - dotfiles and dot-directories (.git, .env, .vercel, ...) are never served
 *   - a denylist covers every non-public tree in this repo
 *   - only known-safe extensions are served
 *   - the resolved path must stay inside ROOT (prefix + separator, so a sibling
 *     directory such as `repo-backup/` cannot be reached)
 */

const fs = require("node:fs");
const path = require("node:path");

// Trees that never need to be public.
const BLOCKED_SEGMENTS = new Set([
  "data", // settings + history store (API tokens)
  "lib", // server-side helpers
  "api", // Vercel function entrypoint (routed separately)
  "api-handlers",
  "tests",
  "node_modules",
  "mobile", // APK sources and keystore
  "cloudflare-backend",
  ".git",
  ".github",
  ".vercel",
  "scratch",
  "temporary",
  "logs",
]);

// Only these extensions are served. Anything else (e.g. .md, .yml, .log,
// .keystore, .example) is a 404 rather than a download.
const ALLOWED_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".txt",
  ".map",
]);

// Individual files that are never public even though their extension is allowed.
const BLOCKED_FILES = new Set([
  "package.json",
  "package-lock.json",
  "vercel.json",
  "vercel.json.md",
  "capacitor.config.json",
  "build.gradle",
]);

function isBlocked(relativePath) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length && BLOCKED_FILES.has(segments[segments.length - 1].toLowerCase())) {
    return true;
  }
  return segments.some((segment) => {
    if (segment.startsWith(".")) return true;
    return BLOCKED_SEGMENTS.has(segment);
  });
}

/**
 * @param {string} rootDir absolute project root
 * @param {string} requestPath URL pathname, e.g. "/modules/trade-levels.mjs"
 * @returns {{ ok: true, filePath: string } | { ok: false, status: number }}
 */
function resolveStaticFile(rootDir, requestPath) {
  const root = path.resolve(rootDir);
  const rawPath = requestPath === "/" || requestPath === "" ? "/index.html" : requestPath;

  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // Malformed percent-encoding.
    return { ok: false, status: 400 };
  }

  if (decoded.includes("\0")) return { ok: false, status: 400 };

  const relative = decoded.replace(/^\/+/, "");
  if (!relative) return { ok: false, status: 404 };
  if (isBlocked(relative)) return { ok: false, status: 404 };

  const extension = path.extname(relative).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return { ok: false, status: 404 };

  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    return { ok: false, status: 403 };
  }

  if (!fs.existsSync(filePath)) return { ok: false, status: 404 };

  try {
    if (fs.statSync(filePath).isDirectory()) return { ok: false, status: 404 };
  } catch {
    return { ok: false, status: 404 };
  }

  return { ok: true, filePath };
}

module.exports = { resolveStaticFile, ALLOWED_EXTENSIONS, BLOCKED_SEGMENTS };
