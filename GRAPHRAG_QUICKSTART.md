# GraphRAG Integration - Quick Start

## 🎯 What Was Done

Your LibreChat SEMAA fork now has **hybrid dual-retrieval** enabled. When users search documents, results come from **both**:
1. **Vector RAG** (existing pgvector embeddings) - semantic similarity matching
2. **GraphRAG** (new knowledge graph service) - entity-relationship matching

Results are automatically **deduplicated** and **merged by relevance**.

## 🚀 Deploy It

```bash
# From your /Users/morrisdeng/Desktop/USC/Impact/SEMAA_Ardalan/LibreChat directory:

docker compose -f deploy-compose.yml -f docker-compose.semaa-local.yml up -d --build
```

Wait for services to start:
```bash
docker logs graphrag_api
# Look for: "GraphRAG server running on port 8001"
```

## ✅ Verify It Works

### 1. Upload a test document
- Open LibreChat UI
- Attach a PDF/text document to a file search tool
- Wait for upload to complete

### 2. Check both indexes were created
```bash
# Vector index
curl -H "Authorization: Bearer <JWT_TOKEN>" http://localhost:8000/documents
# Should show your file_id

# Graph index  
cat graphrag_data/store.json
# Should have entries like: {"files": {"abc123": {...}}}
```

### 3. Search and verify dual results
- In LibreChat, use file search tool
- Query something specific to your document
- You should see results appearing from both backends

## 📋 Environment Variables

Add to your `.env` file:

```env
# These are what LibreChat will look for:
GRAPH_RAG_API_URL=http://graphrag_api:8001
GRAPH_RAG_PORT=8001
GRAPH_RAG_STORE_DIR=/app/api/data/graphrag

# Optional tuning (defaults shown):
GRAPH_RAG_CHUNK_SIZE=1200
GRAPH_RAG_CHUNK_OVERLAP=160
```

If `GRAPH_RAG_API_URL` is not set, only vector RAG will run (graceful degradation).

## 📚 Files Changed

### Created:
- `api/graphrag/server.js` - The GraphRAG service (261 lines)
- `GRAPHRAG_INTEGRATION.md` - Full documentation

### Modified:
- `docker-compose.semaa-local.yml` - Added graphrag_api service + env vars
- `api/server/services/Files/VectorDB/crud.js` - Added GraphRAG sync hooks to upload/delete
- `api/app/clients/tools/util/fileSearch.js` - Multi-backend query aggregation

## 🔧 How It Works

```
When file uploads:
  1. Text extracted from file
  2. Sent to pgvector RAG_API for embedding → stored
  3. Sent to GraphRAG service → entities extracted → graph built → indexed

When user searches:
  1. Query sent to BOTH pgvector AND GraphRAG in parallel
  2. Results deduplicated by content hash (first 180 chars)
  3. Sorted by relevance score (lower = better)
  4. Top 10 returned to user

When file deleted:
  1. Deleted from pgvector RAG_API
  2. Deleted from GraphRAG service
```

## 📊 Scoring

- **Vector RAG:** Semantic embedding distance (0.0 = identical)
- **GraphRAG:** Multi-factor: token matching (40%) + entity matching (35%) + neighborhood spread (15%) + graph density (5%) + phrase match (5%)

Both converted to 0-1 distance scale for fair comparison.

## 🐛 Troubleshooting

**GraphRAG service won't start:**
```bash
docker logs graphrag_api
# Check for: missing directories, permission issues, port conflicts
```

**Searches returning only vector results:**
```bash
curl -X POST http://graphrag_api:8001/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"file_id":"test","query":"test","k":5}'
# If errors, GraphRAG may be down
```

**Store file corrupted:**
```bash
rm graphrag_data/store.json
# Re-upload files to rebuild (will happen automatically on next upload)
```

## 📖 Full Documentation

See `GRAPHRAG_INTEGRATION.md` for:
- Architecture diagrams
- API endpoint details
- Configuration options
- Production deployment
- Performance tuning
- Future enhancements

## 💡 Key Benefits

✅ **Better search results** - Combination of semantic + entity-based retrieval
✅ **Entity questions** - "Who are the main people mentioned?" works better
✅ **Structured knowledge** - Relationship extraction enables knowledge graphs
✅ **Non-invasive** - Doesn't modify existing vector RAG code
✅ **Resilient** - Works with or without GraphRAG backend
✅ **Scalable** - GraphRAG service scales independently

---

**Questions?** Check GRAPHRAG_INTEGRATION.md for detailed answers or see the inline code comments in:
- `api/graphrag/server.js` - Service implementation
- `api/server/services/Files/VectorDB/crud.js` - Sync hooks  
- `api/app/clients/tools/util/fileSearch.js` - Query aggregation
