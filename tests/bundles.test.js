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
// which is how the browser sees history.js. Detection is
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

test("no shipped script imports a module that does not exist", () => {
  // The dead parallel frontend (modules/*.js, sim_boot.js, extract-engine.js) was
  // deleted in #24. A stale import would only surface as a 404 in the browser,
  // so resolve every local import/require against the filesystem here.
  const offenders = [];
  const sources = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "android", "www", "www-extra", "tests"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.(js|mjs)$/.test(entry.name)) sources.push(full);
    }
  };
  walk(ROOT);

  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    const specs = [];
    // import x from "./y"  |  import("./y")  |  require("./y")
    for (const match of text.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*["'](\.[^"']+)["']/g)) {
      specs.push(match[1]);
    }
    for (const spec of specs) {
      const target = path.resolve(path.dirname(file), spec);
      const candidates = [target, `${target}.js`, `${target}.mjs`, path.join(target, "index.js")];
      if (!candidates.some((candidate) => fs.existsSync(candidate))) {
        offenders.push(`${path.relative(ROOT, file)} -> ${spec}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `dangling local imports: ${offenders.join(", ")}`);
});

test("the dead parallel frontend stays deleted", () => {
  for (const gone of [
    "modules/analysis.js",
    "modules/api.js",
    "modules/config.js",
    "modules/dom.js",
    "modules/sentinel.js",
    "modules/state.js",
    "modules/ui.js",
    "modules/utils.js",
    "modules/engines/MixerEngine.js",
    "sim_boot.js",
    "extract-engine.js",
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, `${gone} should not exist`);
  }
  assert.equal(fs.existsSync(path.join(ROOT, "modules", "trade-levels.mjs")), true, "trade-levels.mjs is live");
});
