# Grid OIB Agent MVP — Phase 4 & 5: Shared Cards + Dev Container

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Implement the tasks below in order, run verification commands, and commit.

**Goal:** Replace tag-parsed cards with a real shared schema contract, add a backend card generator, update the WebSocket response envelope to carry cards, fix the guardrail scope, and add a VS Code dev container plus Docker Compose validation.

**Architecture:**
- A single `shared/cards/schemas.json` describes every card type.
- `src/aiq_agent/cards/models.py` derives Pydantic models; `frontends/ui/src/shared/cards/schemas.ts` derives Zod schemas.
- A new NAT tool `grid_card_generator` in `sources/grid_cards/` produces validated `Card[]` JSON from the research context.
- The chat researcher graph adds a `card_generator_node` after research, stores cards in `ChatResearcherState.cards`, and the WebSocket handler attaches them as a top-level `cards` field on the final `RESPONSE_MESSAGE` (the `WebSocketSystemResponseTokenMessage` model allows extras).
- The UI removes the `<grid_cards>` parser and renders cards from the message's `cards` field.
- `intent_classification.j2` is corrected to the Austria-specific building/regulatory domain.
- A `.devcontainer/` configuration is added that builds the dev target of `deploy/Dockerfile`, installs Node, and mounts the workspace.

**Tech Stack:** Python 3.11, NAT, Pydantic, TypeScript/Zod, Next.js, Docker, VS Code dev containers.

---

# Phase 4: Shared card schema + generator + frontend contract

## Task 1: Shared schema package

**Files:**
- Create: `shared/cards/schemas.json`
- Create: `src/aiq_agent/cards/__init__.py`
- Create: `src/aiq_agent/cards/models.py`
- Create: `frontends/ui/src/shared/cards/schemas.ts`
- Delete: `frontends/ui/src/features/grid-cards/parser.ts` and `parser.spec.ts`

- [ ] **Step 1: Write `shared/cards/schemas.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "GridCard",
  "oneOf": [
    {
      "type": "object",
      "title": "SummaryCard",
      "required": ["type", "title"],
      "properties": {
        "type": { "const": "summary" },
        "title": { "type": "string", "minLength": 1 },
        "content": { "type": "string" },
        "key_points": { "type": "array", "items": { "type": "string" } }
      }
    },
    {
      "type": "object",
      "title": "LegalBasisCard",
      "required": ["type", "law"],
      "properties": {
        "type": { "const": "legal_basis" },
        "law": { "type": "string", "minLength": 1 },
        "article": { "type": "string" },
        "section": { "type": "string" },
        "summary": { "type": "string" },
        "original_text": { "type": "string" }
      }
    }
  ]
}
```

- [ ] **Step 2: Write `src/aiq_agent/cards/models.py`**

```python
# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Pydantic models for Grid response cards."""

from typing import Literal

from pydantic import BaseModel
from pydantic import Field


class SummaryCard(BaseModel):
    type: Literal["summary"]
    title: str
    content: str | None = None
    key_points: list[str] | None = None


class LegalBasisCard(BaseModel):
    type: Literal["legal_basis"]
    law: str
    article: str | None = None
    section: str | None = None
    summary: str | None = None
    original_text: str | None = None


GridCard = SummaryCard | LegalBasisCard


def validate_cards(raw: list[dict]) -> list[dict]:
    """Validate a list of raw card dicts and return the validated dicts."""
    return [GridCard.model_validate(item).model_dump(exclude_none=True) for item in raw]
```

- [ ] **Step 3: Write `frontends/ui/src/shared/cards/schemas.ts`**

```typescript
import { z } from 'zod'

export const summaryCardSchema = z.object({
  type: z.literal('summary'),
  title: z.string().min(1),
  content: z.string().optional(),
  key_points: z.array(z.string()).optional(),
})

export const legalBasisCardSchema = z.object({
  type: z.literal('legal_basis'),
  law: z.string().min(1),
  article: z.string().optional(),
  section: z.string().optional(),
  summary: z.string().optional(),
  original_text: z.string().optional(),
})

export const gridCardSchema = z.discriminatedUnion('type', [
  summaryCardSchema,
  legalBasisCardSchema,
])

export type GridCard = z.infer<typeof gridCardSchema>

export function validateGridCards(raw: unknown): GridCard[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => gridCardSchema.safeParse(item))
    .filter((result): result is { success: true; data: GridCard } => result.success)
    .map((result) => result.data)
}
```

