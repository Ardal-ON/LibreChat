const fs = require('fs');
const crypto = require('crypto');

const STORE_FILE = '/app/api/data/graphrag/store.json';
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 160;

const stopWords = new Set([
  'a','an','and','are','as','at','be','been','but','by','for','from','had','has',
  'have','he','her','hers','him','his','how','i','if','in','into','is','it','its',
  'of','on','or','our','ours','she','that','the','their','theirs','them','they','this',
  'to','was','we','were','what','when','where','which','who','why','with','you','your',
  'yours','can','could','would','should','will','may','might','than','then','there','here',
]);

function normalizeWhitespace(t) {
  return t.replace(/\r\n/g, '\n').replace(/\t/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function tokenize(t) {
  return Array.from(new Set((t.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter(x => !stopWords.has(x))));
}
function extractEntities(t) {
  const m = t.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g) ?? [];
  return Array.from(new Set(m.filter(x => x.length >= 3)));
}
function chunkText(t) {
  const chunks = [];
  const clean = normalizeWhitespace(t);
  if (!clean) return chunks;
  let s = 0;
  while (s < clean.length) {
    const e = Math.min(s + CHUNK_SIZE, clean.length);
    chunks.push(clean.slice(s, e));
    if (e >= clean.length) break;
    s = Math.max(0, e - CHUNK_OVERLAP);
  }
  return chunks;
}

const file_id = 'semaa-checklist-v1';
const filename = '07_vessel_inspection_checklist.txt';
const text = fs.readFileSync('/tmp/07_vessel_inspection_checklist.txt', 'utf8');
const chunks = chunkText(text);

const nodes = chunks.map((content, index) => ({
  id: file_id + '::' + index,
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

const doc = {
  file_id,
  filename,
  entity_id: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  chunkCount: nodes.length,
  nodes,
};

const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
store.files[file_id] = doc;
fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));

console.log('Added: ' + filename);
console.log('chunks=' + nodes.length + ', entities=' + nodes.reduce((s, n) => s + n.entities.length, 0) + ' total refs');
console.log('Total docs in store: ' + Object.keys(store.files).length);
