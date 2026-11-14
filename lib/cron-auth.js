/**
 * Cron endpoint authentication.
 *
 * Deny-by-default. The previous check was `if (cronAuth && ...)`, so an unset
 * CRON_SECRET disabled authentication entirely and anyone could call
 * /api/auto-analyze in a loop, burning AI credits and polluting the learning
 * data. A request header ("x-vercel-cron") is not authentication, so it is no
 * longer treated as a bypass on its own: the bearer secret is always required.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` for scheduled invocations
 * when CRON_SECRET is configured, so real cron traffic keeps working.
 */

const crypto = require("node:crypto");

function constantTimeEqual(a, b) {
  const digestA = crypto.createHash("sha256").update(String(a), "utf8").digest();
  const digestB = crypto.createHash("sha256").update(String(b), "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB) && String(a).length === String(b).length;
}

function bearerToken(req) {
  const header = String((req && req.headers && req.headers.authorization) || "");
  return header.replace(/^Bearer\s+/i, "").trim();
}

/**
 * @returns {{ ok: true } | { ok: false, status: number, message: string }}
 */
function authorizeCron(req, expected = process.env.CRON_SECRET) {
  const secret = String(expected || "").trim();
  if (!secret) {
    return {
      ok: false,
      status: 503,
      message: "Cron endpoints are disabled: CRON_SECRET is not configured.",
    };
  }
  const provided = bearerToken(req);
  if (!provided || !constantTimeEqual(provided, secret)) {
    return { ok: false, status: 401, message: "Unauthorized." };
  }
  return { ok: true };
}

module.exports = { authorizeCron };
