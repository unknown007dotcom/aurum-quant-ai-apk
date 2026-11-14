// Cron endpoint auth (issue #14): deny-by-default, header is not a credential.
const test = require("node:test");
const assert = require("node:assert/strict");

const { authorizeCron } = require("../lib/cron-auth");

const req = (headers = {}) => ({ headers });

test("unset CRON_SECRET disables cron endpoints (was: wide open)", () => {
  const result = authorizeCron(req({}), "");
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);

  const missing = authorizeCron(req({}), undefined);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 503);
});

test("x-vercel-cron header alone is not authentication", () => {
  const result = authorizeCron(req({ "x-vercel-cron": "1" }), "topsecret");
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("requires the exact bearer secret", () => {
  assert.equal(authorizeCron(req({ authorization: "Bearer topsecret" }), "topsecret").ok, true);
  assert.equal(authorizeCron(req({ authorization: "bearer topsecret" }), "topsecret").ok, true);
  assert.equal(authorizeCron(req({ authorization: "topsecret" }), "topsecret").ok, true);

  assert.equal(authorizeCron(req({ authorization: "Bearer wrong" }), "topsecret").status, 401);
  assert.equal(authorizeCron(req({ authorization: "Bearer topsecre" }), "topsecret").status, 401);
  assert.equal(authorizeCron(req({ authorization: "" }), "topsecret").status, 401);
  assert.equal(authorizeCron(req({}), "topsecret").status, 401);
});

test("both cron handlers reject unauthenticated requests", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const file of ["auto-analyze.js", "auto-learn.js"]) {
    const text = fs.readFileSync(path.join(__dirname, "..", "api-handlers", file), "utf8");
    assert.match(text, /authorizeCron\(req\)/, `${file} must use the shared cron guard`);
    assert.equal(
      /if \(cronAuth &&/.test(text),
      false,
      `${file} must not keep the "only check when configured" pattern`,
    );
    assert.equal(
      /isCronCall/.test(text),
      false,
      `${file} must not treat the x-vercel-cron header as authentication`,
    );
  }
});
