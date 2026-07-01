# Grid OIB Agent MVP — Phase 2: OIB Backend (Ingestion + Source + Guardrails)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Implement tasks in order, run verification commands, and commit.

**Goal:** Build the persistent OIB knowledge base, expose a manual sync endpoint, add a custom retrieval tool, configure the Grid workflow, and add topic guardrails.

**Architecture:**
- `scripts/ingest_oib.py` scans `data/oib/`, tracks each PDF by hash in `data/oib_registry.json`, and submits new/changed files to the LlamaIndex ingestor against the `oib_knowledge` collection.
- `frontends/aiq_api/src/aiq_api/routes/oib.py` adds `POST /v1/admin/oib/sync`, protected by `GRID_ADMIN_TOKEN`, which runs the ingestion script as a background task and returns a job ID.
- `sources/oib_knowledge/` registers `oib_knowledge_search`, a NAT function that retrieves from `oib_knowledge` using the same LlamaIndex retriever and returns formatted context.
- `configs/config_grid_oib.yml` wires the new OIB source alongside the existing web search tools and points `knowledge_search`/`oib_knowledge_search` at `oib_knowledge`.
- `src/aiq_agent/agents/chat_researcher/prompts/intent_classification.j2` is extended to treat off-topic queries as `intent: meta` with a refusal.
- `src/aiq_agent/agents/deep_researcher/prompts/writer.j2` is extended to instruct the model to emit a `<grid_cards>[...]</grid_cards>` JSON block when cards are useful.

**Tech Stack:** Python 3.11, uv, NAT, LlamaIndex, ChromaDB, NVIDIA embeddings, FastAPI.

---

## Task 1: Create incremental OIB ingestion script

**Files:**
- Create: `scripts/ingest_oib.py`
- Modify: `pyproject.toml` (add script console entry if useful, optional)

- [ ] **Step 1: Write `scripts/ingest_oib.py`**

```python
# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Incremental ingestion of OIB Richtlinien PDFs into the oib_knowledge collection."""

import hashlib
import json
import logging
import os
from pathlib import Path

from aiq_agent.knowledge.factory import get_ingestor

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

OIB_DIR = Path(os.environ.get("OIB_DOCUMENTS_DIR", "data/oib"))
REGISTRY_PATH = Path(os.environ.get("OIB_REGISTRY_PATH", "data/oib_registry.json"))
COLLECTION_NAME = os.environ.get("OIB_COLLECTION_NAME", "oib_knowledge")
CHROMA_DIR = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")


def _file_hash(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _load_registry() -> dict[str, str]:
    if REGISTRY_PATH.exists():
        return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return {}


def _save_registry(registry: dict[str, str]) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(registry, indent=2, sort_keys=True), encoding="utf-8")


def sync() -> tuple[int, int]:
    if not OIB_DIR.exists():
        raise FileNotFoundError(f"OIB directory not found: {OIB_DIR}")

    pdf_paths = sorted(p for p in OIB_DIR.rglob("*.pdf") if p.is_file())
    if not pdf_paths:
        logger.warning("No PDF files found in %s", OIB_DIR)
        return 0, 0

    registry = _load_registry()
    new_or_changed: list[Path] = []

    for pdf in pdf_paths:
        current_hash = _file_hash(pdf)
        if registry.get(str(pdf)) != current_hash:
            new_or_changed.append(pdf)
            registry[str(pdf)] = current_hash

    if not new_or_changed:
        logger.info("No new or changed OIB PDFs. Skipping ingestion.")
        return 0, len(pdf_paths)

    ingestor = get_ingestor("llamaindex", {"persist_dir": CHROMA_DIR})
    for pdf in new_or_changed:
        logger.info("Ingesting %s", pdf)
        job_id = ingestor.submit_job(
            file_paths=[str(pdf)],
            collection_name=COLLECTION_NAME,
            config={"original_filenames": [pdf.name]},
        )
        logger.info("Submitted ingestion job %s for %s", job_id, pdf.name)

    _save_registry(registry)
    logger.info("Ingested %d file(s); %d total file(s) tracked", len(new_or_changed), len(pdf_paths))
    return len(new_or_changed), len(pdf_paths)


if __name__ == "__main__":
    added, total = sync()
    print(f"OIB sync complete: {added} added/changed, {total} total tracked")
```

