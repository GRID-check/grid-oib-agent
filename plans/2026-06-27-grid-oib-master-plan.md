# Grid OIB Agent — Master Plan and Current Status

**Scope:** Finish the Grid-branded AI-Q agent MVP so it can answer Austria-specific building-regulation questions from the local OIB knowledge base and return structured response cards (Summary, Legal Basis) through a real backend-frontend contract.

**Working tree:** `D:\Personal\GRID\gridAgent\.worktrees\aiq\aiq`

**Current branch:** Grid OIB MVP worktree

---

## 1. What is already done

| Phase | Commit | What it contains |
|-------|--------|------------------|
| Phase 1: Cleanup | `acdac55` | Removed NVIDIA/template files, trimmed GitHub/Helm/Sphinx docs, rewrote README, AGENTS.md, compose defaults. |
| Phase 2: OIB backend | `ea6617e` | `scripts/ingest_oib.py`, `POST /v1/admin/oib/sync`, `sources/oib_knowledge/`, `configs/config_grid_oib.yml`, topic guardrail, writer card instruction. |
| Phase 3: Frontend reskin | `587ca8cb` | Grid theme, removed NVIDIA branding, Summary/LegalBasis card components + tag parser. |
| Phase 4: Shared cards + backend generator | `3b68e38` | `shared/cards/schemas.json`, `src/aiq_agent/cards/`, `sources/grid_cards/`, `ChatResearcherAgent.run()` card generation, registry/websocket plumbing. |
| Phase 5: Dev container | `3b68e38` (same) | `.devcontainer/devcontainer.json`, Dockerfile target updates, compose validation. |
| OIB PDFs in repo | `0b59baf` | 39 OIB PDFs tracked by Git LFS. |

### Architecture at this point

- **Knowledge:** 39 OIB PDFs in `data/oib/`. Incremental sync via `scripts/ingest_oib.py` (SHA-256 registry in `data/oib_registry.json`) or `POST /v1/admin/oib/sync`. Stored in ChromaDB collection `oib_knowledge` with NVIDIA embeddings.
- **Retrieval:** `oib_knowledge_search` NAT tool targets the persistent collection.
- **Cards:** `grid_card_generator` NAT tool produces validated card JSON from a dynamic prompt built from `shared/cards/schemas.json`. Cards are generated in `ChatResearcherAgent.run()` post-processing, stored in an in-memory registry keyed by conversation ID, and attached to the final WebSocket `RESPONSE_MESSAGE`.
- **Guardrails:** `intent_classification.j2` restricts the agent to the Austria-specific building/regulatory domain.
- **UI:** Grid-branded Next.js app with Summary/LegalBasis card components.
- **Dev experience:** VS Code dev container configuration, Docker Compose defaults point to `config_grid_oib.yml`.

---

## 2. What is NOT done / needs to be finished cleanly

### 2.1 Frontend consumes the WebSocket `cards` field

**Problem:** Phase 3 shipped a tag parser (`<grid_cards>`). Phase 4 moved cards to a real WebSocket field, but the UI still renders from tags and has partial, uncommitted edits in:
- `frontends/ui/src/adapters/api/schemas.ts`
- `frontends/ui/src/adapters/api/websocket-client.ts`
- `frontends/ui/src/features/chat/hooks/use-websocket-chat.ts`

**Required outcome:**
- `ChatMessage` has a typed `cards?: GridCard[]` field.
- The WebSocket schema/client carry an optional `cards` array.
- Store actions (`addAgentResponse`, `addAgentResponseWithMeta`) accept and persist `cards`.
- `AgentResponse` accepts a `cards` prop and renders `GridCards` from it.
- `ChatArea` passes `cards={message.cards}`.
- The old `parseGridCards` and tag-parsing code are removed.
- Tests are updated or added; `npm run lint`, `npm run type-check`, and relevant tests pass.

**Implementation approach (already started):**
1. Extend `NATSystemResponseMessageSchema` with `cards: z.array(z.unknown()).optional()`.
2. Update `websocket-client.ts` `onResponse` signature to include `cards?: unknown[]`.
3. Update `use-websocket-chat.ts` to validate cards with `validateGridCards` and pass them to the store.
4. Update `store.ts` `ChatActions` and `addAgentResponse*` to accept/persist `cards`.
5. Update `types.ts` `ChatMessage` and action signatures.
6. Refactor `AgentResponse.tsx` to use the `cards` prop.
7. Update `ChatArea.tsx` to pass the prop.
8. Remove the tag parser file/export.
9. Update affected tests.

### 2.2 Clean up the in-memory card registry

