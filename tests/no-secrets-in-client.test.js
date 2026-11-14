// No credentials may appear in code that ships to the browser or the APK.
//
// #29: app.js shipped a live nvapi- key in its default model list; #4 was the
// same class of leak via data/settings.json. This scan makes the whole class a
// CI failure.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Anything served to a visitor: the web app, its modules, the mobile backend.
const CLIENT_FILES = [
  "app.js",
  "history.js",
  "index.html",
  "history.html",
  "modules/fib-ote.js",
  "modules/trade-levels.mjs",
  "mobile/www-extra/aurum-backend.js",
  "mobile/www-extra/mobile-runtime.js",
];

// Secret shapes worth screaming about.
const PATTERNS = [
  { name: "NVIDIA API key", re: /nvapi-[A-Za-z0-9_-]{20,}/ },
  { name: "OANDA token", re: /\b[0-9a-f]{32}-[0-9a-f]{32}\b/i },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "generic sk- key", re: /\bsk-[A-Za-z0-9]{24,}/ },
];

test("no credential literals in client-side files", () => {
  const offenders = [];
  for (const rel of CLIENT_FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const { name, re } of PATTERNS) {
      const match = re.exec(text);
      if (match) offenders.push(`${rel}: ${name} (${match[0].slice(0, 12)}...)`);
    }
  }
  assert.deepEqual(offenders, [], `credentials in shipped code:\n  ${offenders.join("\n  ")}`);
});

test("default model catalogue ships no apiKey values", () => {
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  // Every `apiKey:` inside the DEFAULT_SETTINGS-style literal must be empty.
  const assignments = [...app.matchAll(/apiKey:\s*(['"])([^'"]*)\1/g)];
  assert.ok(assignments.length > 0, "expected to find apiKey fields to check");
  const nonEmpty = assignments.filter((match) => match[2].length > 0);
  assert.deepEqual(
    nonEmpty.map((match) => match[0]),
    [],
    "client defaults must not contain a populated apiKey",
  );
});

test("the settings example carries no secrets either", () => {
  const example = fs.readFileSync(path.join(ROOT, "data", "settings.example.json"), "utf8");
  for (const { name, re } of PATTERNS) {
    assert.equal(re.test(example), false, `settings.example.json contains a ${name}`);
  }
});
