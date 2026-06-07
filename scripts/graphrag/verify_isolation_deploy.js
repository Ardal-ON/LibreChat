#!/usr/bin/env node

const jwt = require('jsonwebtoken');
const http = require('http');

const BASE_HOST = process.env.VERIFY_HOST || '127.0.0.1';
const BASE_PORT = Number.parseInt(process.env.VERIFY_PORT || '3080', 10);
const SERVER_NAME = process.env.GRAPHRAG_SERVER_NAME || 'graphrag-local';
const secret = process.env.JWT_SECRET;

if (!secret) {
  console.error('JWT_SECRET is required');
  process.exit(1);
}

const userA = process.env.VERIFY_USER_A || '69deee4859785cdf050ef23a';
const userB = process.env.VERIFY_USER_B || 'graphrag-isolation-test-user-b';

function tokenFor(userId) {
  return jwt.sign({ id: userId }, secret, { expiresIn: '5m', algorithm: 'HS256' });
}

function callMcp(userId, toolName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: BASE_HOST,
        port: BASE_PORT,
        path: `/api/mcp/${SERVER_NAME}/tools/${toolName}/call`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenFor(userId)}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, raw: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseTool(response) {
  if (response.status !== 200) {
    return { error: `HTTP ${response.status}`, body: response.json ?? response.raw };
  }
  const text = response.json?.result?.content?.[0]?.text ?? response.json?.result?.kwargs?.content;
  if (typeof text !== 'string') {
    return response.json ?? { error: 'unexpected response shape' };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

async function main() {
  const ingestA = parseTool(
    await callMcp(userA, 'graphrag_ingest_document', {
      file_id: 'isolation-test-a',
      filename: 'isolation-a.md',
      text: 'User A confidential marine policy emergency delivery procedures for isolation testing.',
    }),
  );
  const ingestB = parseTool(
    await callMcp(userB, 'graphrag_ingest_document', {
      file_id: 'isolation-test-b',
      filename: 'isolation-b.md',
      text: 'User B private supplier contract payment terms for isolation testing.',
    }),
  );

  const listA = parseTool(await callMcp(userA, 'graphrag_list_documents', {}));
  const listB = parseTool(await callMcp(userB, 'graphrag_list_documents', {}));
  const idsA = (listA.documents || []).map((doc) => doc.file_id);
  const idsB = (listB.documents || []).map((doc) => doc.file_id);

  const crossDelete = parseTool(
    await callMcp(userA, 'graphrag_delete_documents', { file_ids: ['isolation-test-b'] }),
  );

  const queryA = parseTool(
    await callMcp(userA, 'graphrag_query_with_graph', {
      query: 'emergency delivery',
      top_k: 5,
      min_score: 0,
    }),
  );
  const queryB = parseTool(
    await callMcp(userB, 'graphrag_query_with_graph', {
      query: 'payment terms',
      top_k: 5,
      min_score: 0,
    }),
  );

  const leakA = (queryA.results || []).some((item) => item.file_id === 'isolation-test-b');
  const leakB = (queryB.results || []).some((item) => item.file_id === 'isolation-test-a');

  await callMcp(userA, 'graphrag_delete_documents', { file_ids: ['isolation-test-a'] });
  await callMcp(userB, 'graphrag_delete_documents', { file_ids: ['isolation-test-b'] });

  const ok =
    ingestA.status === 'ok' &&
    ingestB.status === 'ok' &&
    idsA.includes('isolation-test-a') &&
    !idsA.includes('isolation-test-b') &&
    idsB.includes('isolation-test-b') &&
    !idsB.includes('isolation-test-a') &&
    crossDelete.deleted === 0 &&
    !leakA &&
    !leakB;

  console.log(
    JSON.stringify(
      {
        ingestA: ingestA.status,
        ingestB: ingestB.status,
        idsA,
        idsB,
        crossDelete,
        queryA_count: queryA.count,
        queryB_count: queryB.count,
        cross_query_leak: leakA || leakB,
        ok,
      },
      null,
      2,
    ),
  );

  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
