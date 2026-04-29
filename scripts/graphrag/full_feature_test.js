#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const BASE_URL = process.env.LIBRECHAT_BASE_URL || 'http://localhost:3080';
const SERVER_NAME = process.env.GRAPHRAG_SERVER_NAME || 'graphrag';
const API_CONTAINER = process.env.LIBRECHAT_API_CONTAINER || 'LibreChat-API';
const TOP_K = Number(process.env.GRAPHRAG_TEST_TOP_K || '8');
const MAX_NODES = Number(process.env.GRAPHRAG_TEST_MAX_NODES || '80');

const SEED_DOCS = [
  '01_marine_policy.txt',
  '02_incident_report.txt',
  '03_supplier_contract.txt',
  '04_port_maintenance_log.txt',
  '05_crew_training_record.txt',
  '06_budget_and_procurement_plan.txt',
  '07_vessel_inspection_checklist.txt',
  '08_emergency_response_protocol.txt',
];

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toSafeId(filename) {
  return `test-${filename.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-')}`;
}

function parseToolResult(payload) {
  const fromContentArray = payload?.result?.content?.[0]?.text;
  const fromKwargs = payload?.result?.kwargs?.content;
  const text = typeof fromContentArray === 'string' ? fromContentArray : fromKwargs;

  if (typeof text !== 'string') {
    return payload?.result ?? payload;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return { rawText: text };
  }
}