- [ ] **Step 4: Delete the old parser files**

```bash
git rm frontends/ui/src/features/grid-cards/parser.ts frontends/ui/src/features/grid-cards/parser.spec.ts
```

- [ ] **Step 5: Commit**

```bash
git add shared/cards/schemas.json src/aiq_agent/cards/models.py frontends/ui/src/shared/cards/schemas.ts
git add frontends/ui/src/features/grid-cards/parser.ts frontends/ui/src/features/grid-cards/parser.spec.ts
git commit -s -m "feat: add shared Grid card schemas and remove tag parser"
```

---

## Task 2: Backend `grid_card_generator` source package

**Files:**
- Create: `sources/grid_cards/pyproject.toml`
- Create: `sources/grid_cards/README.md`
- Create: `sources/grid_cards/src/__init__.py`
- Create: `sources/grid_cards/src/register.py`

- [ ] **Step 1: Write `sources/grid_cards/pyproject.toml`**

```toml
[build-system]
build-backend = "setuptools.build_meta"
requires = ["setuptools >= 64", "setuptools-scm>=8"]

[tool.setuptools]
packages = ["grid_cards"]
package-dir = {"grid_cards" = "src"}

[project]
name = "grid-cards"
version = "0.1.0"
description = "Grid response card generator for the AI-Q agent"
readme = "README.md"
requires-python = ">=3.11,<3.14"
license = {text = "Apache-2.0"}
dependencies = [
    "pydantic>=2.0.0",
]

[project.entry-points."nat.plugins"]
grid_cards = "grid_cards.register"
```

- [ ] **Step 2: Write `sources/grid_cards/src/__init__.py`**

```python
try:
    from .register import GridCardGeneratorConfig
    from .register import grid_card_generator

    __all__ = ["GridCardGeneratorConfig", "grid_card_generator"]
except ImportError:
    __all__ = []
```

- [ ] **Step 3: Write `sources/grid_cards/src/register.py`**

```python
# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Grid response card generator tool."""

import json
import logging

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

from aiq_agent.cards.models import GridCard
from aiq_agent.cards.models import validate_cards

logger = logging.getLogger(__name__)


class GridCardGeneratorConfig(FunctionBaseConfig, name="grid_card_generator"):
    """Generate structured Grid response cards from a research context."""

    model: str = "kimi-for-coding"
    max_tokens: int = 2048


@register_function(config_type=GridCardGeneratorConfig)
async def grid_card_generator(tool_config: GridCardGeneratorConfig, builder: Builder):
    async def _generate_cards(query: str, research_context: str) -> str:
        """Generate a JSON array of Grid response cards for the given query and context.

        Args:
            query: The user's original question.
            research_context: The research context / answer text gathered so far.

        Returns:
            A JSON string containing a list of Grid cards (summary and/or legal_basis).
        """
        from langchain_core.messages import HumanMessage
        from langchain_core.messages import SystemMessage

        # Use the builder's LLM if available, otherwise fall back to a direct openai client.
        llm = builder.get_llm(tool_config.model)

        schema = GridCard.model_json_schema()
        system_prompt = (
            "You are a structured-output assistant. Given a user question and research context, "
            "produce a JSON array of Grid response cards. Allowed card types are:\n"
            "- summary: {type: 'summary', title: string, content?: string, key_points?: string[]}\n"
            "- legal_basis: {type: 'legal_basis', law: string, article?: string, section?: string, summary?: string, original_text?: string}\n"
            "Only include cards when they add value. Do not invent references.\n"
            f"JSON Schema: {json.dumps(schema, indent=2)}\n"
            "Respond ONLY with a JSON array."
        )

        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=f"Question: {query}\n\nResearch context:\n{research_context}"),
        ]

        try:
            response = await llm.ainvoke(messages)
            raw_text = response.content if hasattr(response, "content") else str(response)
            raw_text = raw_text.strip()
            if raw_text.startswith("```"):
                raw_text = raw_text.split("\n", 1)[-1].rsplit("\n```", 1)[0].strip()
            parsed = json.loads(raw_text)
            if not isinstance(parsed, list):
                parsed = [parsed]
            validated = validate_cards(parsed)
            return json.dumps(validated, ensure_ascii=False)
        except Exception as e:
            logger.exception("Failed to generate Grid cards")
            return json.dumps({"error": str(e)})

    yield FunctionInfo.from_fn(
        _generate_cards,
        description=_generate_cards.__doc__,
    )
