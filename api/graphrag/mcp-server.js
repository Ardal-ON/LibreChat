const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const STORE_DIR =
  process.env.GRAPH_RAG_STORE_DIR ?? path.join(process.cwd(), 'api', 'data', 'graphrag');
const STORE_FILE = path.join(STORE_DIR, 'store.json');
const CHUNK_SIZE = Number.parseInt(process.env.GRAPH_RAG_CHUNK_SIZE ?? '1200', 10);
const CHUNK_OVERLAP = Number.parseInt(process.env.GRAPH_RAG_CHUNK_OVERLAP ?? '160', 10);
const UPLOADS_DIR = process.env.GRAPHRAG_UPLOADS_DIR ?? '/app/uploads';
const MAX_INGEST_FILE_BYTES = Number.parseInt(process.env.GRAPHRAG_MAX_FILE_BYTES ?? '2097152', 10);

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
  const matches = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g) ?? [];
  return Array.from(new Set(matches.filter((m) => m.length >= 3)));
}

function chunkText(text) {
  const chunks = [];
  const clean = normalizeWhitespace(text);

  if (!clean) {
    return chunks;
  }

  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length);
    const slice = clean.slice(start, end);
    chunks.push(slice);
    if (end >= clean.length) {
      break;
    }
    start = Math.max(0, end - CHUNK_OVERLAP);
  }

  return chunks;
}

function buildGraphDocument({ file_id, filename, text, entity_id }) {
  const chunks = chunkText(text);
  const nodes = [];

  chunks.forEach((content, index) => {
    const tokens = tokenize(content);
    const entities = extractEntities(content);
    const edges = [];

    if (index > 0) {
      edges.push(index - 1);
    }
    if (index < chunks.length - 1) {
      edges.push(index + 1);
    }

    nodes.push({
      id: `${file_id}::${index}`,
      index,
      content,
      tokens,
      entities,
      edges,
      hash: crypto.createHash('sha1').update(content).digest('hex'),
    });
  });

  return {
    file_id,
    filename,
    entity_id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chunkCount: nodes.length,
    nodes,
  };
}

function computeChunkScore(node, queryTokens, queryEntities, rawQuery) {
  const tokenOverlap = queryTokens.filter((token) => node.tokens.includes(token)).length;
  const entityOverlap = queryEntities.filter((entity) => node.entities.includes(entity)).length;

  const tokenScore = queryTokens.length ? tokenOverlap / queryTokens.length : 0;
  const entityScore = queryEntities.length ? entityOverlap / queryEntities.length : 0;

  const lowerContent = node.content.toLowerCase();
  const exactPhraseBoost = lowerContent.includes(rawQuery.toLowerCase()) ? 0.05 : 0;

  const density = node.entities.length ? Math.min(node.entities.length / 10, 1) : 0;

  return tokenScore * 0.4 + entityScore * 0.35 + density * 0.2 + exactPhraseBoost;
}

function queryGraphDocument(doc, rawQuery, topK = 5) {
  const queryTokens = tokenize(rawQuery);
  const queryEntities = extractEntities(rawQuery);

  const ranked = doc.nodes
    .map((node) => {
      const score = computeChunkScore(node, queryTokens, queryEntities, rawQuery);
      return { node, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return ranked.map(({ node, score }) => ({
    file_id: doc.file_id,
    filename: doc.filename,
    entity_id: doc.entity_id ?? null,
    chunk_index: node.index,
    score,
    distance: Number((1 - Math.min(score, 1)).toFixed(6)),
    content: node.content,
    entities: node.entities,
  }));
}

function listDocuments() {
  const store = loadStore();
  return Object.values(store.files).map((doc) => ({
    file_id: doc.file_id,
    filename: doc.filename,
    entity_id: doc.entity_id ?? null,
    chunkCount: doc.chunkCount ?? doc.nodes?.length ?? 0,
    updatedAt: doc.updatedAt ?? doc.createdAt,
  }));
}

function ingestDocument({ file_id, filename, text, entity_id }) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  const placeholderPattern = /^document text for\s+.+\.(txt|md)$/i;
  if (!normalized || placeholderPattern.test(normalized)) {
    throw new Error(
      'Invalid text payload for ingest_document. Please provide real document text or use graphrag_ingest_uploaded_file.',
    );
  }

  const store = loadStore();
  const doc = buildGraphDocument({ file_id, filename, text, entity_id });
  store.files[file_id] = doc;
  saveStore(store);
  return { file_id, filename: doc.filename, chunks: doc.chunkCount };
}

function isSupportedTextExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.txt' || ext === '.md';
}

function walkFilesRecursive(dir, collector) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFilesRecursive(fullPath, collector);
      continue;
    }
    if (entry.isFile()) {
      collector.push(fullPath);
    }
  }
}

