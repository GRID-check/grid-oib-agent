# Project Context Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build durable project context intake so Grid stores project facts in Postgres, exposes profile APIs, injects compact context into AI-Q prompts, and supports confirmed profile patch cards.

**Architecture:** The BFF owns authorization, canonical profile persistence, deterministic prompt-view formatting, and UI projections. Python AI-Q receives only the compact `project_context` string and threads it through state and prompt rendering. The shared Grid card pipeline remains backend-Pydantic first, then generated JSON schema/Zod, then typed React rendering.

**Tech Stack:** Next.js App Router, Drizzle/PostgreSQL, Zod, React, Vitest, Python 3.11, Pydantic, LangGraph/DeepAgents, Jinja2 prompt templates, pytest, Ruff.

---

## Current Constraints

- Work in the existing worktree. Do not create a git worktree.
- The worktree has many unrelated dirty changes. Read files before editing and do not revert unrelated edits.
- Do not commit. The user asked for implementation with subagents, not commits.
- Use minimal, phased implementation. Avoid arbitrary AI-generated UI.
- Prefer deterministic server-side projection generation for v1. The AI-generated UI display summary can be added later behind the same BFF fields.

## File Structure

### BFF Profile Persistence

- Modify `frontends/ui/src/lib/db/schema/projects.ts`: add JSONB/text/timestamp profile columns to Drizzle schema.
- Create `frontends/ui/drizzle/0004_project_profile_context.sql`: add the corresponding database columns.
- Update `frontends/ui/drizzle/meta/_journal.json`: append migration metadata for index 4.
- Create `frontends/ui/src/lib/project-profile/types.ts`: Zod schemas and TS types for canonical profile, display projection, highlights, and patch operations.
- Create `frontends/ui/src/lib/project-profile/prompt-view.ts`: deterministic compact `PROJECT_CONTEXT v1` formatter and display projection builder.
- Create `frontends/ui/src/lib/project-profile/intake-definition.ts`: v1 schema-driven intake definition seeded from the business mockdown.
- Create `frontends/ui/src/app/api/projects/[id]/profile/route.ts`: `GET` and `PUT` profile API.
- Create `frontends/ui/src/app/api/projects/[id]/profile/patches/route.ts`: accepts safe confirmed profile patch operations.
- Create `frontends/ui/src/app/api/projects/[id]/intake-definition/route.ts`: returns the v1 intake definition.
- Modify `frontends/ui/src/app/api/chat/route.ts`: load authorized project profile prompt view and forward it to backend via `X-Grid-Project-Context` for REST chat.
- Modify `frontends/ui/src/app/api/auth/websocket-scope/route.ts`: return `projectContext` for WebSocket handshake lookup.
- Modify `frontends/ui/server.js`: forward `x-grid-project-context` to Python backend during WebSocket upgrades.

### Python AI-Q Context Plumbing

- Create `src/aiq_agent/project_context.py`: read `X-Grid-Project-Context` from NAT/LangGraph context metadata and normalize it.
- Modify `src/aiq_agent/agents/chat_researcher/models/state.py`: add `project_context: str | None`.
- Modify `src/aiq_agent/agents/shallow_researcher/models/state.py`: add `project_context: str | None`.
- Modify `src/aiq_agent/agents/deep_researcher/models/state.py`: add `project_context: str | None`.
- Modify `src/aiq_agent/agents/chat_researcher/agent.py`: preserve `project_context` across graph invocations and pass it into shallow/deep states.
- Modify `src/aiq_agent/agents/chat_researcher/nodes/intent_classifier.py`: pass `project_context` into Jinja rendering.
- Modify `src/aiq_agent/agents/shallow_researcher/agent.py`: pass `project_context` into Jinja rendering.
- Modify `src/aiq_agent/agents/deep_researcher/factory.py`: pass `project_context` to all deep prompt renderings.
- Modify relevant prompt templates:
  - `src/aiq_agent/agents/chat_researcher/prompts/intent_classification.j2`
  - `src/aiq_agent/agents/shallow_researcher/prompts/researcher.j2`
  - `src/aiq_agent/agents/deep_researcher/prompts/orchestrator.j2`
  - `src/aiq_agent/agents/deep_researcher/prompts/planner.j2`
  - `src/aiq_agent/agents/deep_researcher/prompts/researcher.j2`
  - `src/aiq_agent/agents/deep_researcher/prompts/writer.j2`
  - `src/aiq_agent/agents/deep_researcher/prompts/source_router.j2`

