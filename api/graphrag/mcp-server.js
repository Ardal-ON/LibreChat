const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { createGraphPayload, validateGraphPayload } = require('./graph-contract');

const STORE_DIR =
  process.env.GRAPH_RAG_STORE_DIR ?? path.join(process.cwd(), 'api', 'data', 'graphrag');
const STORE_FILE = path.join(STORE_DIR, 'store.json');
const CHUNK_SIZE = Number.parseInt(process.env.GRAPH_RAG_CHUNK_SIZE ?? '1200', 10);
const CHUNK_OVERLAP = Number.parseInt(process.env.GRAPH_RAG_CHUNK_OVERLAP ?? '160', 10);
const UPLOADS_DIR = process.env.GRAPHRAG_UPLOADS_DIR ?? '/app/uploads';
const MAX_INGEST_FILE_BYTES = Number.parseInt(process.env.GRAPHRAG_MAX_FILE_BYTES ?? '2097152', 10);
const DEFAULT_MAX_GRAPH_NODES = Number.parseInt(process.env.GRAPHRAG_MAX_GRAPH_NODES ?? '100', 10);
const MAX_RESULT_CONTENT_CHARS = Number.parseInt(process.env.GRAPHRAG_MAX_RESULT_CONTENT_CHARS ?? '420', 10);
const MAX_ENTITIES_PER_CHUNK = Number.parseInt(process.env.GRAPHRAG_MAX_ENTITIES_PER_CHUNK ?? '8', 10);
const GRAPH_RESULT_CACHE_LIMIT = Number.parseInt(process.env.GRAPHRAG_GRAPH_CACHE_LIMIT ?? '180', 10);

const graphResultCache = new Map();

function toSafePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function buildGraphId(seed) {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

function putGraphResultInCache(payload) {
  const baseSeed = `${Date.now()}:${Math.random()}:${JSON.stringify(payload.graph?.meta ?? {})}`;
  const graph_id = buildGraphId(baseSeed);

  graphResultCache.set(graph_id, {
    graph_id,
    payload,
    createdAt: Date.now(),
  });

  if (graphResultCache.size > GRAPH_RESULT_CACHE_LIMIT) {
    const oldestKey = graphResultCache.keys().next().value;
    if (oldestKey) {
      graphResultCache.delete(oldestKey);
    }
  }

  return graph_id;
}

function getGraphResultFromCache(graph_id) {
  if (typeof graph_id !== 'string' || graph_id.length === 0) {
    return null;
  }
  return graphResultCache.get(graph_id) ?? null;
}

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

function normalizeEntityKey(value) {
  return value.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function normalizeRelationLabel(value) {
  return value.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function parseExplicitRelations(text) {
  const lines = normalizeWhitespace(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const relations = [];
  for (const line of lines) {
    const relationLine = line.replace(/^RELATION:\s*/i, '');

    const matchDoubleArrow = relationLine.match(/^(.+?)\s*--\s*([a-zA-Z0-9_\- ]+?)\s*-->\s*(.+)$/);
    const matchTripleArrow = relationLine.match(/^(.+?)\s*->\s*([a-zA-Z0-9_\- ]+?)\s*->\s*(.+)$/);
    const match = matchDoubleArrow ?? matchTripleArrow;
    if (!match) {
      continue;
    }

    const sourceLabel = match[1].trim();
    const relationRaw = match[2].trim();
    const targetLabel = match[3].trim();
    if (!sourceLabel || !relationRaw || !targetLabel) {
      continue;
    }

    const sourceKey = normalizeEntityKey(sourceLabel);
    const targetKey = normalizeEntityKey(targetLabel);
    const relationKey = normalizeRelationLabel(relationRaw);
    if (!sourceKey || !targetKey || !relationKey) {
      continue;
    }

    relations.push({
      sourceLabel,
      sourceKey,
      relationLabel: relationKey,
      relationKey,
      targetLabel,
      targetKey,
    });
  }

  return relations;
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
    const explicitRelations = parseExplicitRelations(content);
    const relationEntities = explicitRelations.flatMap((relation) => [
      relation.sourceLabel,
      relation.targetLabel,
    ]);
    const entities = Array.from(new Set([...extractEntities(content), ...relationEntities]));
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
      explicitRelations,
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

function excerptContent(text, limit = MAX_RESULT_CONTENT_CHARS, anchorTerms = []) {
  if (typeof text !== 'string') {
    return '';
  }
  const clean = normalizeWhitespace(text);
  if (clean.length <= limit) {
    return clean;
  }

  const lower = clean.toLowerCase();
  const anchors = Array.isArray(anchorTerms)
    ? anchorTerms.filter((term) => typeof term === 'string' && term.length >= 3)
    : [];

  let anchorIndex = -1;
  for (const term of anchors) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0) {
      anchorIndex = idx;
      break;
    }
  }

  if (anchorIndex >= 0) {
    const start = Math.max(0, anchorIndex - Math.floor(limit * 0.35));
    const end = Math.min(clean.length, start + limit);
    const slice = clean.slice(start, end);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < clean.length ? '...' : '';
    return `${prefix}${slice}${suffix}`;
  }

  return `${clean.slice(0, limit)}...`;
}

function queryGraphDocument(doc, rawQuery, topK = 5, minScore = 0) {
  const queryTokens = tokenize(rawQuery);
  const queryEntities = extractEntities(rawQuery);
  const excerptAnchorTerms = [
    ...queryTokens,
    ...queryEntities.map((e) => e.toLowerCase()),
    'sla',
    'service levels',
    'standard delivery',
    'emergency delivery',
  ];

  const ranked = doc.nodes
    .map((node) => {
      const score = computeChunkScore(node, queryTokens, queryEntities, rawQuery);
      return { node, score };
    })
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return ranked.map(({ node, score }) => ({
    file_id: doc.file_id,
    filename: doc.filename,
    entity_id: doc.entity_id ?? null,
    chunk_index: node.index,
    score,
    distance: Number((1 - Math.min(score, 1)).toFixed(6)),
    content: excerptContent(node.content, MAX_RESULT_CONTENT_CHARS, excerptAnchorTerms),
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

function queryKnowledge({ query, top_k = 5, file_ids, min_score = 0, max_nodes = DEFAULT_MAX_GRAPH_NODES, auto_tune = true }) {
  const store = loadStore();
  const safeTopK = Math.min(12, Math.max(5, toSafePositiveInt(top_k, 5)));
  const safeMinScore = clampNumber(min_score, 0, 0, 1);
  const safeMaxNodes = toSafePositiveInt(max_nodes, DEFAULT_MAX_GRAPH_NODES);

  const candidates = Object.values(store.files).filter((doc) => {
    if (!Array.isArray(file_ids) || file_ids.length === 0) {
      return true;
    }
    return file_ids.includes(doc.file_id);
  });

  const rankResults = (topK, minScore) => {
    const all = candidates.flatMap((doc) => queryGraphDocument(doc, query, topK, minScore));
    const sorted = all.sort((a, b) => a.distance - b.distance);

    // Encourage cross-document coverage for chat answers when no explicit file filter is set.
    if ((!Array.isArray(file_ids) || file_ids.length === 0) && candidates.length > 1 && topK > 1) {
      const diversified = [];
      const seenDocs = new Set();

      for (const item of sorted) {
        if (!seenDocs.has(item.file_id)) {
          diversified.push(item);
          seenDocs.add(item.file_id);
        }
        if (diversified.length >= Math.min(2, topK)) {
          break;
        }
      }

      const selectedKeys = new Set(diversified.map((item) => `${item.file_id}::${item.chunk_index}`));
      for (const item of sorted) {
        const key = `${item.file_id}::${item.chunk_index}`;
        if (selectedKeys.has(key)) {
          continue;
        }
        diversified.push(item);
        selectedKeys.add(key);
        if (diversified.length >= topK) {
          break;
        }
      }

      return diversified.slice(0, topK);
    }

    return sorted.slice(0, topK);
  };

  let effectiveTopK = safeTopK;
  let effectiveMinScore = safeMinScore;
  let results = rankResults(effectiveTopK, effectiveMinScore);
  let autoTuned = false;

  // Simple adaptive fallback: if strict threshold returns nothing, relax once.
  if (auto_tune && results.length === 0 && effectiveMinScore > 0) {
    const relaxedMinScore = Number(Math.max(0, effectiveMinScore - 0.15).toFixed(3));
    if (relaxedMinScore < effectiveMinScore) {
      effectiveMinScore = relaxedMinScore;
      results = rankResults(effectiveTopK, effectiveMinScore);
      autoTuned = true;
    }

    if (results.length === 0 && effectiveTopK < 10) {
      effectiveTopK = 10;
      results = rankResults(effectiveTopK, effectiveMinScore);
      autoTuned = true;
    }
  }

  const graph = buildQuerySubgraph({
    store,
    query,
    file_ids,
    results,
    max_nodes: safeMaxNodes,
  });

  return {
    results,
    graph,
    controls: {
      top_k: effectiveTopK,
      min_score: effectiveMinScore,
      max_nodes: safeMaxNodes,
      auto_tuned: autoTuned,
    },
  };
}

function batchQueryKnowledge({ queries = [], top_k = 5, file_ids, min_score = 0, max_nodes = DEFAULT_MAX_GRAPH_NODES }) {
  return queries.map((query) => {
    const { results, graph, controls } = queryKnowledge({ query, top_k, file_ids, min_score, max_nodes, auto_tune: true });
    return {
      query,
      count: results.length,
      results,
      graph,
      controls,
    };
  });
}

function buildQuerySubgraph({ store, query, file_ids, results, max_nodes }) {
  const nodeMap = new Map();
  const edgeMap = new Map();
  let truncated = false;

  const addNode = (node) => {
    if (nodeMap.has(node.id)) {
      return true;
    }
    if (nodeMap.size >= max_nodes) {
      truncated = true;
      return false;
    }
    nodeMap.set(node.id, node);
    return true;
  };

  const addEdge = (edge) => {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) {
      return;
    }
    if (!edgeMap.has(edge.id)) {
      edgeMap.set(edge.id, edge);
    }
  };

  for (const result of results) {
    const docId = result.file_id;
    const doc = store.files[docId];
    if (!doc || !Array.isArray(doc.nodes)) {
      continue;
    }

    const chunkNode = doc.nodes.find((node) => node.index === result.chunk_index);
    if (!chunkNode) {
      continue;
    }

    const documentNodeId = `doc:${docId}`;
    const chunkNodeId = `chunk:${docId}::${chunkNode.index}`;

    addNode({
      id: documentNodeId,
      label: doc.filename,
      type: 'document',
      score: null,
      source_docs: [docId],
      attributes: {
        file_id: doc.file_id,
        filename: doc.filename,
      },
    });

    if (!addNode({
      id: chunkNodeId,
      label: `Chunk ${chunkNode.index}`,
      type: 'chunk',
      score: Number(result.score.toFixed(6)),
      source_docs: [docId],
      attributes: {
        file_id: doc.file_id,
        chunk_index: chunkNode.index,
      },
    })) {
      continue;
    }

    addEdge({
      id: `edge:contains:${documentNodeId}:${chunkNodeId}`,
      source: documentNodeId,
      target: chunkNodeId,
      relation: 'contains',
      weight: 1,
      attributes: {},
    });

    for (const entity of (chunkNode.entities ?? []).slice(0, MAX_ENTITIES_PER_CHUNK)) {
      const entityKey = normalizeEntityKey(entity);
      if (!entityKey) {
        continue;
      }
      const entityNodeId = `entity:${entityKey}`;

      if (!addNode({
        id: entityNodeId,
        label: entity,
        type: 'entity',
        score: Number(result.score.toFixed(6)),
        source_docs: [docId],
        attributes: {},
      })) {
        break;
      }

      addEdge({
        id: `edge:mentions:${chunkNodeId}:${entityNodeId}`,
        source: chunkNodeId,
        target: entityNodeId,
        relation: 'mentions',
        weight: 1,
        attributes: {},
      });
    }

    for (const relation of chunkNode.explicitRelations ?? []) {
      const sourceNodeId = `entity:${relation.sourceKey}`;
      const targetNodeId = `entity:${relation.targetKey}`;

      if (!addNode({
        id: sourceNodeId,
        label: relation.sourceLabel,
        type: 'entity',
        score: Number(result.score.toFixed(6)),
        source_docs: [docId],
        attributes: {},
      })) {
        continue;
      }

      if (!addNode({
        id: targetNodeId,
        label: relation.targetLabel,
        type: 'entity',
        score: Number(result.score.toFixed(6)),
        source_docs: [docId],
        attributes: {},
      })) {
        continue;
      }

      addEdge({
        id: `edge:rel:${chunkNodeId}:${relation.sourceKey}:${relation.relationKey}:${relation.targetKey}`,
        source: sourceNodeId,
        target: targetNodeId,
        relation: relation.relationLabel,
        weight: 1,
        attributes: {
          chunk_id: chunkNodeId,
        },
      });
    }

    for (const neighborIndex of chunkNode.edges ?? []) {
      const neighborNodeId = `chunk:${docId}::${neighborIndex}`;
      if (!nodeMap.has(neighborNodeId)) {
        continue;
      }
      const ordered = [chunkNodeId, neighborNodeId].sort();
      addEdge({
        id: `edge:adjacent:${ordered[0]}:${ordered[1]}`,
        source: ordered[0],
        target: ordered[1],
        relation: 'adjacent',
        weight: 1,
        attributes: {},
      });
    }
  }

  const payload = createGraphPayload({
    query,
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values()),
    filters: {
      file_ids,
    },
    meta: {
      truncated,
      max_nodes: max_nodes,
    },
  });

  const validation = validateGraphPayload(payload);
  return {
    ...payload,
    validation,
  };
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

function compactResultsForChat(results = []) {
  return results.map((item) => ({
    file_id: item.file_id,
    filename: item.filename,
    chunk_index: item.chunk_index,
    score: Number(item.score ?? 0),
    distance: Number(item.distance ?? 1),
    content: excerptContent(item.content, 260),
  }));
}

function compactGraphForChat(graph, maxNodes = 10, maxEdges = 14) {
  if (!graph || !graph.subgraph) {
    return graph;
  }

  const allNodes = Array.isArray(graph.subgraph.nodes) ? graph.subgraph.nodes : [];
  const allEdges = Array.isArray(graph.subgraph.edges) ? graph.subgraph.edges : [];

  const nodes = [];
  const selectedNodeIds = new Set();

  const addNodeById = (nodeId) => {
    if (nodes.length >= maxNodes || selectedNodeIds.has(nodeId)) {
      return;
    }
    const node = allNodes.find((n) => n.id === nodeId);
    if (!node) {
      return;
    }
    selectedNodeIds.add(nodeId);
    nodes.push(node);
  };

  const docNodes = allNodes.filter((node) => typeof node.id === 'string' && node.id.startsWith('doc:'));
  for (const docNode of docNodes) {
    addNodeById(docNode.id);
  }

  // Ensure each included document has at least one connected chunk when possible.
  for (const docNode of docNodes) {
    if (nodes.length >= maxNodes) {
      break;
    }
    const containsEdge = allEdges.find(
      (edge) => edge.source === docNode.id && edge.relation === 'contains' && edge.target,
    );
    if (containsEdge) {
      addNodeById(containsEdge.target);
    }
  }

  for (const node of allNodes) {
    if (nodes.length >= maxNodes) {
      break;
    }
    addNodeById(node.id);
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = allEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)).slice(0, maxEdges);

  return {
    ...graph,
    subgraph: {
      nodes,
      edges,
    },
    meta: {
      ...(graph.meta ?? {}),
      node_count: nodes.length,
      edge_count: edges.length,
      truncated: true,
      max_nodes: Math.min(maxNodes, graph.meta?.max_nodes ?? maxNodes),
    },
  };
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

function graphUiResourceResponse({ graphPayload, graph_id, summary }) {
  return {
    content: [
      {
        type: 'text',
        text: summary,
      },
      {
        type: 'resource',
        resource: {
          uri: `ui://graphrag/graph/${graph_id}`,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              ...graphPayload,
              graph_id,
            },
            null,
            2,
          ),
        },
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
    name: 'graphrag_query_with_graph',
    description:
      'Default GraphRAG query tool. Use this for normal user questions so the response includes graph UI data plus graph_id fallback. Only use graphrag_query_knowledge instead when the user explicitly wants text-only output or a compact non-graph response.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language question for retrieval.' },
        top_k: { type: 'number', description: 'Max number of retrieved snippets.', default: 5 },
        min_score: {
          type: 'number',
          description: 'Optional minimum relevance score in range [0, 1].',
          default: 0,
        },
        max_nodes: {
          type: 'number',
          description: 'Optional graph node cap for response payload.',
          default: 100,
        },
        include_results: {
          type: 'boolean',
          description: 'Whether to include textual retrieval snippets in response.',
          default: false,
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of file ids to constrain retrieval scope.',
        },
        auto_tune: {
          type: 'boolean',
          description: 'When true, automatically relax retrieval thresholds once if initial query returns no results.',
          default: true,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'graphrag_query_knowledge',
    description:
      'Text-only GraphRAG retrieval tool. Use this only when the user explicitly does not want a graph, or when you need a compact evidence/snippet response without graph UI attachments.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language question for retrieval.' },
        top_k: { type: 'number', description: 'Max number of retrieved snippets.', default: 5 },
        min_score: {
          type: 'number',
          description: 'Optional minimum relevance score in range [0, 1].',
          default: 0,
        },
        max_nodes: {
          type: 'number',
          description: 'Optional graph node cap for response payload.',
          default: 100,
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of file ids to constrain retrieval scope.',
        },
        auto_tune: {
          type: 'boolean',
          description: 'When true, automatically relax retrieval thresholds once if initial query returns no results.',
          default: true,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'graphrag_get_graph_by_id',
    description:
      'Fetch a previously generated GraphRAG graph payload by graph_id. Use this when ui_resources attachment is missing or failed to render.',
    inputSchema: {
      type: 'object',
      properties: {
        graph_id: {
          type: 'string',
          description: 'Server-issued graph id from graphrag_query_with_graph response.',
        },
      },
      required: ['graph_id'],
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
        top_k: { type: 'number', description: 'Max snippets returned per query.', default: 5 },
        min_score: {
          type: 'number',
          description: 'Optional minimum relevance score in range [0, 1].',
          default: 0,
        },
        max_nodes: {
          type: 'number',
          description: 'Optional graph node cap for each query payload.',
          default: 100,
        },
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
      const { results, graph, controls } = queryKnowledge({
        query: args.query,
        top_k: args.top_k,
        min_score: args.min_score,
        // Keep chat tool output compact so JSON stays parseable in message tool panels.
        max_nodes: Math.min(toSafePositiveInt(args.max_nodes, 40), 40),
        file_ids: args.file_ids,
        auto_tune: args.auto_tune !== false,
      });

      const compactResults = compactResultsForChat(results);
      const compactGraph = compactGraphForChat(graph);

      return textResponse({
        status: 'ok',
        action: 'queried',
        count: compactResults.length,
        controls,
        results: compactResults,
        graph: compactGraph,
      });
    }

    if (name === 'graphrag_query_with_graph') {
      const includeResults = Boolean(args.include_results);
      const { results, graph, controls } = queryKnowledge({
        query: args.query,
        top_k: args.top_k,
        min_score: args.min_score,
        max_nodes: args.max_nodes,
        file_ids: args.file_ids,
        auto_tune: args.auto_tune !== false,
      });

      const fullGraphPayload = {
        status: 'ok',
        action: 'queried_with_graph',
        count: results.length,
        controls,
        graph,
        ...(includeResults ? { results } : {}),
      };

      const graph_id = putGraphResultInCache(fullGraphPayload);
      const summary = [
        'Graph generated and attached via ui_resources.',
        `graph_id: ${graph_id}`,
        `result_count: ${results.length}`,
        `node_count: ${Array.isArray(graph?.subgraph?.nodes) ? graph.subgraph.nodes.length : 0}`,
        `edge_count: ${Array.isArray(graph?.subgraph?.edges) ? graph.subgraph.edges.length : 0}`,
        'If attachment rendering fails, call graphrag_get_graph_by_id with this graph_id.',
      ].join('\n');

      return graphUiResourceResponse({
        graphPayload: fullGraphPayload,
        graph_id,
        summary,
      });
    }

    if (name === 'graphrag_get_graph_by_id') {
      const graphRecord = getGraphResultFromCache(args.graph_id);
      if (!graphRecord) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `No graph payload found for graph_id: ${args.graph_id}`,
            },
          ],
        };
      }

      const ageSeconds = Math.max(0, Math.floor((Date.now() - graphRecord.createdAt) / 1000));
      return graphUiResourceResponse({
        graphPayload: graphRecord.payload,
        graph_id: graphRecord.graph_id,
        summary: [
          'Graph payload restored from server cache via graph_id.',
          `graph_id: ${graphRecord.graph_id}`,
          `cache_age_seconds: ${ageSeconds}`,
        ].join('\n'),
      });
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
        min_score: args.min_score,
        max_nodes: args.max_nodes,
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
