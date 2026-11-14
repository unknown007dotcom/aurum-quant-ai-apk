// The env reference must not drift from the code (issue #33).
//
// CODE_REVIEW.md §11: .env.example listed 10 of the 20+ variables the app reads.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function collect(files) {
  const found = new Set();
  for (const rel of files) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) found.add(match[1]);
  }
  return found;
}

function walk(dir, filter, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "android", "www", "tests"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter, depth + 1));
    else if (filter(entry.name)) out.push(path.relative(ROOT, full));
  }
  return out;
}

const codeFiles = walk(ROOT, (name) => /\.(js|mjs)$/.test(name));
const nodeFiles = codeFiles.filter((rel) => !rel.startsWith("cloudflare-backend"));
const workerFiles = codeFiles.filter((rel) => rel.startsWith("cloudflare-backend"));

const envExample = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
const envDoc = fs.readFileSync(path.join(ROOT, "docs", "ENVIRONMENT.md"), "utf8");

test("every variable the Node side reads is in .env.example", () => {
  const declared = new Set(
    [...envExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((match) => match[1]),
  );
  const missing = [...collect(nodeFiles)].filter((name) => !declared.has(name)).sort();
  assert.deepEqual(missing, [], `read but not documented in .env.example: ${missing.join(", ")}`);
});

test("every variable the Worker reads is documented", () => {
  const workerVars = collect(workerFiles);
  const missing = [...workerVars].filter((name) => !envDoc.includes(name)).sort();
  assert.deepEqual(missing, [], `Worker vars missing from docs/ENVIRONMENT.md: ${missing.join(", ")}`);
});

test("every variable the app reads appears in the env reference", () => {
  const missing = [...collect(nodeFiles)].filter((name) => !envDoc.includes(name)).sort();
  assert.deepEqual(missing, [], `missing from docs/ENVIRONMENT.md: ${missing.join(", ")}`);
});

test("the secrets that must stay empty by default are stubbed empty", () => {
  for (const name of ["ADMIN_PASSWORD", "CRON_SECRET", "FIREBASE_SERVICE_ACCOUNT_JSON", "OANDA_API_TOKEN"]) {
    assert.match(envExample, new RegExp(`^${name}=$`, "m"), `${name} must default to empty, not a value`);
  }
});

test(".env.example contains no real credentials", () => {
  assert.equal(/nvapi-[A-Za-z0-9_-]{20,}/.test(envExample), false);
  assert.equal(/\b[0-9a-f]{32}-[0-9a-f]{32}\b/i.test(envExample), false);
  assert.equal(/-----BEGIN/.test(envExample), false);
});

test("a LICENSE exists with a recognised identifier", () => {
  const licensePath = path.join(ROOT, "LICENSE");
  assert.equal(fs.existsSync(licensePath), true, "LICENSE must be committed");
  const text = fs.readFileSync(licensePath, "utf8");
  assert.ok(text.length > 200, "LICENSE must contain the actual terms");
  assert.match(text, /(MIT License|Apache License|GNU GENERAL PUBLIC LICENSE|All rights reserved)/i);
});

test("the README explains the module-system layout", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /Module (systems|layout)/i);
  assert.match(readme, /commonjs/i);
  assert.match(readme, /\.mjs/);
});
