# GraphRAG Integration Guide for SEMAA

## Overview

This document describes the hybrid dual-retrieval system added to LibreChat for the SEMAA project. The system combines **vector-based semantic search** (existing pgvector RAG) with **graph-based knowledge retrieval** (new GraphRAG service) to provide enhanced document search capabilities.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      User Query                              │
└────────────────────────┬────────────────────────────────────┘
                         │
                    fileSearch.js
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
   [Vector RAG]   [GraphRAG Service]  [Result Dedup]
   (pgvector)     (Entity-based)       (170+ chars)
        │                │                │
        └────────────────┼────────────────┘
                         │
            ┌────────────▼────────────┐
            │   Sorted Results (0-10) │
            │  + Retrieval Source     │
            └────────────────────────┘
```

## Components

### 1. GraphRAG Service (`api/graphrag/server.js`)

**Purpose:** Standalone Express.js HTTP service providing graph-based document indexing and retrieval.

**Configuration:**
- Port: `GRAPH_RAG_PORT` (default: 8001)
- Store Directory: `GRAPH_RAG_STORE_DIR` (default: `api/data/graphrag`)
- Chunk Size: `GRAPH_RAG_CHUNK_SIZE` (default: 1200 chars)
- Chunk Overlap: `GRAPH_RAG_CHUNK_OVERLAP` (default: 160 chars)

**Endpoints:**

1. **POST `/ingest-text`** - Index document text
   ```json
   {
     "file_id": "abc123",
     "filename": "document.pdf",
     "text": "Document content...",
     "entity_id": "optional"
   }
   ```
   Returns: `{ success: true, file_id: "abc123", chunks: N }`

2. **POST `/query`** - Search indexed documents
   ```json
   {
     "file_id": "abc123",
     "query": "What is the main topic?",
     "k": 5
   }
   ```
   Returns: `[[{page_content, metadata}, distance], ...]`

3. **DELETE `/documents`** - Remove indexed files
   ```json
   ["file_id_1", "file_id_2"]
   ```

**Scoring Algorithm:**
- Token Matching: 40% weight (query tokens matched in chunk)
- Entity Matching: 35% weight (named entities from query found in chunk)
- Neighborhood Spread: 15% weight (entity co-occurrence in adjacent chunks)
- Graph Density: 5% weight (richness of entity relationships)
- Exact Phrase Match: 5% penalty/bonus

### 2. VectorDB Lifecycle Hooks (`api/server/services/Files/VectorDB/crud.js`)

**Purpose:** Synchronize file uploads/deletes to both vector and graph stores.

**Functions Added:**

1. **`deleteGraphDocuments(jwtToken, fileId)`** - Remove file from GraphRAG
   - Called from `deleteVectors()` after pgvector deletion
   - Makes DELETE request to `/documents` endpoint

2. **`extractTextForGraph({ jwtToken, req, file })`** - Extract plain text from file
   - Reuses `RAG_API_URL/text` endpoint to get text content
   - Avoids duplicating file format handling (PDF, DOCX, etc.)

3. **`syncGraphRAGDocument({ jwtToken, file, file_id, entity_id })`** - Ingest file into GraphRAG
   - Called from `uploadVectors()` after pgvector embedding
   - Extracts text and POSTs to `/ingest-text` endpoint

### 3. Multi-Backend Query Aggregation (`api/app/clients/tools/util/fileSearch.js`)

**Purpose:** Query both RAG backends in parallel, deduplicate results, merge by relevance.

**Key Changes:**

1. **Backend Detection:**
   ```javascript
   backends = [
     { label: 'vector', url: process.env.RAG_API_URL },
     { label: 'graphrag', url: process.env.GRAPH_RAG_API_URL }
   ]
   ```
   Both optional; graceful degradation if only one configured.

2. **Parallel Querying:**
   - Each file queried against each backend
   - Promises: `files.length × backends.length`
   - All resolve in parallel with `Promise.all()`

3. **Deduplication:**
   - Key: `file_id::first_180_chars_of_content`
   - Keep result with lower (better) distance score
   - Tracks `retrieval: "vector"` or `"graphrag"`

4. **Result Merging:**
   - All results sorted by distance (ascending)
   - Top 10 returned to user
   - Source attribution preserved

### 4. Docker Compose Override (`docker-compose.semaa-local.yml`)

**Purpose:** Configure GraphRAG service for local SEMAA testing.

**Service Definition:**
```yaml
graphrag_api:
  image: librechat-semaa-api:local
  container_name: graphrag_api
  command: node /app/api/graphrag/server.js
  restart: always
  environment:
    - GRAPH_RAG_PORT=8001
    - GRAPH_RAG_STORE_DIR=/app/api/data/graphrag
    - JWT_SECRET=${JWT_SECRET}
  volumes:
    - ./graphrag_data:/app/api/data/graphrag