### Profile Patch Cards

- Modify `src/aiq_agent/cards/models.py`: add `ProjectProfilePatchCard` and safe patch operation models to discriminated union.
- Regenerate `shared/cards/schemas.json` with `uv run python scripts/generate_card_schema.py`.
- Regenerate `frontends/ui/src/shared/cards/generated.ts` with `npm run generate:cards` in `frontends/ui`.
- Create `frontends/ui/src/features/grid-cards/components/ProjectProfilePatchCard.tsx`: render patch preview plus accept/reject controls.
- Modify `frontends/ui/src/features/grid-cards/components/GridCards.tsx`: dispatch `project_profile_patch` cards.

### Tests

- Add `frontends/ui/src/lib/project-profile/prompt-view.test.ts`: formatter, display projection, and patch validation tests.
- Add `tests/aiq_agent/project_context/test_header_context.py`: header extraction/normalization tests.
- Update `tests/aiq_agent/cards/test_models.py`: profile patch card validation tests.
- Update `tests/aiq_agent/cards/test_schema_sync.py`: generated schema sync includes the new card.
- Add focused agent state/prompt tests where existing test patterns allow.

---

## Task 1: BFF Durable Project Profile Core

**Files:**
- Modify: `frontends/ui/src/lib/db/schema/projects.ts`
- Create: `frontends/ui/drizzle/0004_project_profile_context.sql`
- Modify: `frontends/ui/drizzle/meta/_journal.json`
- Create: `frontends/ui/src/lib/project-profile/types.ts`
- Create: `frontends/ui/src/lib/project-profile/prompt-view.ts`
- Create: `frontends/ui/src/lib/project-profile/prompt-view.test.ts`

- [ ] **Step 1: Add failing formatter tests**

Create `frontends/ui/src/lib/project-profile/prompt-view.test.ts` with tests that assert:

