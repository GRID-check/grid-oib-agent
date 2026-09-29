# Knowledge Layer

Document ingestion and retrieval for Piloti, on one backend: `llamaindex`.

## Key Features

- **Rich Output Schema** - `Chunk` model with 15+ fields: content types, citations, images, structured data
- **Full Ingestion Pipeline** - `BaseIngestor` with async job tracking and status polling
- **Collection Management** - create/delete/list collections per session or use case
- **File Management** - upload/delete/list files with status tracking (UPLOADING → INGESTING → SUCCESS/FAILED)
- **Content Typing** - TEXT, TABLE, CHART, IMAGE enums for frontend rendering
- **One backend** - `llamaindex` in production; the `BaseRetriever`/`BaseIngestor` seam stays so tests can register fakes

---

## Table of Contents

- [The Backend](#the-backend)
- [Quick Start](#quick-start)
- [Usage](#usage)
  - [With YAML Config](#with-nemo-agent-toolkit-yaml-config---recommended)
  - [Programmatic Usage](#programmatic-usage)
- [Web UI Mode](#web-ui-mode)
- [Adding a Backend](#adding-a-backend)
- [Architecture](#architecture)
- [Core Data Models](#core-data-models)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

---

## The Backend

`llamaindex` is the knowledge layer's only backend: LlamaIndex over ChromaDB,
with embeddings and the VLM through OpenRouter. It runs in the agent's process
and needs no external service beyond OpenRouter. It is the production backend,
and has been since the first commit: every config Piloti deployed selects it.

Earlier versions of this guide listed a second backend (a client for NVIDIA's
hosted retrieval service, inherited from the AI-Q template) as "Production,
multi-user". That was the template's claim, never Piloti's: no
Piloti deployment ran it, and it could not serve the product's retrieval. It was
deleted; [ADR-0072](../../docs/adr/0072-the-knowledge-layer-has-one-backend-llamaindex.md)
records why.

---

## Quick Start

> **Prerequisites:** Complete the [main setup](../../README.md#quick-start) first (clone repo, run `./scripts/setup.sh`, obtain API keys).

> **Tip:** Instead of exporting env vars each time, add them to `deploy/.env` and use `dotenv -f deploy/.env run <command>` to run any command with those vars loaded automatically.

```bash
# 1. Set up environment variables (add to deploy/.env to avoid exporting each time)
export OPENROUTER_API_KEY=sk-or-your-key-here

# 2. Install the backend
uv pip install -e "sources/knowledge_layer[llamaindex]"
```

```bash
# 3. Verify
python -c "from aiq_agent.knowledge import get_retriever; print('OK')"
```

### When retrieval fails on dependencies

Both the ingestor and the retriever preflight the whole stack before reporting
themselves initialized, and the error names what is actually wrong **per
distribution**. Two different faults, two different fixes:

| Report | What it means | Fix |
|---|---|---|
| `<dist>: not installed` | The distribution is genuinely absent. | Install the extra. |
| `<dist>: installed but broken (...)` | It is present but cannot be loaded — commonly a **partial install**, or one of its own dependencies missing. | `uv sync --extra llamaindex` |

The second case is the one worth recognising. `llama_index` is a PEP-420
namespace package, so the parent import succeeds whenever *any* `llama-index-*`
distribution is present. A tree missing `llama-index-core` therefore fails deep
inside a submodule with `cannot import name 'core' from 'llama_index' (unknown
location)` rather than at the obvious place — and reads as "not installed" if
you only look at the top line. Adding the package that is already there will not
help; **reinstall the whole extra**.

---

## Usage

### With NeMo Agent Toolkit (YAML Config) - Recommended

The `knowledge_retrieval` function is registered as a NAT function type. **YAML config is the recommended single source of truth** for workflow configuration:

```yaml
# Example knowledge_retrieval function configuration
functions:
  knowledge_search:
    _type: knowledge_retrieval      # NAT function type
    collection_name: my_docs        # Required: target collection
    top_k: 5                        # Results to return
    chroma_dir: /tmp/chroma_data    # ChromaDB persistence directory
```

You can also use environment variable substitution in YAML for sensitive values:

```yaml
functions:
  knowledge_search:
    _type: knowledge_retrieval
    collection_name: ${COLLECTION_NAME:-default}
```

> **Note:** To add config fields, edit `KnowledgeRetrievalConfig` in `sources/knowledge_layer/src/register.py`. An older config that still sets `backend: llamaindex` loads unchanged; the key is ignored.

#### Multimodal Extraction

By default, LlamaIndex ingests text only and calls the embedding and VLM models through OpenRouter with `OPENROUTER_API_KEY`. All options below can be overridden via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| **Embedding** | | |
| `AIQ_EMBED_MODEL` | `openai/text-embedding-3-large` | Embedding model id; keep it stable, stored vectors only match query vectors from the same model |
| `AIQ_EMBED_BASE_URL` | `https://openrouter.ai/api/v1` | Embedding API base URL (any OpenAI-compatible embeddings endpoint) |
| `AIQ_EMBED_TIMEOUT_SECONDS` | `60` | Per-request timeout on the ingestion embeddings client, two retries |
| `AIQ_QUERY_EMBED_TIMEOUT_SECONDS` | `3` | Per-request timeout on the query embedding a chat turn waits on, two retries; retrieval fails open after the third attempt |
| **Extraction switches** (on unless set to `false`; no deployment sets them) | | |
| `AIQ_EXTRACT_TABLES` | `true` | Also index every other pdfplumber table in a PDF as a `[TABLE from page N]` chunk. Captioned tables („Tabelle 3: …") do not need it: they are always read as tables and cut out of the page text (`llamaindex/captioned_tables.py`). In a document with a Punkt outline each is its own passage, addressable as `read_passage(punkt="Tabelle 3")`; otherwise it is put back as Markdown into its page's text. This pass skips them |
| `AIQ_EXTRACT_IMAGES` | `true` | Extract embedded images from PDFs and caption them with a VLM, skipping pages already rendered whole as visual pages. For a BFF-dispatched document the raster is also stored beside the file (`_img/<index>.jpg`, via the BFF presign route) so `view_knowledge_image` can show it at its own resolution |
| `AIQ_EXTRACT_CHARTS` | `true` | Index a visual the VLM types as a chart as a `chart` chunk with its structured data (chart type, axis labels, data points); off, it is indexed as an image |
| `AIQ_MAX_IMAGES_PER_DOCUMENT` | `64` | Most embedded images per PDF sent to the VLM, largest first; the count left out is on the file's job status as `images_over_cap` |
| **Vision Model** | | |
| `AIQ_VLM_MODEL` | `openai/gpt-6-luna` | VLM for image captioning — house model, image input verified on OpenRouter; caption quality on OIB tables/drawings still unevaluated (TODO) |
| `AIQ_VLM_BASE_URL` | `https://openrouter.ai/api/v1` | VLM API base URL (any OpenAI-compatible chat endpoint that takes images) |

To switch one off, set it in `deploy/.env`:

```bash
# In deploy/.env or export directly
AIQ_EXTRACT_TABLES=false   # Leave uncaptioned PDF tables in the page text (captioned ones are always tables)
AIQ_EXTRACT_IMAGES=false   # Do not caption embedded PDF images
AIQ_EXTRACT_CHARTS=false   # Index charts as images
```

The startup log shows the active mode; by default:

```
LlamaIndexIngestor initialized: persist_dir=/app/data/chroma_data, mode=text + tables + charts + images
```

> **Note:** `AIQ_EXTRACT_IMAGES` and `AIQ_EXTRACT_CHARTS` work together. With both on (the default), each image is typed by the VLM and a chart is indexed as a chart. With charts off, a chart is indexed as an image; with images off, embedded images are still analysed and only charts are kept.

### Programmatic Usage

```python
# Import the adapter module to trigger registration
from knowledge_layer.llamaindex import LlamaIndexRetriever, LlamaIndexIngestor

# Use the factory to get instances
from aiq_agent.knowledge import get_retriever, get_ingestor

# Ingest documents
ingestor = get_ingestor("llamaindex", config={"persist_dir": "/tmp/chroma"})
ingestor.create_collection("my_docs")
job_id = ingestor.upload_file("doc.pdf", "my_docs")

# Check ingestion status
status = ingestor.get_file_status(job_id, "my_docs")
print(f"Status: {status.status}")  # UPLOADING, INGESTING, SUCCESS, FAILED

# Retrieve
retriever = get_retriever("llamaindex", config={"persist_dir": "/tmp/chroma"})
result = await retriever.retrieve("query", "my_docs", top_k=5)
for chunk in result.chunks:
    print(f"{chunk.display_citation}: {chunk.content[:100]}")
```

---

## Web UI Mode

Run the backend API server and frontend UI together for document upload, collection management, and chat.

### Start Backend

```bash
nat serve --config_file configs/config_oib_openrouter.yml --host 0.0.0.0 --port 8000
```

### Start Frontend

```bash
cd frontends/ui
npm run dev
```

Open `http://localhost:3000` in your browser.

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/collections` | Create collection |
| `GET` | `/v1/collections` | List collections |
| `DELETE` | `/v1/collections/{name}` | Delete collection |
| `POST` | `/v1/collections/{name}/documents` | Upload files |
| `GET` | `/v1/documents/{job_id}/status` | Poll ingestion status |
| `DELETE` | `/v1/collections/{name}/documents` | Delete files |

### Port Configuration

If the default port conflicts with other services, override it when starting Docker Compose:

```bash
PORT=8100 docker compose --env-file ../.env -f docker-compose.yaml up -d
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8000 | Backend API host port |

The backend always runs on port 8000 inside the container. This variable only changes the host port mapping.

For more details, see the [Docker Compose README](../../deploy/compose/README.md#port-configuration).

### Session Collections

The backend supports session-based collections (`s_<uuid>`) created by the UI. Each browser session gets its own isolated collection.

### TTL Cleanup

Collections inactive for 24 hours are auto-deleted based on `last_indexed` timestamp. Background thread runs hourly.

```python
COLLECTION_TTL_HOURS = 24
TTL_CLEANUP_INTERVAL_SECONDS = 3600
```

---

## Document Summaries

Document summaries help research agents understand what files are available before making tool calls. When enabled, the knowledge layer generates a one-sentence summary during ingestion and exposes it to agents through their system prompts.

### Enabling Summaries

Add `generate_summary: true` to your knowledge retrieval config:

```yaml
functions:
  knowledge_search:
    _type: knowledge_retrieval
    collection_name: test_collection
    top_k: 5
    generate_summary: true       # Enable AI-generated summaries
    summary_model: summary_llm   # Required: reference to LLM in llms: section
```

When `generate_summary: true`, you **must** configure `summary_model` to reference an LLM from your `llms:` section:

```yaml
llms:
  summary_llm:
    _type: openai
    model_name: ${GRID_DEFAULT_MODEL:-openai/gpt-6-luna}
    base_url: "https://openrouter.ai/api/v1"
    api_key: ${OPENROUTER_API_KEY}
    temperature: 0.3
    max_tokens: 150

functions:
  knowledge_search:
    _type: knowledge_retrieval
    generate_summary: true
    summary_model: summary_llm   # Required when generate_summary: true
    summary_db: sqlite+aiosqlite:///./summaries.db  # Optional: defaults to SQLite
```

### Supported File Types

Summaries are generated for the following file types:

| Format | Extension | Extraction Method |
|--------|-----------|-------------------|
| PDF | `.pdf` | First 2 pages via `pypdf` |
| Word | `.docx` `.docm` `.doc` `.odt` `.rtf` | The PDF rendition the BFF converts through Gotenberg (`extraction_ref`, ADR-0071), read like a PDF. No rendition, no index: the file fails as `office_rendition_required` and can be re-ingested |
| PowerPoint | `.pptx` `.pptm` `.ppt` `.odp` | The PDF rendition, as for Word. Speaker notes of a `.pptx`/`.pptm` come from the original via `python-pptx`, one unit per slide, labelled with the slide's rendition page |
| Plain Text | `.txt` | Direct file read |
| Markdown | `.md` | Direct file read |

Other file types are ingested normally but do not receive summaries.

> **Frontend file types:** The frontend file picker defaults to `.pdf,.docx,.txt,.md,.csv,.xlsx,.pptx` (`frontends/ui/src/shared/config/file-upload.ts`). Leave `FILE_UPLOAD_ACCEPTED_TYPES` unset to keep that default; a value that lists fewer types narrows what users can upload. Word and PowerPoint files also need Gotenberg (`GOTENBERG_URL`). Where to set it:
>
> | Deployment | Where to set |
> |-----------|-------------|
> | **CLI** (`start_e2e.sh`) | `deploy/.env` |
> | **Docker Compose** | `deploy/.env` (passed to frontend container automatically) |
> | **Helm** | `deploy/helm/deployment-k8s/values.yaml` under the frontend app's `env` section |

### How It Works

1. **Ingestion**: Backend extracts text from the document and generates a one-sentence summary using an LLM call
2. **Registry**: Summary is stored in a centralized, backend-agnostic registry (`aiq_agent.knowledge.factory`)
3. **Agent prompts**: Summaries appear in the agent's system prompt under the shelf-grouped knowledge-base inventory (Büroarchiv / Projektwissen / Private Sitzung / Basiswissen)
4. **Tool calling**: Agents can make informed decisions about when to call `knowledge_search`

### Agent Prompt Example

When documents have summaries, agents see:

```
## Uploaded Documents

The user has uploaded the following documents to the knowledge base:

- **quarterly_report.pdf**: Q3 financial results showing 15% revenue growth and improved operating margins.
- **product_roadmap.pptx**: 2024 product development timeline including AI features and cloud integrations.
- **meeting_notes.md**: Summary of Q4 planning meeting covering budget allocation and team priorities.

When the query relates to these documents, prioritize searching them before using external tools.
```

### Backend-Agnostic Design

The summary system works identically across all backends:

| Component | Location | Purpose |
|-----------|----------|---------|
| `register_summary()` | `aiq_agent.knowledge.factory` | Store summary after ingestion |
| `unregister_summary()` | `aiq_agent.knowledge.factory` | Remove summary on file deletion |
| `get_available_documents()` | `aiq_agent.knowledge.factory` | Retrieve summaries for agents |

The LlamaIndex adapter calls these functions; the registry does not depend on it.

### Summary Storage

Summaries are persisted in a database (SQLite by default) so they survive server restarts. You can configure the storage backend:

```yaml
functions:
  knowledge_search:
    _type: knowledge_retrieval
    generate_summary: true
    summary_db: ${AIQ_SUMMARY_DB:-sqlite+aiosqlite:///./summaries.db}  # Default: SQLite
```

For production deployments, use PostgreSQL:

```bash
export AIQ_SUMMARY_DB="postgresql+psycopg://user:pass@localhost:5432/mydb"
```

The summary store uses SQLAlchemy and follows the same pattern as the jobs database (`db_url`), so you can point both to the same PostgreSQL instance if desired.

### Custom Summarization

To customize summary generation, modify the `generate_summary()` method in your adapter. See reference implementations:

- **LlamaIndex**: `sources/knowledge_layer/src/llamaindex/adapter.py` (search for `generate_summary`)

Key customization points:
- LLM model selection and prompt template
- Text extraction strategy (format-aware: pages for PDF, body text for DOCX, slide text for PPTX)
- Summary length and format constraints

---

## Adding a Backend

Don't, without an ADR. There is one backend on purpose
([ADR-0072](../../docs/adr/0072-the-knowledge-layer-has-one-backend-llamaindex.md)):
the product's retrieval (the OIB base-collection filter, `read_passage`, the
family overview, provenance, visual details, hybrid search) is written against
what `llamaindex` can do, and a second backend that cannot do all of it fails
quietly rather than loudly. A decision to add one supersedes ADR-0072.

What stays is the seam: `BaseRetriever` and `BaseIngestor` in
`src/aiq_agent/knowledge/base.py`, and the `@register_retriever` /
`@register_ingestor` registry in `factory.py`. Tests register fakes through it,
and `tests/knowledge_layer_tests/run_adapter_compliance.py --backend <name>`
checks an adapter against the interface. `register.py` wires `llamaindex` in
`_setup_backend`; a second backend would reintroduce a selection there.

---

## Architecture

### How Registration Works

Backends register themselves using decorators when their module is imported:

```python
# In adapter.py
from aiq_agent.knowledge.factory import register_retriever, register_ingestor

@register_retriever("my_backend")  # Registration name used in config
class MyRetriever(BaseRetriever):
    ...

@register_ingestor("my_backend")
class MyIngestor(BaseIngestor):
    ...
```

The registration name (e.g., `"my_backend"`) is what factory calls use:
`get_retriever("my_backend")`. `register.py` always asks for `"llamaindex"`.

**Important:** The adapter module must be imported for registration to happen. This is why:
1. `__init__.py` imports the adapter classes
2. The NAT function imports from `knowledge_layer.<backend>.adapter`

### Core Library (`src/aiq_agent/knowledge/`)

```
src/aiq_agent/knowledge/
    __init__.py      # Exports: Chunk, get_retriever, get_ingestor, etc.
    base.py          # Abstract classes: BaseRetriever, BaseIngestor
    schema.py        # Data models: Chunk, RetrievalResult, FileInfo, CollectionInfo
    factory.py       # Registry + factory: register_retriever(), get_retriever()
```

| File | Purpose |
|------|---------|
| `base.py` | Defines the interface all backends must implement |
| `schema.py` | Universal data models - backends convert native formats to these |
| `factory.py` | Registration decorators + factory functions for instantiation |

### Backend Adapters (`sources/knowledge_layer/src/`)

```
sources/knowledge_layer/src/
    <backend_name>/
        __init__.py      # Imports adapter to trigger registration
        adapter.py       # @register_retriever/@register_ingestor decorated classes
        README.md        # Backend-specific documentation
        pyproject.toml   # Optional: isolated dependencies
```

### NeMo Agent Toolkit Integration (`sources/knowledge_layer/src/`)

```
sources/knowledge_layer/src/
    register.py      # @register_function exposes retrieval to agents
```

The `register.py` defines `KnowledgeRetrievalConfig` which maps YAML config to backend instantiation.

---

## Core Data Models

```python
from aiq_agent.knowledge.schema import (
    # Retrieval
    Chunk,           # Retrieved content piece (15+ fields)
    RetrievalResult, # Query result container
    ContentType,     # TEXT, IMAGE, TABLE, CHART

    # Ingestion
    CollectionInfo,  # Collection metadata
    FileInfo,        # File/job status
    FileStatus,      # UPLOADING, INGESTING, SUCCESS, FAILED
    IngestionJobStatus,  # Batch job tracking
)
```

### Chunk Schema (The "Golden Record")

```python
class Chunk(BaseModel):
    # Core content
    chunk_id: str              # Unique ID for citation tracking
    content: str               # Main text (or caption for visuals)
    score: float               # Similarity score 0.0-1.0

    # Citation (required)
    file_name: str             # Original filename
    page_number: Optional[int] # Page number (1-based)
    display_citation: str      # User-facing citation label

    # Content typing (required)
    content_type: ContentType  # TEXT, TABLE, CHART, IMAGE
    content_subtype: Optional[str]  # e.g., "bar_chart", "pie_chart"

    # Optional rich data
    structured_data: Optional[str]  # Raw data for tables/charts
    image_url: Optional[str]        # Presigned URL for images
    metadata: Dict[str, Any]        # Passthrough metadata
```

---

## Configuration

### Configuration Precedence

Configuration values are resolved in the following order (highest to lowest priority):

1. **Explicit parameter** - Values passed directly to factory functions (`get_retriever("llamaindex")`)
2. **YAML config file** - The options in your workflow config (recommended)
3. **Environment variables** - `KNOWLEDGE_RETRIEVER_BACKEND`, `AIQ_CHROMA_DIR`, etc.
4. **Hardcoded defaults** - Built-in fallback values

**Recommendation:** Use YAML config as your single source of truth for workflow configuration. Environment variables are useful for:
- Container deployments (12-factor app pattern)
- CI/CD overrides
- Secrets management (API keys)

### Environment Variables

| Variable | Backend | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | All | Required for embeddings/VLM and LLM calls (everything routes through OpenRouter) |
| `KNOWLEDGE_RETRIEVER_BACKEND` | All | Default retriever backend (fallback if not in YAML) |
| `KNOWLEDGE_INGESTOR_BACKEND` | All | Default ingestor backend (fallback if not in YAML) |
| `AIQ_CHROMA_DIR` | llamaindex | ChromaDB persistence path |
| `AIQ_SUMMARY_DB` | All | Summary database URL (SQLite or PostgreSQL) |
| `COLLECTION_NAME` | All | Default collection name |

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `Unknown backend: my_backend` | Adapter not imported/registered | Import the adapter module before calling factory |
| `ormsgpack` attribute error | Version conflict with langgraph | `uv pip install "ormsgpack>=1.5.0"` |
| Empty retrieval results | Collection empty | Run ingestion first, verify collection name matches |
| Job status 404 | Different process/instance | Factory uses singletons - ensure same process |
| Backend registered twice | Module imported multiple times | Normal - factory logs warning but works fine |

### Debug Registration

```python
# Check what's registered
from aiq_agent.knowledge.factory import list_retrievers, list_ingestors, get_knowledge_layer_config

print("Retrievers:", list_retrievers())
print("Ingestors:", list_ingestors())
print("Full config:", get_knowledge_layer_config())
```
