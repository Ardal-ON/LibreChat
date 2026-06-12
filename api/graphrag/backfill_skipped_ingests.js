/**
 * Backfill GraphRAG ingests for OCR files that were finalized while GRAPH_RAG_API_URL was unset.
 *
 * Usage (from LibreChat repo root):
 *   docker exec LibreChat node /app/api/graphrag/backfill_skipped_ingests.js
 */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const GRAPH_RAG_API_URL = process.env.GRAPH_RAG_API_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongodb:27017/LibreChat';

function graphRagToken(userId) {
  return jwt.sign({ id: String(userId) }, JWT_SECRET, { expiresIn: '15m' });
}

async function ingestDocument({ userId, fileId, filename, text }) {
  const response = await fetch(`${GRAPH_RAG_API_URL}/ingest-text`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${graphRagToken(userId)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      file_id: fileId,
      filename,
      text
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`GraphRAG ingest failed (${response.status}): ${detail}`);
  }
  return response.json();
}

async function main() {
  if (!GRAPH_RAG_API_URL || !JWT_SECRET) {
    throw new Error('GRAPH_RAG_API_URL and JWT_SECRET must be set');
  }

  await mongoose.connect(MONGO_URI);
  const files = mongoose.connection.collection('files');
  const candidates = await files
    .find({
      status: 'ready',
      text: { $exists: true, $type: 'string', $ne: '' },
      'metadata.ocr.graphrag.status': 'skipped'
    })
    .project({ file_id: 1, filename: 1, text: 1, user: 1 })
    .toArray();

  console.log(`Found ${candidates.length} skipped GraphRAG file(s) to backfill`);
  let ingested = 0;

  for (const file of candidates) {
    const userId = String(file.user);
    try {
      const result = await ingestDocument({
        userId,
        fileId: file.file_id,
        filename: file.filename,
        text: file.text
      });
      await files.updateOne(
        { _id: file._id },
        {
          $set: {
            'metadata.ocr.graphrag': {
              status: 'ready',
              chunk_count: result.chunk_count,
              ingestedAt: new Date()
            }
          }
        }
      );
      ingested += 1;
      console.log(`Ingested ${file.filename} for user ${userId} (${result.chunk_count ?? 0} chunks)`);
    } catch (error) {
      console.error(`Failed ${file.filename} for user ${userId}:`, error.message);
    }
  }

  console.log(`Backfill complete: ${ingested}/${candidates.length} ingested`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
