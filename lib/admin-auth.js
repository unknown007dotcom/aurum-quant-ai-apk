/**
 * Admin password verification.
 *
 * Deny-by-default: if ADMIN_PASSWORD is not configured, no password is accepted.
 * The previous implementation fell back to a hardcoded string, which meant every
 * deployment without the env var shipped a working admin password to anyone who
 * read the client bundle.
 *
 * Comparison is constant-time-ish to avoid leaking length/prefix through timing.
 */

const crypto = require("node:crypto");

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  // timingSafeEqual requires equal lengths; compare the digest instead.
  const digestA = crypto.createHash("sha256").update(bufA).digest();
  const digestB = crypto.createHash("sha256").update(bufB).digest();
  return crypto.timingSafeEqual(digestA, digestB) && bufA.length === bufB.length;
}

function isAdminPassword(supplied, expected = process.env.ADMIN_PASSWORD) {
  const expectedPassword = String(expected || "").trim();
  const suppliedPassword = String(supplied || "");
  if (!expectedPassword || !suppliedPassword) {
    return false;
  }
  return safeEqual(suppliedPassword, expectedPassword);
}

module.exports = { isAdminPassword };
