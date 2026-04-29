/**
 * Rebuild GraphRAG store using mcp-server.js node format (not server.js chunks format).
 * Run inside LibreChat-API container: docker exec -w /app LibreChat-API node /tmp/rebuild_mcp_store.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_DIR = process.env.GRAPH_RAG_STORE_DIR ?? path.join(process.cwd(), 'api', 'data', 'graphrag');
const STORE_FILE = path.join(STORE_DIR, 'store.json');
const CHUNK_SIZE = Number(process.env.GRAPH_RAG_CHUNK_SIZE ?? '1200');
const CHUNK_OVERLAP = Number(process.env.GRAPH_RAG_CHUNK_OVERLAP ?? '160');
const DOCS_DIR = path.join(process.cwd(), 'api', 'data', 'graphrag', 'source_docs');

const stopWords = new Set([
  'a','an','and','are','as','at','be','been','but','by','for','from','had','has',
  'have','he','her','hers','him','his','how','i','if','in','into','is','it','its',
  'of','on','or','our','ours','she','that','the','their','theirs','them','they','this',
  'to','was','we','were','what','when','where','which','who','why','with','you','your',
  'yours','can','could','would','should','will','may','might','than','then','there','here',
]);

function normalizeWhitespace(text) {
  return text.replace(/\r\n/g, '\n').replace(/\t/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function tokenize(text) {
  return Array.from(new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter(t => !stopWords.has(t))
  ));
}

function extractEntities(text) {
  const matches = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g) ?? [];
  return Array.from(new Set(matches.filter(m => m.length >= 3)));
}

function chunkText(text) {
  const chunks = [];
  const clean = normalizeWhitespace(text);
  if (!clean) return chunks;
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length);
    chunks.push(clean.slice(start, end));
    if (end >= clean.length) break;
    start = Math.max(0, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function buildGraphDocument({ file_id, filename, text, entity_id }) {
  const chunks = chunkText(text);
  const nodes = chunks.map((content, index) => ({
    id: `${file_id}::${index}`,
    index,
    content,
    tokens: tokenize(content),
    entities: extractEntities(content),
    edges: [
      ...(index > 0 ? [index - 1] : []),
      ...(index < chunks.length - 1 ? [index + 1] : []),
    ],
    hash: crypto.createHash('sha1').update(content).digest('hex'),
  }));

  return {
    file_id,
    filename,
    entity_id: entity_id ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chunkCount: nodes.length,
    nodes,
  };
}

const FILES = {
  'semaa-policy-001':   '01_marine_policy.txt',
  'semaa-incident-003': '02_incident_report.txt',
  'semaa-contract-088': '03_supplier_contract.txt',
  'semaa-portlog-014':  '04_port_maintenance_log.txt',
  'semaa-training-q1':  '05_crew_training_record.txt',
  'semaa-budget-h1':    '06_budget_and_procurement_plan.txt',
};

// Source docs path - try multiple locations
function findDocsDir() {
  const candidates = [
    '/tmp/graphrag-test',
    path.join(process.cwd(), 'docs', 'graphrag-test'),
    path.join(process.cwd(), 'api', 'data', 'graphrag', 'source_docs'),
  ];
  for (const d of candidates) {
    if (fs.existsSync(d)) return d;
  }
  throw new Error('Could not find docs directory. Tried: ' + candidates.join(', '));
}

function main() {
  const docsDir = findDocsDir();
  console.log('Source docs:', docsDir);
  console.log('Store file:', STORE_FILE);
  console.log('='.repeat(50));

  fs.mkdirSync(STORE_DIR, { recursive: true });

  // Backup existing store
  if (fs.existsSync(STORE_FILE)) {
    const bak = STORE_FILE + '.bak.' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T','_');
    fs.copyFileSync(STORE_FILE, bak);
    console.log('Backup:', path.basename(bak));
  }

  const store = { files: {} };

  for (const [file_id, filename] of Object.entries(FILES)) {
    const filepath = path.join(docsDir, filename);
    if (!fs.existsSync(filepath)) {
      console.log('SKIP ' + filename + ' - not found');
      continue;
    }
    const text = fs.readFileSync(filepath, 'utf8');
    const doc = buildGraphDocument({ file_id, filename, text });
    store.files[file_id] = doc;
    console.log(filename + ': chunks=' + doc.chunkCount + ', entities=' + doc.nodes.reduce((s,n) => s + n.entities.length, 0) + ' total entity refs');
  }

  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  console.log('='.repeat(50));
  console.log('Store written with', Object.keys(store.files).length, 'documents.');
}

main();
