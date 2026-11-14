// Tests for admin auth (deny-by-default) and the settings secrets policy.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Formerly-shipped admin password, assembled so this file itself stays clean.
const LEGACY_ADMIN_PASSWORD = ["Aviraj", "@api7"].join("");

const { isAdminPassword } = require("../lib/admin-auth");

test("admin auth denies everything when ADMIN_PASSWORD is unset", () => {
  assert.equal(isAdminPassword(LEGACY_ADMIN_PASSWORD, ""), false);
  assert.equal(isAdminPassword(LEGACY_ADMIN_PASSWORD, undefined), false);
  assert.equal(isAdminPassword("", ""), false);
  assert.equal(isAdminPassword("", undefined), false);
  assert.equal(isAdminPassword("anything"), false);
});

test("admin auth accepts only the configured password", () => {
  assert.equal(isAdminPassword("s3cret-pass", "s3cret-pass"), true);
  assert.equal(isAdminPassword("wrong-pass", "s3cret-pass"), false);
  assert.equal(isAdminPassword("s3cret", "s3cret-pass"), false);
  assert.equal(isAdminPassword("s3cret-pass-longer", "s3cret-pass"), false);
});

test("admin auth reads process.env.ADMIN_PASSWORD through the default", () => {
  process.env.ADMIN_PASSWORD = "env-configured";
  assert.equal(isAdminPassword("env-configured"), true);
  assert.equal(isAdminPassword(LEGACY_ADMIN_PASSWORD), false);
  delete process.env.ADMIN_PASSWORD;
});

test("settings store is not tracked by git", () => {
  const tracked = require("node:child_process")
    .execFileSync("git", ["ls-files", "data/settings.json"], { encoding: "utf8" })
    .trim();
  assert.equal(tracked, "", "data/settings.json must stay untracked (it holds live API tokens)");
});

test("committed settings example carries no credentials", () => {
  const example = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "data/settings.example.json"), "utf8"),
  );
  assert.equal(example.oandaApiToken, "");
  assert.equal(example.globalNvidiaApiKey, "");
  assert.deepEqual(example.globalNvidiaApiKeys, []);
  const serialized = JSON.stringify(example);
  assert.equal(/nvapi-/.test(serialized), false, "example must not contain an NVIDIA key");
  for (const model of [...(example.nvidiaModels || []), ...(example.debateModels || [])]) {
    assert.equal("apiKey" in model, false, `${model.key} must not ship an apiKey`);
  }
  assert.equal(/[a-f0-9]{32}-[a-f0-9]{32}/i.test(serialized), false, "example must not contain an OANDA token");
});

test("no source file hardcodes the old admin password", () => {
  const offenders = [];
  const skipDirs = new Set(["node_modules", ".git", "android"]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|html|json)$/.test(entry.name) && entry.name !== "CODE_REVIEW.md") {
        const text = fs.readFileSync(full, "utf8");
        if (text.includes(LEGACY_ADMIN_PASSWORD)) offenders.push(path.relative(path.join(__dirname, ".."), full));
      }
    }
  };
  walk(path.join(__dirname, ".."));
  assert.deepEqual(offenders, [], `hardcoded admin password found in: ${offenders.join(", ")}`);
});
