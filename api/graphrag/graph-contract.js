const GRAPH_CONTRACT_NAME = 'semaa.graphrag.graph';
const GRAPH_CONTRACT_VERSION = '1.0.0';

const ALLOWED_NODE_TYPES = new Set(['document', 'chunk', 'entity']);

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeNode(node) {
  return {
    id: String(node.id),
    label: String(node.label),
    type: String(node.type),
    score: typeof node.score === 'number' ? node.score : null,
    source_docs: toArray(node.source_docs)
      .filter((docId) => isNonEmptyString(docId))
      .map((docId) => String(docId)),
    attributes: node.attributes && typeof node.attributes === 'object' ? node.attributes : {},
  };
}

function normalizeEdge(edge) {
  return {
    id: String(edge.id),
    source: String(edge.source),
    target: String(edge.target),
    relation: String(edge.relation),
    weight: typeof edge.weight === 'number' ? edge.weight : null,
    attributes: edge.attributes && typeof edge.attributes === 'object' ? edge.attributes : {},
  };
}

function createGraphPayload({ query, nodes = [], edges = [], filters = {}, meta = {} }) {
  const normalizedNodes = nodes.map(normalizeNode);
  const normalizedEdges = edges.map(normalizeEdge);

  return {
    contract: {
      name: GRAPH_CONTRACT_NAME,
      version: GRAPH_CONTRACT_VERSION,
    },
    query: isNonEmptyString(query) ? query : '',
    filters: {
      file_ids: toArray(filters.file_ids),
    },
    subgraph: {
      nodes: normalizedNodes,
      edges: normalizedEdges,
    },
    meta: {
      generated_at: Date.now(),
      node_count: normalizedNodes.length,
      edge_count: normalizedEdges.length,
      truncated: Boolean(meta.truncated),
      max_nodes: typeof meta.max_nodes === 'number' ? meta.max_nodes : null,
    },
  };
}

function validateGraphPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload must be an object.'] };
  }

  if (!isNonEmptyString(payload?.contract?.name)) {
    errors.push('contract.name is required.');
  }

  if (!isNonEmptyString(payload?.contract?.version)) {
    errors.push('contract.version is required.');
  }

  if (!Array.isArray(payload?.subgraph?.nodes)) {
    errors.push('subgraph.nodes must be an array.');
  }

  if (!Array.isArray(payload?.subgraph?.edges)) {
    errors.push('subgraph.edges must be an array.');
  }

  const nodeIds = new Set();
  for (const node of toArray(payload?.subgraph?.nodes)) {
    if (!isNonEmptyString(node.id)) {
      errors.push('node.id must be a non-empty string.');
      continue;
    }
    nodeIds.add(node.id);

    if (!isNonEmptyString(node.label)) {
      errors.push(`node.label is required for node ${node.id}.`);
    }

    if (!ALLOWED_NODE_TYPES.has(node.type)) {
      errors.push(`node.type must be one of document/chunk/entity for node ${node.id}.`);
    }
  }

  for (const edge of toArray(payload?.subgraph?.edges)) {
    if (!isNonEmptyString(edge.id)) {
      errors.push('edge.id must be a non-empty string.');
      continue;
    }

    if (!isNonEmptyString(edge.source) || !nodeIds.has(edge.source)) {
      errors.push(`edge.source must reference an existing node for edge ${edge.id}.`);
    }

    if (!isNonEmptyString(edge.target) || !nodeIds.has(edge.target)) {
      errors.push(`edge.target must reference an existing node for edge ${edge.id}.`);
    }

    if (!isNonEmptyString(edge.relation)) {
      errors.push(`edge.relation is required for edge ${edge.id}.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  GRAPH_CONTRACT_NAME,
  GRAPH_CONTRACT_VERSION,
  createGraphPayload,
  validateGraphPayload,
};