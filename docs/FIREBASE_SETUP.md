# Firestore setup

This project talks to Firestore **only** through the Admin SDK, server-side
(`lib/firebase-admin.js`), using the `FIREBASE_SERVICE_ACCOUNT_JSON` env var. The
browser never holds a Firebase web config, so no client can legitimately read or
write the database.

That makes the correct security posture simple: **deny all client access**, and
keep every read/write behind the API routes where validation, device identity and
rate limiting live.

## 1. Deploy the rules

```bash
npm install -g firebase-tools   # once
firebase login                  # once
firebase deploy --only firestore:rules,firestore:indexes
```

`firestore.rules` denies every client read and write:

```js
match /{document=**} {
  allow read, write: if false;
}
```

The Admin SDK bypasses these rules, so the app keeps working.

## 2. Verify test mode is actually off

This is the step that matters — a database left in console "test mode"
(`allow read, write: if true`) makes every API control moot, because anyone can
talk to Firestore directly with the public project id.

**Firebase console → Firestore Database → Rules**

- The editor must show the contents of `firestore.rules`.
- It must **not** show `allow read, write: if true` or an expiry banner such as
  "Your rules allow anyone to read or write…".

Or from the CLI:

```bash
firebase firestore:databases:list          # find the database name
firebase firestore:databases:get <db>      # note: rules are shown in the console
```

**Recommended check that does not need console access** — try to read a document
as an unauthenticated client with the REST API. An `401`/`403` means the rules are
closed; a `200` means the database is wide open:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://firestore.googleapis.com/v1/projects/<PROJECT_ID>/databases/(default)/documents/learning/global"
```

`403` = good. `200` = **the rules are not deployed** — fix immediately.

## 3. Indexes

`firestore.indexes.json` declares the composite indexes the server queries need:

| Collection | Fields | Used by |
| --- | --- | --- |
| `learning_feedback` | `entryId` + `outcome` | `auto-learn.js` dedupe before insert |
| `learning_feedback` | `createdAt` DESC | `settings.js` metrics |
| `analysis_history` | `createdAt` DESC | `history-log.js`, `settings.js`, `ai-decision.js` |
| `learning_model_reviews` | `createdAt` DESC | `settings.js` review list |
| `learning_model_reviews` | `entryId` | `auto-learn.js` one-review-per-loss |
| `learning` | `createdAt` DESC | `learning-context.js` latest lessons |

Index builds can take a few minutes. Until they finish, the affected queries fail
with `FAILED_PRECONDITION`; that error names the exact index it wants, so if one
is missing the console error tells you what to add.

## 4. Collections in use

| Collection | Purpose | Contains secrets? |
| --- | --- | --- |
| `admin/settings` | Admin settings document | **Yes** — OANDA token, NVIDIA keys |
| `analysis_history` | Saved analyses | No |
| `learning/global` | Win/loss totals, top loss reasons | No |
| `learning_feedback` | Individual win/loss notes | No |
| `learning_model_reviews` | Post-mortem model debates | No |

`admin/settings` is the reason deny-all matters: with open rules, the OANDA token
and every AI key are one public REST call away. They are also readable by any
authenticated admin through `GET /api/settings`, which is why
`ADMIN_PASSWORD` must be set (see `.env.example`).

## 5. Rotating credentials

If keys were ever committed or the rules were ever open, rotate them:

1. OANDA → Account → Manage API access → revoke and regenerate the token.
2. NVIDIA → build.nvidia.com → API keys → revoke and regenerate.
3. Update `FIREBASE_SERVICE_ACCOUNT_JSON`, `OANDA_API_TOKEN`, the NVIDIA keys and
   `ADMIN_PASSWORD` in your deployment environment, then re-save them through the
   Settings panel so `admin/settings` no longer holds the old values.

Removing a secret from git history does not un-leak it.