function getUploadedTextFiles() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    return [];
  }

  const allFiles = [];
  walkFilesRecursive(UPLOADS_DIR, allFiles);
  return allFiles
    .filter((filePath) => isSupportedTextExtension(filePath))
    .map((filePath) => ({
      path: filePath,
      basename: path.basename(filePath),
      mtimeMs: fs.statSync(filePath).mtimeMs,
      size: fs.statSync(filePath).size,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findUploadedFileByName(filename) {
  if (!fs.existsSync(UPLOADS_DIR)) {
    throw new Error(`Uploads directory not found: ${UPLOADS_DIR}`);
  }

  const allFiles = getUploadedTextFiles().map((f) => f.path);

  const normalizedName = filename.trim();
  const candidates = allFiles
    .filter((filePath) => {
      const base = path.basename(filePath);
      // LibreChat often stores files with UUID__original-name pattern.
      return base === normalizedName || base.endsWith(`__${normalizedName}`);
    })
    .filter((filePath) => isSupportedTextExtension(filePath));

  if (candidates.length === 0) {
    const available = getUploadedTextFiles()
      .slice(0, 20)
      .map((f) => f.basename)
      .join(', ');
    throw new Error(
      `No uploaded .md/.txt file found for filename: ${filename}. Available uploaded text files: ${available || '(none)'}`,
    );
  }

  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

function ingestUploadedFile({ filename, file_id, entity_id }) {
  const foundPath = findUploadedFileByName(filename);
  const stat = fs.statSync(foundPath);
  if (stat.size > MAX_INGEST_FILE_BYTES) {
    throw new Error(
      `File too large (${stat.size} bytes). Limit is ${MAX_INGEST_FILE_BYTES} bytes for MCP file ingest.`,
    );
  }

  const text = fs.readFileSync(foundPath, 'utf8');
  const derivedFileId =
    file_id ??
    `upload-${crypto
      .createHash('sha1')
      .update(`${foundPath}:${stat.mtimeMs}:${stat.size}`)
      .digest('hex')
      .slice(0, 16)}`;

  const result = ingestDocument({
    file_id: derivedFileId,
    filename,
    text,
    entity_id,
  });

  return {
    ...result,
    uploaded_path: foundPath,
    bytes: stat.size,
  };
}

function queryKnowledge({ query, top_k = 8, file_ids }) {
  const store = loadStore();
  const candidates = Object.values(store.files).filter((doc) => {
    if (!Array.isArray(file_ids) || file_ids.length === 0) {
      return true;
    }
    return file_ids.includes(doc.file_id);
  });

  const all = candidates.flatMap((doc) => queryGraphDocument(doc, query, top_k));
  return all.sort((a, b) => a.distance - b.distance).slice(0, top_k);
}

function batchQueryKnowledge({ queries = [], top_k = 8, file_ids }) {
  return queries.map((query) => {
    const results = queryKnowledge({ query, top_k, file_ids });
    return {
      query,
      count: results.length,
      results,
    };
  });
}

function deleteDocuments(file_ids = []) {
  const store = loadStore();
  let deleted = 0;
  for (const file_id of file_ids) {
    if (store.files[file_id]) {
      delete store.files[file_id];
      deleted += 1;
    }
  }
  saveStore(store);
  return { deleted, requested: file_ids.length };
}

function textResponse(payload) {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

const tools = [
  {
    name: 'graphrag_ingest_document',
    description:
      'Ingest or update a document in GraphRAG knowledge store. Use this when user provides document text to persist knowledge across chats.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Unique document id (stable id recommended).' },
        filename: { type: 'string', description: 'Human-readable document name.' },
        text: { type: 'string', description: 'Full document text content.' },
        entity_id: { type: 'string', description: 'Optional tenant or project id.' },
      },
      required: ['file_id', 'filename', 'text'],
    },
  },
  {
    name: 'graphrag_query_knowledge',
    description:
      'Query the persistent GraphRAG knowledge base. Supports optional file_id filtering and returns top ranked evidence snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language question for retrieval.' },
        top_k: { type: 'number', description: 'Max number of retrieved snippets.', default: 8 },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of file ids to constrain retrieval scope.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'graphrag_batch_query_knowledge',
    description:
      'Run multiple GraphRAG queries in one tool call to avoid tool-call limits during acceptance testing.',
    inputSchema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of natural language questions to query in batch.',
        },
        top_k: { type: 'number', description: 'Max snippets returned per query.', default: 8 },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of file ids to constrain retrieval scope.',
        },
      },
      required: ['queries'],
    },
  },
  {
    name: 'graphrag_ingest_uploaded_file',
    description:
      'Ingest an uploaded .md/.txt file directly from LibreChat uploads directory, so users do not need to paste full text.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description:
            'Original uploaded filename (for example report.md). The server auto-resolves UUID-prefixed storage names.',
        },
        file_id: {
          type: 'string',
          description: 'Optional stable document id. If omitted, id is auto-generated from file metadata.',
        },
        entity_id: { type: 'string', description: 'Optional tenant or project id.' },
      },
      required: ['filename'],
    },
  },
  {
    name: 'graphrag_list_uploaded_text_files',
    description:
      'List currently available uploaded .md/.txt files under LibreChat uploads directory for troubleshooting ingest_uploaded_file.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'graphrag_list_documents',
    description: 'List all documents currently indexed in GraphRAG persistent store.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'graphrag_delete_documents',
    description: 'Delete one or more documents from GraphRAG persistent store.',
    inputSchema: {
      type: 'object',
      properties: {
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Document ids to remove from knowledge base.',
        },
      },
      required: ['file_ids'],
    },
  },
];

