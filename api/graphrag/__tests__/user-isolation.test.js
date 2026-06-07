const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadStore,
  saveStore,
  requireUserId,
  stripUserId,
  docOwnedByUser,
  LC_USER_ID_KEY,
} = require('../userStore');

const {
  ingestDocument,
  listDocuments,
  deleteDocuments,
  queryKnowledge,
  putGraphResultInCache,
  getGraphResultFromCache,
} = require('../mcp-server');

describe('GraphRAG user isolation', () => {
  let tempStoreDir;

  beforeEach(() => {
    tempStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphrag-user-isolation-'));
    process.env.GRAPH_RAG_STORE_DIR = tempStoreDir;
  });

  afterEach(() => {
    delete process.env.GRAPH_RAG_STORE_DIR;
    fs.rmSync(tempStoreDir, { recursive: true, force: true });
  });

  it('requires authenticated user context for MCP tool args', () => {
    expect(() => requireUserId({})).toThrow(/missing authenticated user context/i);
    expect(requireUserId({ [LC_USER_ID_KEY]: 'user-a' })).toBe('user-a');
    expect(stripUserId({ [LC_USER_ID_KEY]: 'user-a', query: 'test' })).toEqual({ query: 'test' });
  });

  it('keeps per-user stores isolated for ingest, list, query, and delete', () => {
    ingestDocument({
      user_id: 'user-a',
      file_id: 'doc-a',
      filename: 'alpha.md',
      text: 'Alpha marine policy covers emergency delivery and standard delivery windows.',
    });
    ingestDocument({
      user_id: 'user-b',
      file_id: 'doc-b',
      filename: 'beta.md',
      text: 'Beta supplier contract defines payment terms and liability limits.',
    });

    expect(listDocuments('user-a').map((doc) => doc.file_id)).toEqual(['doc-a']);
    expect(listDocuments('user-b').map((doc) => doc.file_id)).toEqual(['doc-b']);

    const userAQuery = queryKnowledge({
      user_id: 'user-a',
      query: 'emergency delivery',
      top_k: 5,
      min_score: 0,
    });
    expect(userAQuery.results.every((item) => item.file_id === 'doc-a')).toBe(true);

    const userBQuery = queryKnowledge({
      user_id: 'user-b',
      query: 'payment terms',
      top_k: 5,
      min_score: 0,
    });
    expect(userBQuery.results.every((item) => item.file_id === 'doc-b')).toBe(true);

    const deleteResult = deleteDocuments(['doc-b'], 'user-a');
    expect(deleteResult.deleted).toBe(0);
    expect(listDocuments('user-b').map((doc) => doc.file_id)).toEqual(['doc-b']);

    const ownedDelete = deleteDocuments(['doc-a'], 'user-a');
    expect(ownedDelete.deleted).toBe(1);
    expect(listDocuments('user-a')).toEqual([]);
  });

  it('scopes graph cache entries by user', () => {
    const payloadA = { graph: { meta: { query: 'alpha' } }, results: [] };
    const payloadB = { graph: { meta: { query: 'beta' } }, results: [] };

    const graphIdA = putGraphResultInCache('user-a', payloadA);
    const graphIdB = putGraphResultInCache('user-b', payloadB);

    expect(getGraphResultFromCache('user-a', graphIdA)?.payload).toEqual(payloadA);
    expect(getGraphResultFromCache('user-b', graphIdB)?.payload).toEqual(payloadB);
    expect(getGraphResultFromCache('user-a', graphIdB)).toBeNull();
    expect(getGraphResultFromCache('user-b', graphIdA)).toBeNull();
  });

  it('persists user_id on stored documents', () => {
    ingestDocument({
      user_id: 'user-a',
      file_id: 'doc-owned',
      filename: 'owned.md',
      text: 'Owned document content for user A.',
    });

    const store = loadStore('user-a');
    const storedDoc = store.files['doc-owned'];
    expect(docOwnedByUser(storedDoc, 'user-a')).toBe(true);
    expect(docOwnedByUser(storedDoc, 'user-b')).toBe(false);
    expect(storedDoc.user_id).toBe('user-a');
  });

  it('writes separate store files per user on disk', () => {
    saveStore('user-a', { files: { 'doc-a': { file_id: 'doc-a', user_id: 'user-a' } } });
    saveStore('user-b', { files: { 'doc-b': { file_id: 'doc-b', user_id: 'user-b' } } });

    const userAStorePath = path.join(tempStoreDir, 'users', 'user-a', 'store.json');
    const userBStorePath = path.join(tempStoreDir, 'users', 'user-b', 'store.json');

    expect(fs.existsSync(userAStorePath)).toBe(true);
    expect(fs.existsSync(userBStorePath)).toBe(true);
    expect(loadStore('user-a').files['doc-a']).toBeDefined();
    expect(loadStore('user-b').files['doc-b']).toBeDefined();
    expect(loadStore('user-a').files['doc-b']).toBeUndefined();
  });
});