- [ ] **Step 2: Make the script executable and ensure it imports when NAT is installed**

No `pyproject.toml` change is required for the MVP; the script is invoked directly inside the Docker container.

- [ ] **Step 3: Test the script locally (if dependencies are installed)**

```bash
python scripts/ingest_oib.py
```

Expected: if `data/oib/` contains PDFs and `uv` environment has NAT installed, it will create/update `data/oib_registry.json` and submit ingestion jobs. In a fresh dev environment without the full backend running, this may fail with embedding/Chroma errors; that is acceptable for unit-level verification as long as the script runs without syntax/import errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/ingest_oib.py
git commit -s -m "feat: incremental OIB PDF ingestion script"
```

---

## Task 2: Add manual `/v1/admin/oib/sync` API endpoint

**Files:**
- Create: `frontends/aiq_api/src/aiq_api/routes/oib.py`
- Modify: `frontends/aiq_api/src/aiq_api/routes/__init__.py`
- Modify: `frontends/aiq_api/src/aiq_api/plugin.py` (register the new routes)
- Modify: `frontends/aiq_api/src/aiq_api/models/requests.py` (add response model)

- [ ] **Step 1: Add response models in `frontends/aiq_api/src/aiq_api/models/requests.py`**

Append to the existing file:

```python
from pydantic import BaseModel


class OibSyncResponse(BaseModel):
    status: str
    message: str
    files_added: int
    files_total: int
```

- [ ] **Step 2: Create `frontends/aiq_api/src/aiq_api/routes/oib.py`**

```python
# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""OIB admin routes."""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Header
from fastapi import status

from ..models.requests import OibSyncResponse

logger = logging.getLogger(__name__)

_ADMIN_TOKEN = os.environ.get("GRID_ADMIN_TOKEN")


def _require_admin_token(x_admin_token: str | None = Header(default=None)):
    if not _ADMIN_TOKEN:
        return
    if x_admin_token != _ADMIN_TOKEN:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin token")


def _run_ingestion() -> tuple[int, int]:
    # Import here to avoid heavy imports at module load time.
    from scripts.ingest_oib import sync

    return sync()


def add_oib_routes(router: APIRouter) -> None:
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="oib-sync-")

    @router.post(
        "/v1/admin/oib/sync",
        response_model=OibSyncResponse,
        tags=["oib"],
        summary="Trigger incremental OIB PDF ingestion",
    )
    async def sync_oib_documents(
        _: None = Depends(_require_admin_token),
    ) -> OibSyncResponse:
        try:
            added, total = await asyncio.get_event_loop().run_in_executor(executor, _run_ingestion)
            return OibSyncResponse(
                status="ok",
                message=f"OIB sync triggered: {added} file(s) added/changed, {total} total tracked",
                files_added=added,
                files_total=total,
            )
        except Exception as e:
            logger.exception("OIB sync failed")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e
```

- [ ] **Step 3: Wire the route into `frontends/aiq_api/src/aiq_api/routes/__init__.py`**

Change to:

```python
from .collections import add_collection_routes
from .documents import add_document_routes
from .jobs import register_job_routes
from .oib import add_oib_routes

__all__ = ["add_collection_routes", "add_document_routes", "register_job_routes", "add_oib_routes"]
```

- [ ] **Step 4: Register routes in `frontends/aiq_api/src/aiq_api/plugin.py`**

Find where `add_document_routes`, `add_collection_routes`, or `register_job_routes` are called and add:

```python
from aiq_api.routes import add_oib_routes