```

- [ ] **Step 4: Install the package**

```bash
uv pip install -e sources/grid_cards
```

- [ ] **Step 5: Commit**

```bash
git add sources/grid_cards
git commit -s -m "feat: add grid_card_generator source package"
```

---

## Task 3: Wire card generation into the chat researcher graph

**Files:**
- Modify: `src/aiq_agent/agents/chat_researcher/models/state.py`
- Modify: `src/aiq_agent/agents/chat_researcher/agent.py`

- [ ] **Step 1: Add `cards` to `ChatResearcherState`**

In `src/aiq_agent/agents/chat_researcher/models/state.py`, add:

```python
class ChatResearcherState(BaseModel):
    # ... existing fields ...
    cards: list[dict[str, Any]] | None = None
```

- [ ] **Step 2: Add a `card_generator` node in `agent.py`**

Near the other node functions, add:

```python
        async def card_generator_node(state: ChatResearcherState) -> dict[str, Any]:
            """Generate structured response cards from the final research context."""
            query = state.original_query or get_latest_user_query(state.messages)
            if not query:
                return {"cards": None}

            # Gather the last assistant message as research context.
            context = ""
            for m in reversed(state.messages):
                if isinstance(m, AIMessage) and not m.tool_calls:
                    content = m.content if isinstance(m.content, str) else str(m.content)
                    context = content
                    break

            if not context:
                return {"cards": None}

            try:
                from grid_cards.register import grid_card_generator
                from aiq_agent.cards.models import validate_cards
                import json

                # We call the generator directly using a fresh Builder/LLM instance
                # matching the workflow LLM. For simplicity, use the builder from the
                # agent instance if available; otherwise fall back to the configured
                # reasoning LLM.
                llm = self.shallow_research_agent.llm if self.shallow_research_agent else None
                if llm is None:
                    return {"cards": None}

                schema = GridCard.model_json_schema()
                prompt = (
                    "You are a structured-output assistant. Given a user question and research context, "
                    "produce a JSON array of Grid response cards. Allowed card types are:\n"
                    "- summary: {type: 'summary', title: string, content?: string, key_points?: string[]}\n"
                    "- legal_basis: {type: 'legal_basis', law: string, article?: string, section?: string, summary?: string, original_text?: string}\n"
                    "Only include cards when they add value. Do not invent references.\n"
                    f"JSON Schema: {json.dumps(schema, indent=2)}\n"
                    "Respond ONLY with a JSON array."
                )
                from langchain_core.messages import HumanMessage, SystemMessage
                messages = [
                    SystemMessage(content=prompt),
                    HumanMessage(content=f"Question: {query}\n\nResearch context:\n{context}"),
                ]
                response = await llm.ainvoke(messages)
                raw_text = response.content if hasattr(response, "content") else str(response)
                raw_text = raw_text.strip()
                if raw_text.startswith("```"):
                    raw_text = raw_text.split("\n", 1)[-1].rsplit("\n```", 1)[0].strip()
                parsed = json.loads(raw_text)
                if not isinstance(parsed, list):
                    parsed = [parsed]
                cards = validate_cards(parsed)
                return {"cards": cards}
            except Exception as e:
                logger.exception("Card generation failed: %s", e)
                return {"cards": None}