**Problem:** Cards currently pass from `ChatResearcherAgent.run()` to the WebSocket handler through a module-level in-memory registry (`src/aiq_agent/cards/registry.py`). This is simple but brittle and not testable.

**Required outcome:** A cleaner contract. Two recommended options:

- **Option A (recommended):** Return cards as part of the workflow result / `ChatResponse` extras so the WebSocket handler reads them directly from the response object, not a side registry.
- **Option B:** Keep a registry but make it an explicit dependency (e.g., `ConversationCardStore`) injected into the agent and the handler.

Decision needed from the team. If no decision, default to Option A.

### 2.3 Backend tests for card generation

**Problem:** No unit tests cover `build_card_generation_prompt`, `validate_cards`, or the post-run card generation in `ChatResearcherAgent.run()`.

**Required outcome:**
- Tests in `tests/aiq_agent/cards/` for prompt building and validation.
- A test that mocks the LLM and verifies `ChatResearcherAgent.run()` attaches cards to the registry/result.

### 2.4 End-to-end integration test

**Problem:** Runtime `nat serve` has been blocked by disk-space errors in this environment, so the full chat->cards flow has never been exercised.

**Required outcome:**
- Start the backend with `configs/config_grid_oib.yml`.
- Trigger ingestion (or use a pre-populated test collection).
- Send a chat message and verify the WebSocket response contains `cards` with valid schema.
- If the local environment still lacks disk space, document the exact blocker and provide the manual test steps.

### 2.5 Documentation refresh

**Problem:** README/AGENTS.md still say `data/oib/` is not committed, but the PDFs are now tracked by LFS. Dev container usage is not documented.

**Required outcome:**
- Update README to explain Git LFS, where PDFs live, and how to trigger sync.
- Add a dev-container section to README or AGENTS.md.
- Ensure `.gitattributes` is present and `data/oib/**/*.pdf` is tracked by LFS.

### 2.6 Verify compose / dev container build

**Problem:** Compose config validation passed after setting `BACKEND_CONFIG`, but a real `docker compose build` / dev container build has not been run.

**Required outcome:**
- `docker compose -f deploy/compose/docker-compose.yaml build` succeeds.
- Dev container opens without errors and can run `npm run dev` / `uv run nat serve`.

---

## 3. Proposed task order (do not deviate without a reason)

1. **Stop and stabilize.** Revert or finish the partial frontend `cards` field edits so the working tree is clean and the UI at least compiles.
2. **Clean card transport.** Replace the in-memory registry with a first-class response-field contract (Option A above).
3. **Frontend card field integration.** Complete the websocket/store/AgentResponse/ChatArea changes and remove the tag parser.
4. **Backend card tests.** Add tests for cards models/prompt and agent post-run behavior.
5. **Integration test.** Try to run `nat serve` + UI chat; document blockers if environment prevents it.
6. **Documentation.** Update README/AGENTS.md for LFS, PDFs, dev container.
7. **Compose/dev container build check.** Run a real build if Docker is available.
8. **Final review and finishing-a-development-branch.**

---

## 4. Immediate decisions needed

1. **Card transport:** Keep the in-memory registry or move cards through `ChatResponse` extras?
2. **Frontend card source:** Do we keep the tag parser as a fallback while the websocket field is being rolled out, or remove it now?
3. **Scope for this branch:** Do we include the RIS OGD live-search source now, or defer to a follow-up branch?

---

## 5. Risks and blockers

- **Disk space:** The local worktree ran out of disk during `nat serve` and pytest. This may prevent full integration testing here.
- **LLM costs:** Card generation makes an extra LLM call per chat turn. Monitor token usage.
- **CRLF/LFS:** Windows worktree plus LFS can produce surprising diffs; always verify `git diff --stat` before committing.

---

## 6. Verification checklist before calling the MVP done

- [ ] `uv run ruff check src/aiq_agent sources/oib_knowledge sources/grid_cards frontends/aiq_api scripts/ingest_oib.py` passes.
- [ ] `uv run pytest tests/aiq_agent/cards tests/aiq_agent/agents/chat_researcher -q --tb=short` passes.
- [ ] `npm run lint` and `npm run type-check` in `frontends/ui` pass.
- [ ] Tag parser removed; UI renders cards from `message.cards`.
- [ ] `configs/config_grid_oib.yml` loads and registers both `oib_knowledge_search` and `grid_card_generator`.
- [ ] `POST /v1/admin/oib/sync` works (or documented why it cannot be tested locally).
- [ ] A chat prompt returns a response with valid `cards` array.
- [ ] README/AGENTS.md are accurate.
- [ ] `docker compose -f deploy/compose/docker-compose.yaml build` succeeds (or documented blocker).