async function callTool(toolName, args = {}) {
  const url = `${BASE_URL}/api/mcp/${SERVER_NAME}/tools/${toolName}/call`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_error) {
    throw new Error(`${toolName} returned non-JSON response (${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok || json.error) {
    throw new Error(`${toolName} failed (${res.status}): ${text.slice(0, 500)}`);
  }

  return parseToolResult(json);
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function seedUploadsFromWorkspaceDocs() {
  const docsDir = path.join(process.cwd(), 'docs', 'graphrag-test');
  if (!fs.existsSync(docsDir)) {
    return { seeded: false, reason: `Missing docs directory: ${docsDir}` };
  }

  try {
    execFileSync('docker', ['exec', API_CONTAINER, 'sh', '-lc', 'mkdir -p /app/uploads/graphrag-seed'], {
      stdio: 'ignore',
    });
    execFileSync('docker', ['cp', `${docsDir}/.`, `${API_CONTAINER}:/app/uploads/graphrag-seed/`], {
      stdio: 'ignore',
    });
    return { seeded: true, reason: 'Copied docs/graphrag-test into container uploads' };
  } catch (error) {
    return { seeded: false, reason: `Failed docker copy into ${API_CONTAINER}: ${error.message}` };
  }
}

function buildVisGraphHtml(title, graphPayload) {
  const subgraph = graphPayload?.graph?.subgraph ?? graphPayload?.subgraph ?? { nodes: [], edges: [] };
  const nodes = Array.isArray(subgraph.nodes) ? subgraph.nodes : [];
  const edges = Array.isArray(subgraph.edges) ? subgraph.edges : [];

  const visNodes = nodes.map((n) => {
    const type = n.type || 'node';
    const colorByType = {
      document: '#4f8ef7',
      chunk: '#d16ba5',
      entity: '#f6b73c',
      node: '#8f9aa3',
    };

    return {
      id: n.id,
      label: n.label || n.id,
      title: JSON.stringify(n, null, 2),
      color: colorByType[type] || '#8f9aa3',
      shape: type === 'entity' ? 'dot' : 'ellipse',
      font: { color: '#f3f3f3' },
    };
  });

  const visEdges = edges.map((e) => ({
    from: e.source,
    to: e.target,
    label: e.relation || '',
    arrows: 'to',
    color: '#7f8c8d',
    font: { align: 'middle', color: '#d0d0d0', size: 11 },
  }));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <script src="https://unpkg.com/vis-network@9.1.9/dist/vis-network.min.js"></script>
  <style>
    body { margin: 0; background: #11151c; color: #e8e8e8; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }
    .wrap { padding: 12px; }
    h1 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 0 0 12px; color: #a8b0b8; }
    #graph { width: 100%; height: 78vh; border: 1px solid #2a3138; border-radius: 8px; background: #0f1318; }
    .meta { margin-top: 10px; font-size: 12px; color: #9aa4ad; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${title}</h1>
    <p>GraphRAG query visualization</p>
    <div id="graph"></div>
    <div class="meta">nodes: ${visNodes.length} | edges: ${visEdges.length}</div>
  </div>
  <script>
    const nodes = new vis.DataSet(${JSON.stringify(visNodes)});
    const edges = new vis.DataSet(${JSON.stringify(visEdges)});
    const container = document.getElementById('graph');
    const data = { nodes, edges };
    const options = {
      physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -45 } },
      interaction: { hover: true, navigationButtons: true, keyboard: true },
      edges: { smooth: true },
    };
    new vis.Network(container, data, options);
  </script>
</body>
</html>
`;
}

async function main() {
  const outputDir = path.join(process.cwd(), 'scripts', 'graphrag', 'test-output', nowStamp());
  ensureDir(outputDir);

  console.log('GraphRAG Full Feature Test');
  console.log('Output:', outputDir);
  console.log('Base URL:', BASE_URL);
  console.log('Server:', SERVER_NAME);
  console.log('');

  const summary = [];

  let uploaded = await callTool('graphrag_list_uploaded_text_files');
  writeJson(path.join(outputDir, '01_uploaded_files.json'), uploaded);
  let uploadedFiles = (uploaded.files || []).map((f) => f.basename).filter(Boolean);
  console.log(`1) Uploaded files: ${uploaded.count || 0}`);
  if (!uploadedFiles.length) {
    const seed = seedUploadsFromWorkspaceDocs();
    writeJson(path.join(outputDir, '01a_upload_seed_result.json'), seed);

    uploaded = await callTool('graphrag_list_uploaded_text_files');
    writeJson(path.join(outputDir, '01b_uploaded_files_after_seed.json'), uploaded);
    uploadedFiles = (uploaded.files || []).map((f) => f.basename).filter(Boolean);
    console.log(`1b) Uploaded files after auto-seed: ${uploaded.count || 0}`);

    if (!uploadedFiles.length) {
      throw new Error('No uploaded .md/.txt files found, and auto-seed did not populate uploads.');
    }
  }
  summary.push(`Uploaded files: ${uploaded.count || 0}`);

  const beforeDocs = await callTool('graphrag_list_documents');
  writeJson(path.join(outputDir, '02_documents_before_clear.json'), beforeDocs);

  const oldIds = (beforeDocs.documents || []).map((d) => d.file_id).filter(Boolean);
  if (oldIds.length) {
    const cleared = await callTool('graphrag_delete_documents', { file_ids: oldIds });
    writeJson(path.join(outputDir, '03_clear_store.json'), cleared);
    console.log(`2) Cleared existing KB docs: ${oldIds.length}`);
  } else {
    writeJson(path.join(outputDir, '03_clear_store.json'), { status: 'ok', action: 'skipped', reason: 'No existing docs' });
    console.log('2) Cleared existing KB docs: 0 (already empty)');
  }

  const seedTargets = SEED_DOCS.filter((name) => uploadedFiles.includes(name));
  if (!seedTargets.length) {
    throw new Error(`None of seed docs were found in uploads. Expected one of: ${SEED_DOCS.join(', ')}`);
  }

  const ingestResults = [];
  for (const filename of seedTargets) {
    const file_id = toSafeId(filename);
    const result = await callTool('graphrag_ingest_uploaded_file', { filename, file_id });
    ingestResults.push(result);
  }
  writeJson(path.join(outputDir, '04_ingest_results.json'), ingestResults);
  console.log(`3) Ingested docs into KB: ${ingestResults.length}`);
  summary.push(`Ingested docs: ${ingestResults.length}`);

  const docsAfter = await callTool('graphrag_list_documents');
  writeJson(path.join(outputDir, '05_documents_after_ingest.json'), docsAfter);
  console.log(`4) KB documents after ingest: ${docsAfter.count || 0}`);
  summary.push(`KB documents now: ${docsAfter.count || 0}`);

  const describeKB = await callTool('graphrag_query_knowledge', {
    query: 'List the major policy, contract, budget, training, and emergency topics covered by the current knowledge base.',
    top_k: TOP_K,
    min_score: 0,
    max_nodes: 40,
  });
  writeJson(path.join(outputDir, '06_query_kb_scope.json'), describeKB);
  console.log(`5) KB scope query hits: ${describeKB.count || 0}`);

  const singleFileName = seedTargets.find((f) => f === '03_supplier_contract.txt') || seedTargets[0];
  const singleFileId = toSafeId(singleFileName);
  const singleGraph = await callTool('graphrag_query_with_graph', {
    query: 'What are the supplier obligations, delivery timelines, and penalties in this document?',
    file_ids: [singleFileId],
    top_k: TOP_K,
    min_score: 0,
    max_nodes: MAX_NODES,
    include_results: true,
  });
  writeJson(path.join(outputDir, '07_single_file_query_with_graph.json'), singleGraph);
  const singleHtml = buildVisGraphHtml('Single File Graph Query', singleGraph);
  fs.writeFileSync(path.join(outputDir, '07_single_file_graph.html'), singleHtml);
  console.log(`6) Single-file query hits: ${singleGraph.count || 0}`);

  const crossGraph = await callTool('graphrag_query_with_graph', {
    query:
      'Combine supplier contract, procurement budget, and emergency response constraints to propose an emergency procurement SLA fallback plan with risks and mitigations.',
    top_k: TOP_K,
    min_score: 0,
    max_nodes: MAX_NODES,
    include_results: true,
  });
  writeJson(path.join(outputDir, '08_cross_file_query_with_graph.json'), crossGraph);
  const crossHtml = buildVisGraphHtml('Cross File Graph Query', crossGraph);
  fs.writeFileSync(path.join(outputDir, '08_cross_file_graph.html'), crossHtml);
  console.log(`7) Cross-file query hits: ${crossGraph.count || 0}`);

  const report = [
    '# GraphRAG Full Feature Test Report',
    '',
    ...summary.map((line) => `- ${line}`),
    `- Single-file graph html: 07_single_file_graph.html`,
    `- Cross-file graph html: 08_cross_file_graph.html`,
    '',
    '## Test Coverage',
    '- GraphRAG database clear',
    '- Uploaded file input detection',
    '- Knowledge base build (ingest uploaded files)',
    '- Query to inspect what KB contains',
    '- Single-file question with graph payload + graph HTML output',
    '- Cross-file question with graph payload + graph HTML output',
    '',
    '## Next',
    '- Open graph HTML files in browser to verify graph rendering.',
  ].join('\n');

  fs.writeFileSync(path.join(outputDir, 'REPORT.md'), `${report}\n`);

  console.log('');
  console.log('Done.');
  console.log(`Report: ${path.join(outputDir, 'REPORT.md')}`);
  console.log(`Single-file graph: ${path.join(outputDir, '07_single_file_graph.html')}`);
  console.log(`Cross-file graph: ${path.join(outputDir, '08_cross_file_graph.html')}`);
}

main().catch((error) => {
  console.error('Test failed:', error.message);
  process.exit(1);
});