# ... after the existing route registrations:
add_oib_routes(router)
```

Use grep to locate the existing calls if not obvious.

- [ ] **Step 5: Run backend lint/tests**

```bash
uv run ruff check frontends/aiq_api/src/aiq_api/routes/oib.py frontends/aiq_api/src/aiq_api/models/requests.py frontends/aiq_api/src/aiq_api/plugin.py
```

Expected: no lint errors.

- [ ] **Step 6: Commit**

```bash
git add frontends/aiq_api/src/aiq_api/routes/oib.py frontends/aiq_api/src/aiq_api/routes/__init__.py frontends/aiq_api/src/aiq_api/models/requests.py frontends/aiq_api/src/aiq_api/plugin.py
git commit -s -m "feat: add manual OIB sync API endpoint"
```

---

## Task 3: Create custom `oib_knowledge_search` source package

**Files:**
- Create: `sources/oib_knowledge/pyproject.toml`
- Create: `sources/oib_knowledge/README.md`
- Create: `sources/oib_knowledge/src/__init__.py`
- Create: `sources/oib_knowledge/src/register.py`

- [ ] **Step 1: Write `sources/oib_knowledge/pyproject.toml`**

```toml
[build-system]
build-backend = "setuptools.build_meta"
requires = ["setuptools >= 64", "setuptools-scm>=8"]

[tool.setuptools]
packages = ["oib_knowledge"]
package-dir = {"oib_knowledge" = "src"}

[project]
name = "oib-knowledge"
version = "0.1.0"
description = "NAT retrieval tool for the persistent OIB Richtlinien knowledge base"
readme = "README.md"
requires-python = ">=3.11,<3.14"
license = {text = "Apache-2.0"}
dependencies = [
    "pydantic>=2.0.0",
]

[project.entry-points."nat.plugins"]
oib_knowledge = "oib_knowledge.register"
```

- [ ] **Step 2: Write `sources/oib_knowledge/README.md`**

```markdown
# OIB Knowledge Source

Custom NAT data source that searches the persistent `oib_knowledge` ChromaDB collection.
```

- [ ] **Step 3: Write `sources/oib_knowledge/src/__init__.py`**

```python
try:
    from .register import OibKnowledgeConfig
    from .register import oib_knowledge_search

    __all__ = ["OibKnowledgeConfig", "oib_knowledge_search"]
except ImportError:
    __all__ = []
```

- [ ] **Step 4: Write `sources/oib_knowledge/src/register.py`**

```python
# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""OIB knowledge retrieval tool."""

import logging
import os

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

from aiq_agent.knowledge.factory import get_retriever

logger = logging.getLogger(__name__)

DEFAULT_COLLECTION = os.environ.get("OIB_COLLECTION_NAME", "oib_knowledge")
DEFAULT_CHROMA_DIR = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")


class OibKnowledgeConfig(FunctionBaseConfig, name="oib_knowledge_search"):
    """Search the persistent OIB Richtlinien knowledge base."""

    collection_name: str = DEFAULT_COLLECTION
    chroma_dir: str = DEFAULT_CHROMA_DIR
    top_k: int = 5


@register_function(config_type=OibKnowledgeConfig)
async def oib_knowledge_search(tool_config: OibKnowledgeConfig, builder: Builder):
    retriever = get_retriever("llamaindex", {"persist_dir": tool_config.chroma_dir})

    async def _search(query: str) -> str:
        """Search the OIB Richtlinien knowledge base for relevant excerpts.

        Args:
            query: The question about Austrian building regulations.

        Returns:
            Formatted excerpts with source document names.
        """
        results = await retriever.retrieve(query, tool_config.collection_name, top_k=tool_config.top_k)
        if not results:
            return "No relevant OIB documents found."

        excerpts = []
        for r in results:
            source = r.metadata.get("file_name", "Unknown OIB document") if r.metadata else "Unknown OIB document"
            text = r.text if hasattr(r, "text") else str(r)
            excerpts.append(f"Source: {source}\n{text}\n---")

        return "\n\n".join(excerpts)

    yield FunctionInfo.from_fn(
        _search,
        description=_search.__doc__,
    )
