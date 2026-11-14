// Static checks on the shipped client/mobile bundles.
//
// The Android APK is built by copying mobile/www-extra/*.js verbatim into the
// WebView (see mobile/scripts/build-www.mjs). There is no bundler and no type
// check, so a mangled file only fails once a user installs the APK. These tests
// parse every shipped script so a syntax error fails CI instead.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

// A file is treated as an ES module if its source uses import/export syntax,
// which is how the browser sees modules/config.js and history.js. Detection is
// source-based (not message-based) because Node 20 and 22 word the "not a
// module" warning differently.
function looksLikeEsm(relPath) {
  const text = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  return /^\s*(?:export\s+(?:const|let|var|function|class|default)|import\s+[^("])/m.test(text);
}

function runCheck(file) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    return null;
  } catch (error) {
    return String(error.stderr || error.message).split("\n").slice(0, 4).join(" ");
  }
}

function syntaxCheck(relPath) {
  const file = path.join(ROOT, relPath);
  if (!looksLikeEsm(relPath)) {
    return runCheck(file);
  }
  // Node only allows `--check` to treat a file as a module via its extension.
  const tmp = path.join(require("node:os").tmpdir(), `syntax-${process.pid}-${path.basename(relPath)}.mjs`);
  try {
    fs.copyFileSync(file, tmp);
    return runCheck(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const SHIPPED_SCRIPTS = [
  "app.js",
  "history.js",
  "server.js",
  "api/index.js",
  "modules/config.js",
  "mobile/www-extra/aurum-backend.js",
  "mobile/www-extra/mobile-runtime.js",
];

for (const script of SHIPPED_SCRIPTS) {
  test(`shipped script parses: ${script}`, () => {
    const file = path.join(ROOT, script);
    if (!fs.existsSync(file)) {
      // mobile-runtime.js is optional in the build.
      return;
    }
    const error = syntaxCheck(script);
    assert.equal(error, null, `${script} does not parse: ${error}`);
  });
}

test("no truncated '[...]' markers in shipped scripts", () => {
  // Two fallback payloads in the mobile backend were previously stored as
  // "binary-ish" truncated strings ending in "[...]", which made the whole file
  // a syntax error and left the APK without a working backend.
  const offenders = [];
  for (const script of SHIPPED_SCRIPTS) {
    const file = path.join(ROOT, script);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("[...]")) offenders.push(script);
  }
  assert.deepEqual(offenders, [], `truncated payload marker found in: ${offenders.join(", ")}`);
});
