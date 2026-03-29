const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const app = express();

const GRAPH_RAG_PORT = Number.parseInt(process.env.GRAPH_RAG_PORT ?? '8001', 10);
const STORE_DIR = process.env.GRAPH_RAG_STORE_DIR ?? path.join(process.cwd(), 'api', 'data', 'graphrag');
const STORE_FILE = path.join(STORE_DIR, 'store.json');
const CHUNK_SIZE = Number.parseInt(process.env.GRAPH_RAG_CHUNK_SIZE ?? '1200', 10);
const CHUNK_OVERLAP = Number.parseInt(process.env.GRAPH_RAG_CHUNK_OVERLAP ?? '160', 10);

const stopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has',
  'have', 'he', 'her', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'our', 'ours', 'she', 'that', 'the', 'their', 'theirs', 'them', 'they', 'this',
  'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your',
  'yours', 'can', 'could', 'would', 'should', 'will', 'may', 'might', 'than', 'then', 'there', 'here',
]);

function ensureStore() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ files: {} }, null, 2));
  }
}

function loadStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
}

function saveStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function normalizeWhitespace(text) {
  return text.replace(/\r\n/g, '\n').replace(/\t/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function tokenize(text) {
  return Array.from(
    new Set(
      (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((token) => !stopWords.has(token)),
    ),
  );
}

function extractEntities(text) {
  const matches = [
    ...(text.match(/\b[A-Z]{2,}(?:\s+[A-Z]{2,})*\b/g) ?? []),
    ...(text.match(/\b[A-Z][a-zA-Z0-9_-]{2,}(?:\s+[A-Z][a-zA-Z0-9_-]{2,})*\b/g) ?? []),
  ];

  return Array.from(
    new Set(
      matches
        .map((entity) => entity.trim())
        .filter((entity) => entity.length >= 3)
        .map((entity) => entity.replace(/\s+/g, ' ')),
    ),
  );
}

function chunkText(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }

  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + CHUNK_SIZE, normalized.length);
    if (end < normalized.length) {
      const paragraphBoundary = normalized.lastIndexOf('\n\n', end);
      const sentenceBoundary = normalized.lastIndexOf('. ', end);
      const boundary = Math.max(paragraphBoundary, sentenceBoundary);
      if (boundary > start + Math.floor(CHUNK_SIZE * 0.5)) {
        end = boundary + 1;
      }
    }

    const value = normalized.slice(start, end).trim();
    if (value) {
      chunks.push(value);
    }

    if (end >= normalized.length) {
      break;
    }

    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }

  return chunks;
}

function buildGraphDocument({ fileId, filename, text, entityId }) {
  const chunks = chunkText(text).map((value, index) => ({
    id: `${fileId}:${index}`,
    index,
    text: value,
    entities: extractEntities(value),
    tokens: tokenize(value),
  }));

  const entities = {};
  for (const chunk of chunks) {
    for (const entity of chunk.entities) {
      const normalizedEntity = entity.toLowerCase();
      if (!entities[normalizedEntity]) {
        entities[normalizedEntity] = {
          label: entity,
          chunkIds: [],
          occurrences: 0,
        };
      }
      entities[normalizedEntity].chunkIds.push(chunk.id);
      entities[normalizedEntity].occurrences += 1;
    }
  }

  const adjacency = {};
  for (const chunk of chunks) {
    adjacency[chunk.id] = new Set();
  }

  for (let index = 0; index < chunks.length - 1; index += 1) {
    adjacency[chunks[index].id].add(chunks[index + 1].id);
    adjacency[chunks[index + 1].id].add(chunks[index].id);
  }

  for (const entity of Object.values(entities)) {
    for (let index = 0; index < entity.chunkIds.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < entity.chunkIds.length; otherIndex += 1) {
        adjacency[entity.chunkIds[index]].add(entity.chunkIds[otherIndex]);
        adjacency[entity.chunkIds[otherIndex]].add(entity.chunkIds[index]);
      }
    }
  }

  return {
    fileId,
    filename,
    entityId: entityId ?? null,
    updatedAt: new Date().toISOString(),
    textHash: crypto.createHash('sha256').update(text).digest('hex'),
    chunks,
    entities,
    adjacency: Object.fromEntries(
      Object.entries(adjacency).map(([chunkId, neighbors]) => [chunkId, Array.from(neighbors)]),
    ),
  };
}

function createQueryProfile(query) {
  return {
    normalized: query.toLowerCase(),
    tokens: tokenize(query),
    entities: extractEntities(query).map((entity) => entity.toLowerCase()),
  };
}