```

- [ ] **Step 5: Install the package in the uv environment**

```bash
uv pip install -e sources/oib_knowledge
```

- [ ] **Step 6: Run lint**

```bash
uv run ruff check sources/oib_knowledge
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add sources/oib_knowledge
git commit -s -m "feat: add oib_knowledge_search source package"
```

---

## Task 4: Add Grid workflow config

**Files:**
- Create: `configs/config_grid_oib.yml`

- [ ] **Step 1: Copy `configs/config_web_kimi.yml` to `configs/config_grid_oib.yml`**

```bash
cp configs/config_web_kimi.yml configs/config_grid_oib.yml
```

- [ ] **Step 2: Edit `configs/config_grid_oib.yml`**

Make these changes:

1. Update the top comment to:
   ```yaml
   # Grid OIB workflow config — Kimi LLMs, persistent OIB knowledge base plus web search.
   ```

2. In `functions.data_sources.sources`, add an `oib_knowledge` entry alongside the existing `web_search` entry:
   ```yaml
   functions:
     data_sources:
       _type: data_source_registry
       sources:
         - id: web_search
           name: "Web Search"
           description: "Search the web for real-time information."
           tools:
             - web_search_tool
             - advanced_web_search_tool
         - id: oib_knowledge
           name: "OIB Knowledge Base"
           description: "Search the local OIB Richtlinien knowledge base."
           tools:
             - oib_knowledge_search
         - id: knowledge_layer
           name: "Knowledge Base"
           description: "Search uploaded documents and files."
           tools:
             - knowledge_search
   ```

3. Change the `knowledge_search` block to target the OIB collection by default:
   ```yaml
   knowledge_search:
     _type: knowledge_retrieval
     backend: llamaindex
     collection_name: ${COLLECTION_NAME:-oib_knowledge}
     generate_summary: true
     summary_model: summary_llm
     summary_db: ${AIQ_SUMMARY_DB:-sqlite+aiosqlite:///./summaries.db}
     top_k: 5
     chroma_dir: ${AIQ_CHROMA_DIR:-/tmp/chroma_data}
   ```

4. Add the OIB tool block:
   ```yaml
   oib_knowledge_search:
     _type: oib_knowledge_search
     collection_name: ${COLLECTION_NAME:-oib_knowledge}
     chroma_dir: ${AIQ_CHROMA_DIR:-/tmp/chroma_data}
     top_k: 5
   ```

5. Keep the existing `web_search_tool` and `advanced_web_search_tool` function blocks and `exclude_tools` references unchanged.

6. In the `workflow` block, keep `enable_escalation`, `enable_clarifier`, and `use_async_deep_research` as-is.

- [ ] **Step 3: Validate YAML syntax**

```bash
uv run python -c "import yaml; yaml.safe_load(open('configs/config_grid_oib.yml'))"
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add configs/config_grid_oib.yml
git commit -s -m "feat: add Grid OIB workflow config"
```

---

## Task 5: Add topic guardrails to intent classification

**Files:**
- Modify: `src/aiq_agent/agents/chat_researcher/prompts/intent_classification.j2`

- [ ] **Step 1: Update the prompt**

Replace the existing meta/research definitions in STEP 1 with:

```jinja2
### STEP 1: INTENT CLASSIFICATION
Classify the query as "meta" or "research".
- **meta**: System identity, abilities, greetings, time/date, tool questions, emotional check-ins, jokes, casual chat, small talk, out-of-scope requests (code/files), OR any question that is NOT about Austrian building regulations, OIB Richtlinien, Bauordnung, Baurecht, RIS legal research, or related technical/energy standards.
- **research**: Questions about Austrian building regulations, OIB Richtlinien, building codes, energy efficiency requirements, RIS legal documents, or anything requiring the OIB knowledge base.
- **Rule**: If a query is mixed or you are unsure, choose "research".
```

Also update the META branching instructions so a topic refusal is explicit:

```jinja2
#### IF INTENT IS "META":
Generate a direct response to the user.
1. **Identity**: You are the Grid OIB Research Agent. You answer questions about Austrian building regulations using the OIB Richtlinien knowledge base.
2. **Greeting**: Use the user's first name if available. Be brief and friendly.
3. **Out-of-Scope / Topic Guardrail**: If the query is not about Austrian building regulations, OIB Richtlinien, or related legal/technical topics, politely decline and explain that you can only help with those topics. Do not answer the off-topic question.
4. **Constraints**: No emojis. Do not answer research questions here.
```

- [ ] **Step 2: Run backend tests for chat researcher if they exist**

```bash
uv run pytest tests/ -q -k chat_researcher --tb=short
```

Expected: no new failures.

- [ ] **Step 3: Commit**

```bash
git add src/aiq_agent/agents/chat_researcher/prompts/intent_classification.j2
git commit -s -m "feat: restrict agent to Austrian building regulation topics"
```

---

## Task 6: Add card-generation instruction to the writer prompt

**Files:**
- Modify: `src/aiq_agent/agents/deep_researcher/prompts/writer.j2`

- [ ] **Step 1: Append a card instruction to the writer prompt**

Add this block near the end of the prompt (before any final output-format instructions):

```jinja2
### GRID RESPONSE CARDS
When the answer calls for a concise overview or a legal-basis explanation, include a `<grid_cards>` block after your prose. The block must contain a single JSON array with one or more card objects. Supported card types for this MVP are:
- "summary" — a short overview of the topic.
- "legal_basis" — the relevant legal norm, OIB Richtlinie, or RIS reference.

Example:
<grid_cards>
[
  {
    "type": "summary",
    "title": "Zusammenfassung",
    "content": "Die OIB-Richtlinie 6 regelt den Wärmeschutz von Gebäuden."
  },
  {
    "type": "legal_basis",
    "title": "Rechtsgrundlage",
    "norm": "OIB Richtlinie 6",
    "reference": "https://www.oib.or.at",
    "summary": "Anforderungen an den Wärmeschutz und den sommerlichen Wärmeschutz."
  }
]
</grid_cards>

Only include cards when they add value. Never make up references; if no exact URL is known, omit the reference field.
```

- [ ] **Step 2: Commit**

```bash
git add src/aiq_agent/agents/deep_researcher/prompts/writer.j2
git commit -s -m "feat: instruct model to emit Grid response cards"
```

---

## Task 7: Backend integration verification

- [ ] **Step 1: Run backend lint**

```bash
uv run ruff check src/aiq_agent sources/oib_knowledge frontends/aiq_api scripts/ingest_oib.py
```

Expected: no errors.

- [ ] **Step 2: Start the backend with the new config (if environment is available)**

```bash
uv run nat serve --config_file configs/config_grid_oib.yml --port 8000
```

Expected: server starts and registers `oib_knowledge_search`.

- [ ] **Step 3: Test the sync endpoint**

```bash
curl -X POST http://localhost:8000/v1/admin/oib/sync -H "x-admin-token: $GRID_ADMIN_TOKEN"
```

Expected: JSON response with `status: ok` and file counts.

- [ ] **Step 4: Test a chat prompt**

Use the UI or curl to send: *"Was regelt die OIB Richtlinie 6?"*. Expect either a direct shallow answer or a research response. If the model returns cards, verify the `<grid_cards>` JSON appears in the raw response.

- [ ] **Step 5: Mark phase complete**

Update the parent TodoWrite: Phase 2 complete.
