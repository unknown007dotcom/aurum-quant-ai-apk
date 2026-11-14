// Firestore security posture (issue #28).
//
// The rules cannot be evaluated without the emulator, so these tests assert the
// properties that actually matter: the files exist, the rules deny every client,
// and nobody has quietly reintroduced a client SDK or a public web config.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("rules and config are committed", () => {
  for (const file of ["firestore.rules", "firestore.indexes.json", "firebase.json", "docs/FIREBASE_SETUP.md"]) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), true, `${file} must be committed`);
  }
});

test("firebase.json points at the committed rules and indexes", () => {
  const config = JSON.parse(read("firebase.json"));
  assert.equal(config.firestore.rules, "firestore.rules");
  assert.equal(config.firestore.indexes, "firestore.indexes.json");
});

test("rules are deny-all for clients", () => {
  const rules = read("firestore.rules");
  assert.match(rules, /match \/\{document=\*\*\}/, "must cover every document");
  assert.match(rules, /allow read, write: if false;/, "must deny reads and writes");
  // No condition that could ever be true for a client.
  assert.equal(
    /allow[^;]*if\s*(?:true|request\.auth)/.test(rules.replace(/\/\/.*$/gm, "")),
    false,
    "must not contain a permissive rule",
  );
});

test("no client Firebase SDK is loaded anywhere", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "android", "www", "tests", "cloudflare-backend"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|html)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        // The Admin SDK is fine; a browser web config is not. A web config is
        // recognisable by its apiKey/projectId/authDomain keys, not by
        // initializeApp alone (lib/firebase-admin.js calls it with a service
        // account credential).
        if (/firebaseConfig|authDomain\s*:/.test(text)) {
          offenders.push(path.relative(ROOT, full));
        }
        if (/firebase\/firestore|firebase\/app["']/.test(text)) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], `client Firebase usage found in: ${offenders.join(", ")}`);
});

test("only the Admin SDK touches Firestore", () => {
  const admin = read("lib/firebase-admin.js");
  assert.match(admin, /require\("firebase-admin"\)/);
  assert.match(admin, /FIREBASE_SERVICE_ACCOUNT_JSON/, "must use the service account, not a public config");
});

test("declared indexes cover the queries the server actually runs", () => {
  const indexes = JSON.parse(read("firestore.indexes.json")).indexes;
  const has = (collection, field) =>
    indexes.some(
      (index) =>
        index.collectionGroup === collection &&
        index.fields.some((f) => f.fieldPath === field),
    );

  // Composite dedupe query in auto-learn.js
  const composite = indexes.find(
    (index) =>
      index.collectionGroup === "learning_feedback" &&
      index.fields.length > 1 &&
      index.fields.some((f) => f.fieldPath === "entryId") &&
      index.fields.some((f) => f.fieldPath === "outcome"),
  );
  assert.ok(composite, "learning_feedback needs entryId + outcome for the dedupe query");

  assert.ok(has("analysis_history", "createdAt"), "history queries order by createdAt");
  assert.ok(has("learning_model_reviews", "createdAt"), "review list orders by createdAt");
  assert.ok(has("learning_model_reviews", "entryId"), "one-review-per-loss filters by entryId");
  assert.ok(has("learning_feedback", "createdAt"), "feedback metrics order by createdAt");
  assert.ok(has("learning", "createdAt"), "learning-context orders by createdAt");
});

test("setup doc tells the operator how to verify test mode is off", () => {
  const doc = read("docs/FIREBASE_SETUP.md");
  assert.match(doc, /test mode/i);
  assert.match(doc, /firestore\.googleapis\.com/, "must include a way to check from outside the console");
  assert.match(doc, /firebase deploy --only firestore:rules/);
});