```

Also add imports at the top of `agent.py`:

```python
import json
from aiq_agent.cards.models import GridCard
from aiq_agent.cards.models import validate_cards
```

- [ ] **Step 3: Add the node to the graph and edges**

After the existing node definitions, add:

```python
graph.add_node("card_generator", card_generator_node)
```

Change the edges so that `shallow_research` and `deep_research` both route to `card_generator`, and `card_generator` routes to `END`:

```python
graph.add_edge("shallow_research", "card_generator")
graph.add_edge("deep_research", "card_generator")
graph.add_edge("card_generator", END)
```

If the existing conditional edge from `shallow_research` to `deep_research`/`END` is present, remove it or route `END` to `card_generator`. The simplest design is to always run the card generator after research; it returns no cards if context is missing.

- [ ] **Step 4: Run lint and tests**

```bash
uv run ruff check src/aiq_agent/agents/chat_researcher
uv run pytest tests/ -q -k chat_researcher --tb=short
```

Expected: lint passes; existing chat researcher tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/aiq_agent/agents/chat_researcher/models/state.py src/aiq_agent/agents/chat_researcher/agent.py
git commit -s -m "feat: generate Grid cards in chat researcher graph"
```

---

## Task 4: Attach cards to the WebSocket response message

**Files:**
- Modify: `frontends/aiq_api/src/aiq_api/websocket_reconnect.py`

- [ ] **Step 1: Find where the final workflow result is converted to a response message**

In `websocket_reconnect.py`, locate `_run_workflow` and the call to `create_websocket_message` that emits the final `RESPONSE_MESSAGE`. Identify the variable holding the workflow result (likely `result` or `final_state`).

- [ ] **Step 2: Patch the final response message to include `cards`**

After the final response message is created and before it is sent, add:

```python
if isinstance(message, WebSocketSystemResponseTokenMessage):
    cards = getattr(final_state, "cards", None) or final_state.get("cards")
    if cards:
        try:
            message.cards = cards
        except Exception:
            logger.warning("Could not attach cards to websocket message", exc_info=True)
```

Replace `final_state` with the actual variable name from the code.

- [ ] **Step 3: Commit**

```bash
git add frontends/aiq_api/src/aiq_api/websocket_reconnect.py
git commit -s -m "feat: attach Grid cards to final websocket response"
```

---

## Task 5: Frontend consumes the `cards` field

**Files:**
- Modify: `frontends/ui/src/features/chat/types.ts`
- Modify: `frontends/ui/src/features/chat/components/AgentResponse.tsx`
- Modify: `frontends/ui/src/features/chat/store.ts` (or message handling logic) to persist `cards`
- Modify: `frontends/ui/src/features/grid-cards/types.ts` (replace content with re-exports from shared schemas)
- Modify: `frontends/ui/src/features/grid-cards/components/GridCards.tsx`

- [ ] **Step 1: Add `cards` to `ChatMessage` in `frontends/ui/src/features/chat/types.ts`**

```typescript
import type { GridCard } from '@/shared/cards/schemas'

export interface ChatMessage {
  // ... existing fields ...
  cards?: GridCard[]
}
```

- [ ] **Step 2: Update message receiving logic to read `cards`**

Find where incoming WebSocket `RESPONSE_MESSAGE` events are parsed (likely in `frontends/ui/src/features/chat/hooks/use-chat.ts` or a NAT client). When a message has `cards`, add them to the chat message:

```typescript
if (message.type === 'RESPONSE_MESSAGE' || message.type === 'response') {
  const cards = Array.isArray(message.cards) ? validateGridCards(message.cards) : []
  // When appending/completing the assistant message, include cards.
}
```

The exact variable names depend on the existing NAT client; inspect the code and adapt.

- [ ] **Step 3: Update `AgentResponse.tsx` to render cards from the message**

Replace the `parseGridCards` usage with:

```typescript
import { GridCards } from '@/features/grid-cards/components/GridCards'

// inside component:
const cards = message.cards ?? []
```

Render the cards before the markdown:

```tsx
{cards.length > 0 && (
  <GridCards cards={cards} />
)}
<MarkdownRenderer content={content} />
```

- [ ] **Step 4: Replace `frontends/ui/src/features/grid-cards/types.ts`**

```typescript
export {
  gridCardSchema,
  legalBasisCardSchema,
  summaryCardSchema,
  type GridCard,
  type LegalBasisCardData,
  type SummaryCardData,
  validateGridCards,
} from '@/shared/cards/schemas'
```

- [ ] **Step 5: Update `GridCards.tsx` to use the shared types**

Ensure the component imports `GridCard` from `@/shared/cards/schemas` or `@/features/grid-cards/types`.

- [ ] **Step 6: Run frontend checks**

```bash
cd frontends/ui
npm run lint
npm run type-check
npm run test:ci
```

Expected: lint and type-check pass; existing tests pass (locale failures are pre-existing).

- [ ] **Step 7: Commit**

```bash
git add frontends/ui/src/features/chat/types.ts frontends/ui/src/features/chat/components/AgentResponse.tsx frontends/ui/src/features/chat/store.ts frontends/ui/src/features/grid-cards/types.ts frontends/ui/src/features/grid-cards/components/GridCards.tsx
git commit -s -m "feat: render Grid cards from websocket cards field"
```

---

## Task 6: Fix the topic guardrail scope

**Files:**
- Modify: `src/aiq_agent/agents/chat_researcher/prompts/intent_classification.j2`

- [ ] **Step 1: Update the prompt**

Replace the relevant lines with:

```jinja2
### STEP 1: INTENT CLASSIFICATION
Classify the query as "meta" or "research".
- **meta**: System identity, abilities, greetings, time/date, tool questions, emotional check-ins, jokes, casual chat, small talk, out-of-scope requests (code/files), OR any question that is NOT about the Austria-specific building/regulatory domain.
- **research**: Questions about Austrian building regulations, OIB Richtlinien, Bauordnung, Baurecht, planning law, energy/technical standards, fire safety, accessibility, and other regulatory/architectural topics relevant to architects working in Austria.
- **Rule**: If a query is mixed or you are unsure, choose "research".
```

And in the META branch:

```jinja2
3. **Out-of-Scope / Topic Guardrail**: If the query is not about the Austria-specific building/regulatory domain, politely decline and explain that you can only help with Austrian building regulations and related architectural-technical topics. Do not answer the off-topic question.
```

- [ ] **Step 2: Run lint/tests**

```bash
uv run ruff check src/aiq_agent/agents/chat_researcher
uv run pytest tests/ -q -k chat_researcher --tb=short
```

- [ ] **Step 3: Commit**

```bash
git add src/aiq_agent/agents/chat_researcher/prompts/intent_classification.j2
git commit -s -m "fix: correct guardrail to Austria-specific building/regulatory domain"
```

---

# Phase 5: VS Code dev container + Docker Compose validation

## Task 7: Add VS Code dev container configuration

**Files:**
- Create: `.devcontainer/devcontainer.json`
- Create: `.devcontainer/Dockerfile` (or reuse existing)
- Modify: `deploy/Dockerfile` to install Node and source packages

- [ ] **Step 1: Update `deploy/Dockerfile` dev target to include source packages and Node**

Find the `dev` target (after `release`) in `deploy/Dockerfile`. Ensure it installs:

```dockerfile
# In the dev target, also install the Grid source packages
RUN uv pip install --no-deps -e ./sources/oib_knowledge \
    && uv pip install --no-deps -e ./sources/grid_cards

# Install Node.js for frontend development
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Create `.devcontainer/devcontainer.json`**

```json
{
  "name": "Grid OIB Agent Dev Container",
  "build": {
    "dockerfile": "Dockerfile",
    "context": "..",
    "target": "dev"
  },
  "workspaceFolder": "/app",
  "workspaceMount": "source=${localWorkspaceFolder},target=/app,type=bind,consistency=cached",
  "forwardPorts": [3000, 8000, 5432],
  "portsAttributes": {
    "3000": { "label": "Next.js UI" },
    "8000": { "label": "AI-Q Backend" },
    "5432": { "label": "PostgreSQL" }
  },
  "postCreateCommand": "uv pip install -e sources/oib_knowledge -e sources/grid_cards -e sources/knowledge_layer[all] -e . && cd frontends/ui && npm install",
  "postStartCommand": "git config --global --add safe.directory /app",
  "customizations": {
    "vscode": {
      "extensions": [
        "dbaeumer.vscode-eslint",
        "esbenp.prettier-vscode",
        "bradlc.vscode-tailwindcss",
        "ms-python.python",
        "ms-python.ruff",
        "charliermarsh.ruff",
        "ms-vscode.vscode-typescript-next"
      ],
      "settings": {
        "python.defaultInterpreterPath": "/app/.venv/bin/python",
        "python.analysis.typeCheckingMode": "basic",
        "eslint.workingDirectories": ["frontends/ui"],
        "terminal.integrated.defaultProfile.linux": "bash"
      }
    }
  },
  "features": {
    "ghcr.io/devcontainers/features/git:1": {}
  },
  "remoteUser": "root"
}
```

- [ ] **Step 3: Create `.devcontainer/Dockerfile`** (if you prefer a separate file)

```dockerfile
# Build the dev target of the project's main Dockerfile
FROM deploy/Dockerfile AS dev
```

Actually, Dev Containers does not support `FROM` a local Dockerfile path as a stage reference easily. Instead, in `devcontainer.json` reference the main Dockerfile directly with `target: "dev"` as shown in Step 2. Then skip creating `.devcontainer/Dockerfile`.

- [ ] **Step 4: Add `.devcontainer` to `.gitignore` if not desired in repo**

Keep `.devcontainer/` committed because the user asked for it. Do not add to `.gitignore`.

- [ ] **Step 5: Commit**

```bash
git add .devcontainer deploy/Dockerfile
git commit -s -m "feat: add VS Code dev container configuration"
```

---

## Task 8: Validate Docker Compose

**Files:**
- Modify: `deploy/compose/docker-compose.yaml` if validation reveals issues

- [ ] **Step 1: Validate compose syntax**

```bash
docker compose -f deploy/compose/docker-compose.yaml config
```

If Docker is unavailable, at least run:

```bash
docker compose -f deploy/compose/docker-compose.yaml config
```

Expected: either a valid compose dump or a clear error. If the error is environmental (Docker daemon not running), note it in the task result.

- [ ] **Step 2: Fix any reported issues**

Common issues to fix:
- Ensure `BACKEND_CONFIG` env default points to `/app/configs/config_grid_oib.yml`.
- Ensure `data/oib` volume path exists or is marked optional.
- Ensure the `frontend` service build context points to `../../frontends/ui` and Dockerfile to `deploy/Dockerfile`.

- [ ] **Step 3: Add a `README.md` note for dev container usage**

Append to `AGENTS.md` or `README.md`:

```markdown
## VS Code Dev Container

Open the project in VS Code with the Dev Containers extension. The container builds the `dev` target of `deploy/Dockerfile`, mounts the workspace, and forwards ports 3000, 8000, and 5432.
```

- [ ] **Step 4: Commit**

```bash
git add deploy/compose/docker-compose.yaml README.md AGENTS.md
git commit -s -m "chore: validate Docker Compose and document dev container"
```

---

## Task 9: Final integration verification

- [ ] **Step 1: Run full backend lint**

```bash
uv run ruff check src/aiq_agent sources/oib_knowledge sources/grid_cards frontends/aiq_api scripts/ingest_oib.py
```

- [ ] **Step 2: Run full frontend lint + type-check**

```bash
cd frontends/ui
npm run lint
npm run type-check
```

- [ ] **Step 3: If possible, start the backend with the new config**

```bash
uv run nat serve --config_file configs/config_grid_oib.yml --port 8000
```

Expected: server starts and registers `oib_knowledge_search` and `grid_card_generator`.

- [ ] **Step 4: Mark phases complete**

Update the parent TodoWrite: Phase 4 and Phase 5 complete.
