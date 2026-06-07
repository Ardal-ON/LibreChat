const fs = require('fs');
const path = require('path');

const STORE_DIR =
  process.env.GRAPH_RAG_STORE_DIR ?? path.join(process.cwd(), 'api', 'data', 'graphrag');
const LC_USER_ID_KEY = '__lc_user_id';

function assertUserId(userId) {
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('Unauthorized: missing authenticated user context');
  }
  return userId;
}

function getStorePath(userId) {
  return path.join(STORE_DIR, 'users', assertUserId(userId), 'store.json');
}

function ensureStore(userId) {
  const storePath = getStorePath(userId);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  if (!fs.existsSync(storePath)) {
    fs.writeFileSync(storePath, JSON.stringify({ files: {} }, null, 2));
  }
}

function loadStore(userId) {
  ensureStore(userId);
  return JSON.parse(fs.readFileSync(getStorePath(userId), 'utf8'));
}

function saveStore(userId, store) {
  ensureStore(userId);
  fs.writeFileSync(getStorePath(userId), JSON.stringify(store, null, 2));
}

function requireUserId(args) {
  const userId = args?.[LC_USER_ID_KEY];
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('Unauthorized: missing authenticated user context');
  }
  return userId;
}

function stripUserId(args) {
  if (!args || typeof args !== 'object') {
    return {};
  }
  const { [LC_USER_ID_KEY]: _removed, ...rest } = args;
  return rest;
}

function docOwnedByUser(doc, userId) {
  const docUserId = doc?.user_id ?? doc?.userId ?? null;
  if (docUserId == null) {
    return false;
  }
  return docUserId === userId;
}

module.exports = {
  STORE_DIR,
  LC_USER_ID_KEY,
  assertUserId,
  getStorePath,
  ensureStore,
  loadStore,
  saveStore,
  requireUserId,
  stripUserId,
  docOwnedByUser,
};