```ts
import { describe, expect, it } from 'vitest'
import { applyProjectProfilePatch, buildProjectProfileDisplay, buildProjectPromptView } from './prompt-view'
import type { ProjectProfile } from './types'

describe('project profile prompt view', () => {
  const profile: ProjectProfile = {
    facts: {
      use: { value: 'beherbergung', confidence: 'confirmed', source: 'onboarding', updatedAt: '2026-07-02T00:00:00.000Z' },
      floors_above: { value: 5, confidence: 'confirmed', source: 'onboarding', updatedAt: '2026-07-02T00:00:00.000Z' },
      protected_zone: { value: true, confidence: 'confirmed', source: 'onboarding', updatedAt: '2026-07-02T00:00:00.000Z' },
    },
    goals: { primary: 'check_oib_requirements' },
    unknowns: ['building_class'],
    assumptions: {},
  }

  it('renders compact deterministic PROJECT_CONTEXT v1 text', () => {
    expect(buildProjectPromptView(profile)).toBe([
      'PROJECT_CONTEXT v1',
      'confirmed:',
      '- floors_above=5',
      '- protected_zone=true',
      '- use=beherbergung',
      '',
      'goals:',
      '- primary=check_oib_requirements',
      '',
      'unknown:',
      '- building_class',
    ].join('\n'))
  })

  it('builds a stored display projection without calling AI-Q', () => {
    const display = buildProjectProfileDisplay(profile)
    expect(display.keyFacts).toEqual([
      { label: 'floors above', value: '5' },
      { label: 'protected zone', value: 'Yes' },
      { label: 'use', value: 'beherbergung' },
    ])
    expect(display.missingInfo).toEqual(['building_class'])
  })

  it('applies safe add and replace patches only under profile paths', () => {
    const patched = applyProjectProfilePatch(profile, [
      { op: 'replace', path: '/facts/protected_zone/value', value: false },
      { op: 'add', path: '/unknowns/-', value: 'fire_compartment_strategy' },
    ])
    expect(patched.facts.protected_zone?.value).toBe(false)
    expect(patched.unknowns).toContain('fire_compartment_strategy')
    expect(() => applyProjectProfilePatch(profile, [{ op: 'add', path: '/name', value: 'bad' }])).toThrow(/Unsafe/)
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

Run from `frontends/ui`: `npm run test -- src/lib/project-profile/prompt-view.test.ts`

Expected: FAIL because files/functions do not exist.

- [ ] **Step 3: Implement profile schemas and deterministic projections**

Create `types.ts` with Zod schemas for `ProjectProfile`, `ProjectProfileDisplay`, and `ProjectProfilePatchOperation`. Use `z.record(z.string(), ...)` for facts/goals/assumptions and a strict safe patch path regex allowing only `/facts`, `/goals`, `/unknowns`, and `/assumptions`.

Create `prompt-view.ts` with:

```ts
export function buildProjectPromptView(profile: ProjectProfile): string
export function buildProjectProfileDisplay(profile: ProjectProfile): ProjectProfileDisplay
export function applyProjectProfilePatch(profile: ProjectProfile, patch: ProjectProfilePatchOperation[]): ProjectProfile
```

The formatter must sort keys alphabetically for deterministic output and omit empty sections.

- [ ] **Step 4: Add project DB columns**

Modify Drizzle schema to import `integer` and `jsonb`, then add:

```ts
profile: jsonb('profile').$type<ProjectProfile>().notNull().default({}),
profileVersion: integer('profile_version').notNull().default(1),
profilePromptView: text('profile_prompt_view'),
profileDisplay: jsonb('profile_display').$type<ProjectProfileDisplay>(),
profileHighlights: jsonb('profile_highlights').$type<ProjectProfileDisplay['keyFacts']>(),
profileUpdatedAt: timestamp('profile_updated_at', { withTimezone: true }),
```

Create migration SQL:

```sql
ALTER TABLE "projects" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "profile_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "profile_prompt_view" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "profile_display" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "profile_highlights" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "profile_updated_at" timestamp with time zone;
```

Append journal entry index 4 with tag `0004_project_profile_context`.

- [ ] **Step 5: Run narrow verification**

Run from `frontends/ui`:

```bash
npm run test -- src/lib/project-profile/prompt-view.test.ts
npm run type-check
```

Expected: profile tests pass; type-check exits 0 or reports only pre-existing unrelated errors. Capture exact output.

---

## Task 2: BFF Profile APIs And Context Forwarding

**Files:**
- Create: `frontends/ui/src/lib/project-profile/intake-definition.ts`
- Create: `frontends/ui/src/app/api/projects/[id]/profile/route.ts`
- Create: `frontends/ui/src/app/api/projects/[id]/profile/patches/route.ts`
- Create: `frontends/ui/src/app/api/projects/[id]/intake-definition/route.ts`
- Modify: `frontends/ui/src/app/api/chat/route.ts`
- Modify: `frontends/ui/src/app/api/auth/websocket-scope/route.ts`
- Modify: `frontends/ui/server.js`

- [ ] **Step 1: Add API routes**

Implement:

```ts
GET /api/projects/:id/profile        // project:view
PUT /api/projects/:id/profile        // project:edit
POST /api/projects/:id/profile/patches // project:edit
GET /api/projects/:id/intake-definition // project:view
```

Every write must validate with Zod, rebuild `profilePromptView`, `profileDisplay`, `profileHighlights`, increment `profileVersion`, and set `profileUpdatedAt`.

- [ ] **Step 2: Add intake definition**

Create a v1 definition with stages: `core`, `classification`, `building`, `regulatory`, `goals`. Include the business mockdown fields `project_name`, `hauptnutzung`, `anzahlBetten`, `anzahlBewohner`, `verkaufsflaeche`, `versammlungsflaeche`, `sicherheitskategorie`, `widmung`, `gebaeudeklasse`, `bauweise`, `geschosse_oberirdisch`, `geschosse_unterirdisch`, `fluchtniveau`, `grundgrenze`, `fluchtlinie`, `schutzzone`, `abweichender_bebauungsplan`, `bestand_neubau`. Conditions should be simple `{ field, equals }` checks.

- [ ] **Step 3: Forward compact project context to Python**

In REST chat route, after collection scope resolution, if `body.projectId` is present and session/project auth has succeeded through existing scope logic, load `projects.profilePromptView` and set header `X-Grid-Project-Context` only when it is non-empty.

In WebSocket scope route, include `projectContext` in JSON response when project has a prompt view.

In `server.js`, set `req.headers['x-grid-project-context'] = result.data.projectContext` during upgrade when present.

- [ ] **Step 4: Verify**

Run from `frontends/ui`:

```bash
npm run type-check
npm run lint
```

Expected: exits 0 or only pre-existing unrelated diagnostics. Capture exact output.

---

## Task 3: Python AI-Q Project Context Plumbing

**Files:**
- Create: `src/aiq_agent/project_context.py`
- Modify: `src/aiq_agent/agents/chat_researcher/models/state.py`
- Modify: `src/aiq_agent/agents/shallow_researcher/models/state.py`
- Modify: `src/aiq_agent/agents/deep_researcher/models/state.py`
- Modify: `src/aiq_agent/agents/chat_researcher/agent.py`
- Modify: `src/aiq_agent/agents/chat_researcher/nodes/intent_classifier.py`
- Modify: `src/aiq_agent/agents/shallow_researcher/agent.py`
- Modify: `src/aiq_agent/agents/deep_researcher/factory.py`
- Modify prompt templates listed in file structure.
- Add tests under `tests/aiq_agent/project_context/` and update existing model/prompt tests as needed.

- [ ] **Step 1: Write failing Python tests**

Add tests asserting:

```python
def test_normalize_project_context_trims_and_limits_blank_lines(): ...
def test_state_models_accept_project_context(): ...
def test_intent_classifier_prompt_receives_project_context(fake_llm): ...
```

- [ ] **Step 2: Implement header/context utility**

Create `project_context.py` with:

```python
PROJECT_CONTEXT_HEADER = "x-grid-project-context"

