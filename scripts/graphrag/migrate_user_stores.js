#!/usr/bin/env node

/**
 * Migrates legacy global GraphRAG store.json into per-user stores.
 *
 * Strategy:
 * 1. For each document, resolve owner via MongoDB files collection (file_id match).
 * 2. Documents with a resolved owner are copied into users/{userId}/store.json.
 * 3. Unresolved documents are skipped (not migrated) unless --delete-orphans is passed.
 *
 * Usage:
 *   node scripts/graphrag/migrate_user_stores.js
 *   MONGO_URI=mongodb://... node scripts/graphrag/migrate_user_stores.js --dry-run
 *   node scripts/graphrag/migrate_user_stores.js --archive-legacy
 */

const fs = require('fs');
const path = require('path');
const { loadStore, saveStore, STORE_DIR } = require('../../api/graphrag/userStore');

const LEGACY_STORE_FILE = path.join(STORE_DIR, 'store.json');

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    archiveLegacy: argv.includes('--archive-legacy'),
    deleteOrphans: argv.includes('--delete-orphans'),
  };
}

async function resolveOwnersFromMongo(fileIds) {
  if (!process.env.MONGO_URI || fileIds.length === 0) {
    return new Map();
  }

  const { connectDb } = require('../../api/db/connect');
  const mongoose = await connectDb();
  const collection = mongoose?.connection?.db?.collection('files');
  if (!collection) {
    return new Map();
  }

  const records = await collection
    .find({ file_id: { $in: fileIds } }, { projection: { file_id: 1, user: 1 } })
    .toArray();

  const ownerByFileId = new Map();
  for (const record of records) {
    if (record?.file_id && record?.user) {
      ownerByFileId.set(record.file_id, String(record.user));
    }
  }
  return ownerByFileId;
}

function normalizeDoc(doc, fallbackId) {
  const file_id = doc?.file_id ?? doc?.fileId ?? fallbackId;
  return {
    ...doc,
    file_id,
    fileId: file_id,
    user_id: doc?.user_id ?? doc?.userId ?? null,
    userId: doc?.user_id ?? doc?.userId ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(LEGACY_STORE_FILE)) {
    console.log(`[migrate] No legacy store found at ${LEGACY_STORE_FILE}`);
    return;
  }

  const legacyStore = JSON.parse(fs.readFileSync(LEGACY_STORE_FILE, 'utf8'));
  const entries = Object.entries(legacyStore.files ?? {});
  if (entries.length === 0) {
    console.log('[migrate] Legacy store is empty; nothing to migrate.');
    return;
  }

  const fileIds = entries.map(([key, doc]) => doc?.file_id ?? doc?.fileId ?? key);
  const ownerByFileId = await resolveOwnersFromMongo(fileIds);

  const migratedByUser = new Map();
  let migrated = 0;
  let skipped = 0;

  for (const [storeKey, rawDoc] of entries) {
    const doc = normalizeDoc(rawDoc, storeKey);
    const ownerId = doc.user_id ?? ownerByFileId.get(doc.file_id) ?? null;

    if (!ownerId) {
      skipped += 1;
      console.warn(`[migrate] Skipping unowned document: ${doc.file_id ?? storeKey}`);
      continue;
    }

    const stampedDoc = { ...doc, user_id: ownerId, userId: ownerId };
    if (!migratedByUser.has(ownerId)) {
      migratedByUser.set(ownerId, {});
    }
    migratedByUser.get(ownerId)[doc.file_id] = stampedDoc;
    migrated += 1;
  }

  console.log(`[migrate] Resolved ${migrated} document(s), skipped ${skipped}.`);

  if (options.dryRun) {
    for (const [userId, files] of migratedByUser.entries()) {
      console.log(`[migrate] Would write ${Object.keys(files).length} doc(s) for user ${userId}`);
    }
    return;
  }

  for (const [userId, files] of migratedByUser.entries()) {
    const store = loadStore(userId);
    for (const [fileId, doc] of Object.entries(files)) {
      store.files[fileId] = doc;
    }
    saveStore(userId, store);
    console.log(`[migrate] Wrote ${Object.keys(files).length} doc(s) for user ${userId}`);
  }

  if (options.archiveLegacy) {
    const archivePath = `${LEGACY_STORE_FILE}.migrated.${Date.now()}.json`;
    fs.renameSync(LEGACY_STORE_FILE, archivePath);
    console.log(`[migrate] Archived legacy store to ${archivePath}`);
  } else if (options.deleteOrphans && skipped === 0) {
    fs.unlinkSync(LEGACY_STORE_FILE);
    console.log('[migrate] Removed legacy store after successful migration.');
  } else {
    console.log('[migrate] Legacy store left in place. Re-run with --archive-legacy when ready.');
  }
}

main().catch((error) => {
  console.error('[migrate] Failed:', error);
  process.exit(1);
});
