# Architecture Overview

## Two-Tier Architecture

Grid AIQ uses a two-tier architecture consisting of a **Next.js Backend-for-Frontend (BFF)** on port 3000 and a **Python FastAPI backend** on port 8000.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Browser                                      │
│                  http://localhost:3000                                │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Tier 1: Next.js BFF (port 3000)                                     │
│                                                                       │
│  ┌───────────────────┐    ┌──────────────────────┐                   │
│  │  Node.js Gateway   │    │  Next.js App Router  │                   │
│  │  (server.js)       │◄──►│  (API Routes + UI)   │                   │
│  │                    │    │                      │                   │
│  │  • HTTP proxy      │    │  • WorkOS AuthKit    │                   │
│  │  • WebSocket proxy │    │  • Drizzle ORM       │                   │
│  │  • /websocket →    │    │  • Collection scope  │                   │
│  │    Python backend  │    │  • Document uploads  │                   │
│  └───────────────────┘    └──────────────────────┘                   │
│                                                                       │
│  Environment: BACKEND_URL=http://aiq-agent:8000                       │
│               PORT=3000, NEXT_INTERNAL_URL=http://localhost:3001     │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ HTTP + WS
                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Tier 2: Python FastAPI Backend (port 8000)                            │
│                                                                         │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────────┐   │
│  │  Dask Scheduler  │    │  Dask Worker(s) │    │  Uvicorn         │   │
│  │  (port 8786)     │◄──►│  (NAT runtime)   │    │  FastAPI App    │   │
│  │  Dashboard:8787  │    │                  │    │  (NAT + custom) │   │
│  └─────────────────┘    └─────────────────┘    └────────┬─────────┘   │
│                                                         │              │
│  NAT Framework (NeMo Agent Toolkit):                                │
│  • LangGraph multi-agent pipeline (intent → shallow → deep research) │
│  • Knowledge Layer (LlamaIndex + ChromaDB) for RAG                  │
│  • AIQ API worker for async job processing with SSE streaming       │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Tier 1: Next.js BFF (port 3000)

The Node.js gateway (`server.js`) runs on port 3000 and serves as the single entry point:

- **Production mode**: Starts Next.js internally on port 3001 and handles all HTTP requests directly. WebSocket connections for `/websocket` are proxied to the Python backend.
- **Development mode**: Proxies HTTP to Next.js dev server (port 3001, Turbopack) and WebSocket upstream.
- **BFF API routes** (`/api/*`): Next.js App Router handlers that add WorkOS session management, database access via Drizzle ORM, and collection-scope computation.

Key responsibilities of the BFF:

1. **Authentication**: WorkOS AuthKit middleware (`proxy.ts`) enforces session-based auth. The `REQUIRE_AUTH` env var controls whether auth is required.
2. **Collection scoping**: On WebSocket upgrade, the gateway fetches `/api/auth/websocket-scope` to compute the `X-Grid-Collection-Scope` header, which tells the Python backend which ChromaDB collections to search.
3. **File uploads**: Handles multipart uploads, validates against `FILE_UPLOAD_ACCEPTED_TYPES` and `FILE_UPLOAD_MAX_SIZE_MB`, then uploads to MinIO and triggers backend ingestion.

### Tier 2: Python FastAPI Backend (port 8000)

The backend uses the **NVIDIA NeMo Agent Toolkit (NAT)** framework with a custom startup script:

- **Entrypoint** (`entrypoint.py`): Starts a Dask scheduler (port 8786) and Dask worker, then launches the web server.
- **Web server** (`start_web.py`): Loads the NAT YAML configuration, sets up environment variables, and runs uvicorn directly (bypassing `nat serve` to avoid asyncio event-loop conflicts).
- **NAT runtime**: Provides the LangGraph-based multi-agent pipeline with intent classification, clarifier agent, shallow research agent, and deep research agent with citation verification.

The NAT framework is extended with:

| Component | File | Purpose |
|-----------|------|---------|
| Knowledge API routes | `frontends/aiq_api/src/aiq_api/routes/` (collections, documents, ingest; mounted by `plugin.py`) | Collection CRUD, document management, file ingestion. (The old `src/aiq_agent/fastapi_extensions/` duplicate was deleted 2026-07-03.) |
| AIQ API worker | `frontends/aiq_api/` | Async job processing with SSE streaming |
| Knowledge layer | `sources/knowledge_layer/` | LlamaIndex-backed RAG with ChromaDB |
| Custom auth utils | `src/aiq_agent/auth/` | JWT extraction, WorkOS token validation |
| OIB sync | `src/aiq_agent/oib_sync.py` | Incremental OIB PDF ingestion with SHA-256 registry |

### Data Flow

#### Chat Request

```
Browser
  │  WebSocket /websocket?projectId=X&conversationId=Y
  ▼
Node.js Gateway
  │  1. Calls /api/auth/websocket-scope (internal HTTP to itself)
  │  2. Gets X-Grid-Collection-Scope (base64url-encoded JSON list)
  │  3. Gets user identity (organizationId, userId, accessToken)
  ▼
Python FastAPI
  │  4. NAT context reads X-Grid-Collection-Scope header
  │  5. Collection scoping resolves target collections
  │  6. LangGraph agent pipeline: intent → research → response
  │  7. SSE stream back through WebSocket
  ▼
Browser receives streamed response + structured cards
```

#### Document Upload

```
Browser
  │  POST /api/documents/upload (multipart form)
  ▼
Next.js BFF
  │  1. Validates file type and size
  │  2. Uploads to MinIO (grid-documents bucket)
  │  3. Calls backend /api/v1/ingest
  ▼
Python FastAPI
  │  4. LlamaIndex ingestor chunks and embeds document
  │  5. ChromaDB persists vectors
  │  6. Document summary stored in PostgreSQL (summaries table)
  ▼
Return: job_id for status polling
```

### Infrastructure Services

| Service | Technology | Purpose |
|---------|-----------|---------|
| PostgreSQL | postgres:16-alpine | Job metadata, checkpoints, app state |
| MinIO | minio/minio | S3-compatible document storage |
| ChromaDB | embedded in Python | Vector storage for embeddings |
| Dask | NAT-managed | Distributed job execution |

### Key Design Decisions

1. **Next.js BFF pattern** (ADR-0003): The Next.js layer handles auth sessions, database access, and collection scoping. The Python backend remains stateless and trusts the `X-Grid-Collection-Scope` header.
2. **No asyncio.run()**: `start_web.py` runs uvicorn directly instead of using `nat serve`, avoiding the "event loop is already running" error.
3. **Singleton ingestor**: The knowledge layer factory (`factory.py`) caches ingestor instances to preserve job state across requests and avoid duplicate TTL cleanup threads.
4. **Custom WebSocket proxy**: `server.js` intercepts `/websocket` connections, enriches them with collection scope and auth context, then proxies to the Python backend.