def normalize_project_context(value: str | None, *, max_chars: int = 4000) -> str | None:
    ...

def get_project_context_from_context() -> str | None:
    ...
```

Use NAT `Context.get().metadata.headers` defensively like `knowledge/scoping.py`.

- [ ] **Step 3: Thread context through states and agents**

Add `project_context: str | None = None` to all three state models. In `ChatResearcherAgent.run`, preserve it from dict state or model state. In shallow/deep nodes, pass it to child states. In intent/shallow/deep prompt rendering, pass `project_context=state.project_context`.

- [ ] **Step 4: Update prompts**

Add the same compact block below existing user/date/document dynamic context:

```jinja2
{% if project_context %}
## Project Context
<project_context>
{{ project_context }}
</project_context>

Use confirmed project context when interpreting the user's request. Treat unknowns as missing information, not assumptions. Do not invent missing project facts.
{% endif %}
```

- [ ] **Step 5: Verify**

Run:

```bash
uv run pytest tests/aiq_agent/project_context tests/aiq_agent/agents/chat_researcher tests/aiq_agent/agents/shallow_researcher tests/aiq_agent/agents/deep_researcher -q
uv run ruff check src/aiq_agent tests/aiq_agent
```

Expected: targeted tests pass; Ruff exits 0 or reports only pre-existing unrelated diagnostics. Capture exact output.

---

## Task 4: Profile Patch Card Schema And Rendering

**Files:**
- Modify: `src/aiq_agent/cards/models.py`
- Modify generated: `shared/cards/schemas.json`
- Modify generated: `frontends/ui/src/shared/cards/generated.ts`
- Create: `frontends/ui/src/features/grid-cards/components/ProjectProfilePatchCard.tsx`
- Modify: `frontends/ui/src/features/grid-cards/components/GridCards.tsx`
- Update tests: `tests/aiq_agent/cards/test_models.py`, `tests/aiq_agent/cards/test_schema_sync.py`

- [ ] **Step 1: Add failing card tests**

Add test data for:

```python
{
  "type": "project_profile_patch",
  "title": "Projektkontext aktualisieren",
  "rationale": "Der Nutzer hat bestätigt, dass es sich um Bestand handelt.",
  "patch": [{"op": "replace", "path": "/facts/new_or_existing/value", "value": "existing"}],
  "preview": [{"label": "Bestand/Neubau", "before": "unknown", "after": "Bestand"}],
}
```

Assert unsafe paths like `/name` fail validation.

- [ ] **Step 2: Implement Pydantic card model**

Add `ProjectProfilePatchOperation`, `ProjectProfilePatchPreviewItem`, `ProjectProfilePatchCard`. Restrict `op` to `add | replace | remove`; restrict paths to `/facts`, `/goals`, `/unknowns`, `/assumptions` via validator. Add `ProjectProfilePatchCard` to `GridCard` union and `__all__`.

- [ ] **Step 3: Regenerate schemas**

Run from repo root: `uv run python scripts/generate_card_schema.py`

Run from `frontends/ui`: `npm run generate:cards`

- [ ] **Step 4: Render card in React**

Create a presentational card with title, rationale, preview rows, and buttons. `Accept` calls `fetch('/api/projects/${projectId}/profile/patches', { method: 'POST', body: JSON.stringify({ patch: card.patch }) })` when a project id is available. If existing card props do not carry project id, disable the button with explanatory copy and keep reject local-only.

- [ ] **Step 5: Verify**

Run:

```bash
uv run pytest tests/aiq_agent/cards -q
uv run ruff check src/aiq_agent/cards tests/aiq_agent/cards
cd frontends/ui && npm run type-check && npm run lint
```

Expected: card tests pass; frontend checks exit 0 or only pre-existing unrelated diagnostics. Capture exact output.

---

## Task 5: Final Integration Verification

**Files:**
- Review all files touched by Tasks 1-4.

- [ ] **Step 1: Inspect changed files**

Run:

```bash
git status --short
git diff --stat
```

Confirm changed files match this plan and no unrelated files were modified by the implementation.

- [ ] **Step 2: Run backend verification**

Run:

```bash
uv run pytest tests/aiq_agent/project_context tests/aiq_agent/cards tests/aiq_agent/agents/chat_researcher tests/aiq_agent/agents/shallow_researcher tests/aiq_agent/agents/deep_researcher -q
uv run ruff check src/aiq_agent tests/aiq_agent
```

- [ ] **Step 3: Run frontend verification**

Run from `frontends/ui`:

```bash
npm run test -- src/lib/project-profile/prompt-view.test.ts
npm run type-check
npm run lint
```

- [ ] **Step 4: Summarize residual gaps**

Report whether v1 implemented deterministic profile projections only, and explicitly call out that AI-generated display summaries can be wired later using the same stored `profile_display` fields.

---

## Self-Review Notes

- Spec coverage: profile persistence, prompt-view injection, schema-driven intake definition, UI display projections, and profile patch cards are covered.
- Scope intentionally excludes full polished onboarding page routing because the user asked to implement the backend/shared system first and v1 can expose APIs/components before complete product navigation.
- No placeholders remain. Each task names concrete files and verification commands.
- Commits are omitted intentionally due higher-priority instruction: only commit when explicitly requested.