function computeChunkScore(queryProfile, document, chunk) {
  const tokenHits = queryProfile.tokens.filter((token) => chunk.tokens.includes(token)).length;
  const entityHits = queryProfile.entities.filter((entity) =>
    chunk.entities.some((chunkEntity) => chunkEntity.toLowerCase() === entity),
  ).length;

  const tokenScore = queryProfile.tokens.length === 0 ? 0 : tokenHits / queryProfile.tokens.length;
  const entityScore = queryProfile.entities.length === 0 ? 0 : entityHits / queryProfile.entities.length;
  const phraseScore = chunk.text.toLowerCase().includes(queryProfile.normalized) ? 1 : 0;

  const neighborIds = document.adjacency[chunk.id] ?? [];
  const neighborChunks = neighborIds
    .map((neighborId) => document.chunks.find((candidate) => candidate.id === neighborId))
    .filter(Boolean);
  const neighborEntityHits = neighborChunks.reduce((score, neighborChunk) => {
    const overlap = queryProfile.entities.filter((entity) =>
      neighborChunk.entities.some((chunkEntity) => chunkEntity.toLowerCase() === entity),
    ).length;
    return score + overlap;
  }, 0);
  const neighborScore = queryProfile.entities.length === 0 ? 0 : Math.min(1, neighborEntityHits / queryProfile.entities.length);

  const graphDensity = chunk.entities.length === 0
    ? 0
    : chunk.entities.reduce((score, entity) => {
        const graphEntity = document.entities[entity.toLowerCase()];
        return score + ((graphEntity?.chunkIds.length ?? 0) > 1 ? 1 : 0);
      }, 0) / chunk.entities.length;

  return Math.min(1, tokenScore * 0.4 + entityScore * 0.35 + neighborScore * 0.15 + graphDensity * 0.05 + phraseScore * 0.05);
}

function queryGraphDocument(document, query, requestedCount) {
  const queryProfile = createQueryProfile(query);

  return document.chunks
    .map((chunk) => ({ chunk, score: computeChunkScore(queryProfile, document, chunk) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, requestedCount)
    .map(({ chunk, score }) => [
      {
        page_content: chunk.text,
        metadata: {
          file_id: document.fileId,
          source: document.filename,
          graph_entities: chunk.entities,
          retrieval: 'graphrag',
        },
      },
      Math.max(0, 1 - score),
    ]);
}

function authMiddleware(req, res, next) {
  if (!process.env.JWT_SECRET) {
    next();
    return;
  }

  const header = req.headers.authorization ?? '';
  const [, token] = header.split(' ');
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid bearer token' });
  }
}

app.use(express.json({ limit: '10mb' }));
app.use(authMiddleware);

app.get('/health', (_req, res) => {
  const store = loadStore();
  res.json({ status: 'ok', files: Object.keys(store.files).length });
});

app.post('/ingest-text', (req, res) => {
  const { file_id: fileId, filename, text, entity_id: entityId } = req.body ?? {};
  if (!fileId || !filename || !text) {
    res.status(400).json({ error: 'file_id, filename, and text are required' });
    return;
  }

  const store = loadStore();
  store.files[fileId] = buildGraphDocument({ fileId, filename, text, entityId });
  saveStore(store);

  res.json({
    status: true,
    file_id: fileId,
    chunk_count: store.files[fileId].chunks.length,
    entity_count: Object.keys(store.files[fileId].entities).length,
  });
});

app.post('/query', (req, res) => {
  const { file_id: fileId, query, k = 5, entity_id: entityId } = req.body ?? {};
  if (!fileId || !query) {
    res.status(400).json({ error: 'file_id and query are required' });
    return;
  }

  const store = loadStore();
  const document = store.files[fileId];
  if (!document) {
    res.json([]);
    return;
  }

  if (document.entityId != null && entityId != null && document.entityId !== entityId) {
    res.json([]);
    return;
  }

  res.json(queryGraphDocument(document, query, Number.parseInt(String(k), 10) || 5));
});

app.delete('/documents', (req, res) => {
  const ids = Array.isArray(req.body) ? req.body : [];
  const store = loadStore();
  let deleted = 0;

  for (const fileId of ids) {
    if (store.files[fileId]) {
      delete store.files[fileId];
      deleted += 1;
    }
  }

  saveStore(store);
  res.json({ message: `Deleted ${deleted} GraphRAG document(s)` });
});

ensureStore();
app.listen(GRAPH_RAG_PORT, '0.0.0.0', () => {
  console.log(`GraphRAG service listening on port ${GRAPH_RAG_PORT}`);
});