```

**API Service Enhancement:**
```yaml
environment:
  - GRAPH_RAG_API_URL=http://graphrag_api:8001
```

## Deployment

### Local Testing (SEMAA Environment)

```bash
# Build and start with GraphRAG
docker compose -f deploy-compose.yml -f docker-compose.semaa-local.yml up -d --build

# Verify services
docker ps | grep -E 'graphrag_api|api_1'

# Check GraphRAG logs
docker logs graphrag_api

# Check store directory
ls -la graphrag_data/
```

### Environment Variables

Set these in your `.env` file:

```env
# Required for Vector RAG (existing)
RAG_API_URL=http://rag_api:8000

# New for GraphRAG
GRAPH_RAG_API_URL=http://graphrag_api:8001
GRAPH_RAG_PORT=8001
GRAPH_RAG_STORE_DIR=/app/api/data/graphrag
GRAPH_RAG_CHUNK_SIZE=1200
GRAPH_RAG_CHUNK_OVERLAP=160
```

### Production Considerations

1. **Persistence:** GraphRAG store (`store.json`) persists via Docker volumes
2. **Authentication:** Both backends use same JWT tokens for file ownership verification
3. **Fallback:** If GraphRAG unavailable, system gracefully falls back to vector-only search
4. **Load Balancing:** Each file queried against one backend at a time (no cross-file load balancing needed)
5. **Scaling:** GraphRAG service can be scaled independently via `--scale graphrag_api=N`

## Validation Checklist

- [ ] GraphRAG service starts without errors: `docker logs graphrag_api`
- [ ] File upload triggers both vector and graph indexing
- [ ] File search returns results from both backends mixed by relevance
- [ ] Result deduplication works (same content from both backends shows once with better score)
- [ ] File deletion removes from both vector and graph stores
- [ ] `graphrag_data/` directory persists across container restarts
- [ ] Vector RAG works in isolation if `GRAPH_RAG_API_URL` not set
- [ ] GraphRAG works in isolation if `RAG_API_URL` not set

## Troubleshooting

### GraphRAG Service Won't Start

```bash
# Check service logs
docker logs graphrag_api

# Verify environment variables
docker inspect graphrag_api | grep -A 20 "Env"

# Ensure store directory exists
docker exec graphrag_api ls -la /app/api/data/graphrag
```

### Search Returns Only Vector Results

Check if GraphRAG service is running:
```bash
curl -H "Authorization: Bearer <TOKEN>" \
  http://graphrag_api:8001/query \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"file_id":"test","query":"test","k":5}'
```

### Store File Corruption

If `store.json` becomes invalid:
```bash
# Backup and reset
docker exec graphrag_api cp /app/api/data/graphrag/store.json /app/api/data/graphrag/store.json.bak
docker exec graphrag_api sh -c 'echo "{\"files\":{}}" > /app/api/data/graphrag/store.json'

# Re-upload files to rebuild index
```

## API Response Format

Both backends return results in identical format for deduplication:

```javascript
[
  [
    {
      page_content: "Chunk text here...",
      metadata: {
        source: "/path/to/file.pdf",
        page: 1,
        chunk_index: 0,
        retrieval: "vector" // GraphRAG adds this
      }
    },
    0.15  // distance/dissimilarity score (lower = better)
  ],
  // ... more results
]
```

## Performance Notes

- **Vector RAG:** Fast for dense semantic matching, good for general query similarity
- **GraphRAG:** Better for entity-relationship queries, good for structured knowledge extraction
- **Hybrid:** Complementary strengths; entity mentions found better by graph; abstract queries better by vectors

## Future Enhancements

1. **Metadata Persistence:** Store extracted entities/graph structure in vector metadata for hybrid filtering
2. **Query Rewriting:** Decompose complex queries into entity + attribute searches
3. **Entity Linking:** Cross-reference entities across documents before scoring
4. **Confidence Scoring:** Track extraction confidence (low-confidence entities weighted down)
5. **Sub-graph Search:** Return knowledge graph subgraphs alongside text results
