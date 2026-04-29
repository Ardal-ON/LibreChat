const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const token = jwt.sign({ sub: 'rebuild' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const docsDir = '/tmp/graphrag-test';
const PORT = Number(process.env.GRAPH_RAG_PORT || 8001);

const files = {
  'semaa-policy-001': '01_marine_policy.txt',
  'semaa-incident-003': '02_incident_report.txt',
  'semaa-contract-088': '03_supplier_contract.txt',
  'semaa-portlog-014': '04_port_maintenance_log.txt',
  'semaa-training-q1': '05_crew_training_record.txt',
  'semaa-budget-h1': '06_budget_and_procurement_plan.txt',
};

function ingest(file_id, filename, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ file_id, filename, text });
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path: '/ingest-text',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('GraphRAG Store Rebuild');
  console.log('='.repeat(40));
  for (const [file_id, filename] of Object.entries(files)) {
    const filepath = path.join(docsDir, filename);
    if (!fs.existsSync(filepath)) {
      console.log('SKIP ' + filename + ' — not found');
      continue;
    }
    const text = fs.readFileSync(filepath, 'utf8');
    const r = await ingest(file_id, filename, text);
    console.log(filename + ': chunks=' + r.chunk_count + ', entities=' + r.entity_count + ', ok=' + r.status);
  }
  console.log('='.repeat(40));
  console.log('Done.');
})();