async function main() {
  ensureStore();

  const server = new Server(
    {
      name: 'semaa-graphrag-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (name === 'graphrag_ingest_document') {
      try {
        const result = ingestDocument({
          file_id: args.file_id,
          filename: args.filename,
          text: args.text,
          entity_id: args.entity_id,
        });
        return textResponse({ status: 'ok', action: 'ingested', ...result });
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to ingest document: ${error.message}`,
            },
          ],
        };
      }
    }

    if (name === 'graphrag_query_knowledge') {
      const result = queryKnowledge({
        query: args.query,
        top_k: args.top_k,
        file_ids: args.file_ids,
      });
      return textResponse({ status: 'ok', action: 'queried', count: result.length, results: result });
    }

    if (name === 'graphrag_batch_query_knowledge') {
      const queries = Array.isArray(args.queries) ? args.queries : [];
      if (queries.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Failed to batch query: `queries` must be a non-empty array.',
            },
          ],
        };
      }

      const items = batchQueryKnowledge({
        queries,
        top_k: args.top_k,
        file_ids: args.file_ids,
      });

      return textResponse({
        status: 'ok',
        action: 'batch_queried',
        query_count: queries.length,
        items,
      });
    }

    if (name === 'graphrag_ingest_uploaded_file') {
      try {
        const result = ingestUploadedFile({
          filename: args.filename,
          file_id: args.file_id,
          entity_id: args.entity_id,
        });
        return textResponse({ status: 'ok', action: 'ingested_uploaded_file', ...result });
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to ingest uploaded file: ${error.message}`,
            },
          ],
        };
      }
    }

    if (name === 'graphrag_list_uploaded_text_files') {
      const files = getUploadedTextFiles().map((f) => ({
        basename: f.basename,
        path: f.path,
        bytes: f.size,
      }));
      return textResponse({ status: 'ok', uploads_dir: UPLOADS_DIR, count: files.length, files });
    }

    if (name === 'graphrag_list_documents') {
      const documents = listDocuments();
      return textResponse({ status: 'ok', count: documents.length, documents });
    }

    if (name === 'graphrag_delete_documents') {
      const result = deleteDocuments(args.file_ids);
      return textResponse({ status: 'ok', action: 'deleted', ...result });
    }

    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[graphrag-mcp] Fatal error:', error);
  process.exit(1);
});
