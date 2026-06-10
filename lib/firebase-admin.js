const fs = require("node:fs");
const path = require("node:path");

let cached = {
  app: null,
  firestore: null,
};

const FALLBACK_FILE = path.join(__dirname, "../data/settings.json");

function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (fs.existsSync(dirname)) {
    return true;
  }
  ensureDirectoryExistence(dirname);
  fs.mkdirSync(dirname);
}

function getServiceAccountJson() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getFirestore() {
  if (cached.firestore) {
    return cached.firestore;
  }

  // eslint-disable-next-line global-require
  const admin = require("firebase-admin");

  if (!cached.app) {
    const serviceAccount = getServiceAccountJson();
    if (serviceAccount) {
      cached.app = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } else {
      cached.app = admin.initializeApp();
    }
  }

  cached.firestore = admin.firestore();
  return cached.firestore;
}

function getLocalSettingsFallback() {
  try {
    if (fs.existsSync(FALLBACK_FILE)) {
      return JSON.parse(fs.readFileSync(FALLBACK_FILE, "utf8")) || {};
    }
  } catch (e) {
    console.error("Failed to read local settings fallback:", e);
  }
  return {};
}

function saveLocalSettingsFallback(payload) {
  try {
    ensureDirectoryExistence(FALLBACK_FILE);
    let current = {};
    if (fs.existsSync(FALLBACK_FILE)) {
      current = JSON.parse(fs.readFileSync(FALLBACK_FILE, "utf8")) || {};
    }
    const next = { ...current, ...payload };
    fs.writeFileSync(FALLBACK_FILE, JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to write local settings fallback:", e);
  }
}

async function getAdminSettings() {
  try {
    const firestore = getFirestore();
    const snapshot = await firestore.collection("admin").doc("settings").get();
    if (!snapshot.exists) {
      return getLocalSettingsFallback();
    }
    return snapshot.data() || getLocalSettingsFallback();
  } catch (err) {
    return getLocalSettingsFallback();
  }
}

async function setAdminSettings(payload) {
  try {
    const firestore = getFirestore();
    await firestore.collection("admin").doc("settings").set(payload, { merge: true });
    saveLocalSettingsFallback(payload);
  } catch (err) {
    saveLocalSettingsFallback(payload);
  }
}

module.exports = {
  getFirestore,
  getAdminSettings,
  setAdminSettings,
};
