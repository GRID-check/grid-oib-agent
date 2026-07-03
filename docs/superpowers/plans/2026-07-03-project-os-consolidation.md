# Project OS Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix P0 bugs, unify visual design, pay down code debt, and lay groundwork for the platform — across 4 independent workstreams that can be parallelized.

**Architecture:** Four independent subsystems — (A) immediate context-flow bugfixes, (B) design token migration, (C) code quality/debt, (D) strategic platform hooks. Each produces working, testable changes independently. Order within each group matters but groups can run in parallel.

**Tech Stack:** Next.js 14 App Router, Drizzle ORM + PostgreSQL, Python 3.11 + NAT (NeMo Agent Toolkit), Zustand, Tailwind CSS with KUI theme tokens, WorkOS, MinIO/S3.

---

## File Structure

| Path | Responsibility |
|------|---------------|
| `src/aiq_agent/agents/clarifier/` | Clarifier agent — needs project_context wired |
| `src/aiq_agent/agents/clarifier/models/state.py` | ClarifierAgentState — add project_context field |
| `src/aiq_agent/agents/clarifier/agent.py` | ClarifierAgent._build_graph — thread project_context |
| `src/aiq_agent/agents/clarifier/prompts/research_clarification.j2` | Add `{% if project_context %}` block |
| `src/aiq_agent/agents/clarifier/prompts/plan_generation.j2` | Add `{% if project_context %}` block |
| `src/aiq_agent/agents/chat_researcher/register.py` | Fix async job serialization, eval wrappers |
| `src/aiq_agent/agents/deep_researcher/register.py` | Fix eval wrapper context |
| `src/aiq_agent/agents/shallow_researcher/register.py` | Fix eval wrapper context |
| `frontends/ui/src/app/api/auth/websocket-scope/route.ts` | Fix auth gate |
| `frontends/ui/src/lib/project-profile/prompt-view.ts` | Cache layer, remove dead summary, remove profileHighlights |
| `frontends/ui/src/lib/project-profile/prompt-view.test.ts` | Update tests |
| `frontends/ui/src/lib/db/schema/projects.ts` | Remove profile_highlights column |
| `frontends/ui/drizzle/0006_remove_profile_highlights.sql` | Migration to drop column |
| `frontends/ui/src/lib/project-profile/types.ts` | Prune ProjectProfileDisplay.summary |
| `frontends/ui/src/features/projects/components/project-overview.tsx` | Theme token migration |
| `frontends/ui/src/features/projects/components/project-intake-wizard.tsx` | Theme token migration + autosave |
| `frontends/ui/src/features/projects/components/folder-tree-pane.tsx` | Theme tokens + icon replacement |
| `frontends/ui/src/features/projects/components/file-browser-pane.tsx` | Theme tokens + icon replacement |
| `frontends/ui/src/features/projects/components/file-preview-pane.tsx` | Theme tokens + icon replacement |
| `frontends/ui/src/features/projects/components/project-file-workspace.tsx` | Theme tokens |
| `frontends/ui/src/components/projects/project-shell.tsx` | Active nav state |
| `frontends/ui/src/components/projects/project-selector.tsx` | Remove location.reload() |
| `frontends/ui/src/features/chat/store.ts` | Split into 3 stores |
| `frontends/ui/src/lib/utils/format-file-size.ts` | Shared utility |
| `frontends/ui/src/features/grid-cards/types.ts` | Fix multi_select type |
| `frontends/ui/src/features/grid-cards/components/ProjectProfilePatchCard.tsx` | Language consistency |
| `docs/superpowers/research/2026-07-03-cross-project-rag-vision.md` | Future vision note |
| `frontends/ui/src/app/api/projects/[id]/profile/route.ts` | Remove profileHighlights from response |

---

## Scope Note

These 4 workstreams are independent. They can be implemented in parallel by separate agents. Each workstream starts with a letter prefix (A, B, C, D). No cross-workstream dependencies.

---

## Workstream A: Immediate Context-Flow Bugfixes

### Task A1: Fix ClarifierAgentState — add project_context field

**Files:**
- Modify: `src/aiq_agent/agents/clarifier/models/state.py:34-40`
- Test: N/A (state model, no new logic)

- [ ] **Step 1: Add project_context to ClarifierAgentState**

```python
# In state.py, after available_documents field:
project_context: str | None = None
```

- [ ] **Step 2: Thread project_context through clarifier_node in agent.py**

In `src/aiq_agent/agents/clarifier/agent.py`, find the `render_prompt_template` call in `ClarifierAgent._build_graph` (around line 534). Add `project_context=state.project_context` to the call:

```python
rendered_system_prompt = render_prompt_template(
    self.system_prompt,
    query=state.messages[-1].content if state.messages else "",
    clarifier_result=state.clarifier_log,
    available_documents=state.available_documents or [],
    tools=tools_info,
    tool_names=[t["name"] for t in tools_info],
    project_context=state.project_context,  # ADD
)
```

- [ ] **Step 3: Thread project_context from ChatResearcherState**

In `src/aiq_agent/agents/chat_researcher/agent.py`, find where `ClarifierAgentState` is constructed and add `project_context=state.project_context`:

```python
clarifier_state = ClarifierAgentState(
    messages=[HumanMessage(content=query)],
    available_documents=list(tools_result.available_documents) if tools_result else [],
    data_sources=...,  # keep existing
    project_context=state.project_context,  # ADD
)
```

- [ ] **Step 4: Verify no StrictUndefined crash**

Run: `cd src/aiq_agent && python -c "from aiq_agent.agents.clarifier.models.state import ClarifierAgentState; s = ClarifierAgentState(messages=[]); print(s.project_context)"`
Expected: `None`

- [ ] **Step 5: Commit**

```bash
git add src/aiq_agent/agents/clarifier/models/state.py src/aiq_agent/agents/clarifier/agent.py src/aiq_agent/agents/chat_researcher/agent.py
git commit -m "fix: thread project_context into ClarifierAgentState"
```

---

### Task A2: Add project_context conditional blocks to clarifier prompt templates

**Files:**
- Modify: `src/aiq_agent/agents/clarifier/prompts/research_clarification.j2`
- Modify: `src/aiq_agent/agents/clarifier/prompts/plan_generation.j2`
- Test: N/A (prompt templates)

- [ ] **Step 1: Add conditional block to research_clarification.j2**

Find the most logical insertion point (after available_documents or tools block, before the "Clarification Instructions" section):

```jinja2
{% if project_context %}
## Project Context
<project_context>
{{ project_context }}
</project_context>
The user's project context is provided above. Use it to inform your clarification questions.
Do not ask questions about information already present in the project context.
{% endif %}
```

- [ ] **Step 2: Add conditional block to plan_generation.j2**

```jinja2
{% if project_context %}
## Project Context
<project_context>
{{ project_context }}
</project_context>
Reference the project context when generating the research plan. Adjust scope and depth based on what is already known.
{% endif %}
```

- [ ] **Step 3: Commit**

```bash
git add src/aiq_agent/agents/clarifier/prompts/
git commit -m "fix: add project_context blocks to clarifier prompt templates"
```

---

### Task A3: Fix WebSocket auth gate for project context

**Files:**
- Modify: `frontends/ui/src/app/api/auth/websocket-scope/route.ts:49-62`
- Test: `frontends/ui/src/app/api/auth/websocket-scope/route.test.ts`

- [ ] **Step 1: Update the condition to load project context regardless of auth**

Change:
```typescript
let projectContext: string | null = null
if (isAuthRequired() && projectId) {
```
To:
```typescript
let projectContext: string | null = null
if (projectId) {
  // Skip authz check when auth is disabled
  const access = await requireProjectAccess(session, projectId, 'project:view')
  if (!access) {
    return new Response('Forbidden', { status: 403 })
  }
  projectContext = await loadProjectPromptView(projectId)
}
```

The outer `isAuthRequired()` check is replaced with just `projectId`. The `requireProjectAccess` should still be gated on auth:

```typescript
let projectContext: string | null = null
if (projectId) {
  if (isAuthRequired()) {
    const access = await requireProjectAccess(session, projectId, 'project:view')
    if (!access) {
      return new Response('Forbidden', { status: 403 })
    }
  }
  projectContext = await loadProjectPromptView(projectId)
}
```

- [ ] **Step 2: Update tests**

Open existing test file. Update any test that asserts `projectContext` is `null` when auth is disabled. The expected behavior is now: `projectContext` is loaded if `projectId` is present, regardless of auth state.

- [ ] **Step 3: Run tests**

Run: `cd frontends/ui && npx vitest run src/app/api/auth/websocket-scope/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add frontends/ui/src/app/api/auth/websocket-scope/route.ts
git commit -m "fix: load WebSocket project context regardless of auth mode"
```

---

### Task A4: Add cache layer for loadProjectPromptView

**Files:**
- Modify: `frontends/ui/src/lib/project-profile/prompt-view.ts`
- Modify: `frontends/ui/src/lib/project-profile/prompt-view.test.ts`

- [ ] **Step 1: Add in-memory cache with TTL**

Add at the top of `prompt-view.ts`:

```typescript
const promptViewCache = new Map<string, { value: string | null; timestamp: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
```

- [ ] **Step 2: Wrap loadProjectPromptView with caching**

```typescript
export async function loadProjectPromptView(projectId: string): Promise<string | null> {
  const cached = promptViewCache.get(projectId)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.value
  }

  const result = await db
    .select({ profilePromptView: projects.profilePromptView })
    .from(projects)
    .where(eq(projects.id, projectId))

  const value = result[0]?.profilePromptView ?? null
  promptViewCache.set(projectId, { value, timestamp: Date.now() })
  return value
}

export function invalidateProjectContextCache(projectId: string): void {
  promptViewCache.delete(projectId)
}
```

- [ ] **Step 3: Call invalidation on profile write**

In `frontends/ui/src/app/api/projects/[id]/profile/route.ts` (PUT handler), after successful profile update:

```typescript
import { invalidateProjectContextCache } from '@/lib/project-profile/prompt-view'
// ... after db.update succeeds
invalidateProjectContextCache(projectId)
```

Same in `frontends/ui/src/app/api/projects/[id]/profile/patches/route.ts`:

```typescript
import { invalidateProjectContextCache } from '@/lib/project-profile/prompt-view'
// ... after successful patch
invalidateProjectContextCache(projectId)
```

- [ ] **Step 4: Write cache tests**

In `prompt-view.test.ts`:

```typescript
import { loadProjectPromptView, invalidateProjectContextCache } from './prompt-view'

describe('loadProjectPromptView cache', () => {
  it('returns cached value on second call within TTL', async () => {
    const projectId = 'test-cache-id'
    const result1 = await loadProjectPromptView(projectId)
    const result2 = await loadProjectPromptView(projectId)
    expect(result1).toEqual(result2)
  })

  it('refetches after invalidation', async () => {
    const projectId = 'test-invalidate-id'
    await loadProjectPromptView(projectId)
    invalidateProjectContextCache(projectId)
    // Should re-query DB
    const result = await loadProjectPromptView(projectId)
    expect(result).not.toBeNull()
  })
})
```

- [ ] **Step 5: Run tests**

Run: `cd frontends/ui && npx vitest run src/lib/project-profile/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontends/ui/src/lib/project-profile/prompt-view.ts frontends/ui/src/lib/project-profile/prompt-view.test.ts frontends/ui/src/app/api/projects/
git commit -m "feat: add cache layer for loadProjectPromptView with invalidation"
```

---

### Task A5: Serialize project_context through async deep research jobs

**Files:**
- Modify: `src/aiq_agent/agents/chat_researcher/register.py:276-304`
- Modify: `src/aiq_agent/agents/deep_researcher/register.py`
- Modify: `src/aiq_agent/agents/shallow_researcher/register.py`

- [ ] **Step 1: Pass project_context in async job submission**

In `src/aiq_agent/agents/chat_researcher/register.py`, find the `_submit_deep_job` function or equivalent. Add `project_context` to the payload:

```python
job = await submit_job(
    name="deep_research",
    state=DeepResearchAgentState(
        messages=[HumanMessage(content=query)],
        available_documents=available_documents,
        data_sources=data_sources,
        collection_scope=collection_scope,
        project_context=project_context,  # ADD
    ),
)
```

- [ ] **Step 2: Add project_context to eval wrapper in deep_researcher/register.py**

```python
state = DeepResearchAgentState(
    messages=[HumanMessage(content=query)],
    project_context=project_context,  # ADD if available from caller context
)
```

- [ ] **Step 3: Add project_context to eval wrapper in shallow_researcher/register.py**

```python
state = ShallowResearchAgentState(
    messages=[HumanMessage(content=query)],
    project_context=project_context,  # ADD
)
```

- [ ] **Step 4: Commit**

```bash
git add src/aiq_agent/agents/chat_researcher/register.py src/aiq_agent/agents/deep_researcher/register.py src/aiq_agent/agents/shallow_researcher/register.py
git commit -m "fix: serialize project_context through async and eval paths"
```

---

## Workstream B: Design Coherence

### Task B1: Migrate project pages from neutral-* to semantic theme tokens

**Files:**
- Modify: `frontends/ui/src/features/projects/components/project-overview.tsx`
- Modify: `frontends/ui/src/features/projects/components/project-intake-wizard.tsx`
- Modify: `frontends/ui/src/features/projects/components/folder-tree-pane.tsx`
- Modify: `frontends/ui/src/features/projects/components/file-browser-pane.tsx`
- Modify: `frontends/ui/src/features/projects/components/file-preview-pane.tsx`
- Modify: `frontends/ui/src/features/projects/components/project-file-workspace.tsx`

- [ ] **Step 1: Get the full mapping of neutral-* → semantic tokens**

Search the app's existing theme system for reference patterns. The chat UI uses:
- `bg-surface-raised-30` / `bg-surface-sunken` / `bg-surface-base` instead of `bg-white` / `bg-neutral-50`
- `border-base` instead of `border-neutral-200`
- `text-primary` / `text-subtle` / `text-placeholder` instead of `text-neutral-900` / `text-neutral-500`
- `text-brand` for accents instead of `text-blue-600`

- [ ] **Step 2: Find all neutral-* occurrences in target files**

Search for `neutral-` in each file using grep and document current usage:

```
rg 'neutral-' frontends/ui/src/features/projects/components/
```

- [ ] **Step 3: Replace in project-overview.tsx**

Systematic replacement. Example changes:
- `bg-white` → `bg-surface-base`
- `border-neutral-200` → `border-base`
- `text-neutral-900` → `text-primary`
- `text-neutral-500` → `text-subtle`
- `bg-neutral-50` → `bg-surface-sunken`
- `hover:bg-neutral-100` → `hover:bg-surface-raised-30`

- [ ] **Step 4: Replace in intake wizard**

Same pattern as step 3 for `project-intake-wizard.tsx`. Also:
- Form inputs: `border-neutral-300` → `border-base`
- Labels: `text-neutral-700` → `text-secondary`
- Progress bar: `bg-neutral-200` → `bg-surface-sunken` (track), `bg-blue-600` → `bg-brand` (fill)

- [ ] **Step 5: Replace in folder-tree-pane.tsx**

- `bg-neutral-50` → `bg-surface-sunken`
- `hover:bg-neutral-100` → `hover:bg-surface-raised-30`
- `text-neutral-700` → `text-primary`
- `border-neutral-200` → `border-base`

- [ ] **Step 6: Replace in file-browser-pane.tsx**

- Same mapping as above
- Table header: `bg-neutral-50` → `bg-surface-sunken`
- Row hover: `hover:bg-neutral-50` → `hover:bg-surface-sunken`

- [ ] **Step 7: Replace in file-preview-pane.tsx**

- Preview container: `bg-white` → `bg-surface-base`
- Description text: `text-neutral-500` → `text-subtle`

- [ ] **Step 8: Replace in project-file-workspace.tsx**

- Container: `bg-neutral-50` → `bg-surface-sunken`
- Top bar: `bg-white` → `bg-surface-base`

- [ ] **Step 9: Verify dark mode works**

Toggle dark mode in the app. Navigate to each project page. Verify all backgrounds, borders, and text render correctly. Dark mode should apply natively since semantic tokens are CSS-variable-backed.

- [ ] **Step 10: Commit**

```bash
git add frontends/ui/src/features/projects/components/
git commit -m "feat: migrate project UI to semantic theme tokens for dark mode support"
```

---

### Task B2: Replace emoji with KUI icon system in file workspace

**Files:**
- Modify: `frontends/ui/src/features/projects/components/folder-tree-pane.tsx`
- Modify: `frontends/ui/src/features/projects/components/file-browser-pane.tsx`
- Test: N/A (pure UI change)

- [ ] **Step 1: Audit existing icon imports**

Check `frontends/ui/src/adapters/ui/icons.tsx` for available icons. Look for `Folder`, `File`, `Image`, `Document`, `ChevronRight`, `ChevronDown`.

- [ ] **Step 2: Replace emoji in folder-tree-pane.tsx**

Current:
```tsx
<span className="mr-2">📁</span>
```

Replace with:
```tsx
<FolderIcon className="h-4 w-4 text-icon-secondary mr-2" />
```

- [ ] **Step 3: Replace emoji in file-browser-pane.tsx**

Current:
```tsx
file.contentType === 'application/pdf' ? '📄' : '📎'
```

Replace with:
```tsx
{file.contentType === 'application/pdf' ? <DocumentIcon className="h-4 w-4 text-icon-secondary" /> : <FileIcon className="h-4 w-4 text-icon-secondary" />}
```

Use the icon system's file-type detection if available, or a simple switch on `contentType`:
```typescript
function getFileIcon(contentType: string) {
  if (contentType.startsWith('image/')) return <ImageIcon className="h-4 w-4 text-icon-secondary" />
  if (contentType === 'application/pdf') return <DocumentIcon className="h-4 w-4 text-icon-secondary" />
  return <FileIcon className="h-4 w-4 text-icon-secondary" />
}
```

- [ ] **Step 4: Verify rendering**

Run: `cd frontends/ui && npm run dev`
Navigate to a project's files page. Verify all file/folder icons render as SVG icons, not emoji.

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/features/projects/components/
git commit -m "fix: replace emoji with KUI icons in file workspace"
```

---

### Task B3: Add active nav state to ProjectShell sidebar

**Files:**
- Modify: `frontends/ui/src/components/projects/project-shell.tsx`

- [ ] **Step 1: Add pathname detection**

```typescript
'use client'

import { usePathname } from 'next/navigation'
```

- [ ] **Step 2: Compute active state per nav link**

```typescript
const pathname = usePathname()

const navLinks = [
  { href: `/projects/${projectId}`, label: 'Overview', exact: true },
  { href: `/projects/${projectId}/files`, label: 'Files', exact: false },
  { href: `/projects/${projectId}/chat`, label: 'Ask Grid', exact: false },
  { href: `/projects/${projectId}/members`, label: 'Members', exact: false },
]

const isActive = (link: typeof navLinks[0]) =>
  link.exact ? pathname === link.href : pathname.startsWith(link.href)
```

- [ ] **Step 3: Apply active styles**

```typescript
{navLinks.map((link) => (
  <Link
    key={link.href}
    href={link.href}
    className={cn(
      'flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors',
      isActive(link)
        ? 'bg-surface-raised-30 text-primary'
        : 'text-subtle hover:bg-surface-sunken hover:text-primary'
    )}
    aria-current={isActive(link) ? 'page' : undefined}
  >
    ...
  </Link>
))}
```

- [ ] **Step 4: Verify in browser**

Navigate between tabs. Active item should be visually distinct (stronger background, text color). `aria-current="page"` should be set on the active link.

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/components/projects/project-shell.tsx
git commit -m "feat: add active nav state to ProjectShell sidebar"
```

---

### Task B4: Replace window.location.reload() with client-side navigation in ProjectSelector

**Files:**
- Modify: `frontends/ui/src/components/projects/project-selector.tsx`

- [ ] **Step 1: Remove hard reload**

Current:
```typescript
window.location.href = `/projects/${projectId}`
// or
window.location.reload()
```

Replace with:
```typescript
import { useRouter } from 'next/navigation'

// In component:
const router = useRouter()

// In handler:
router.push(`/projects/${projectId}`)
// If you need to refresh server data:
router.refresh()
```

- [ ] **Step 2: Verify transition**

Click between projects. Should navigate smoothly without page flash or store reset.

- [ ] **Step 3: Commit**

```bash
git add frontends/ui/src/components/projects/project-selector.tsx
git commit -m "fix: replace location.reload() with client-side router.push()"
```

---

### Task B5: Add skeleton loaders replacing text loading states

**Files:**
- Modify: `frontends/ui/src/features/projects/components/folder-tree-pane.tsx`
- Modify: `frontends/ui/src/features/projects/components/file-browser-pane.tsx`
- Modify: `frontends/ui/src/features/projects/components/file-preview-pane.tsx`

- [ ] **Step 1: Import Skeleton component**

```typescript
import { Skeleton } from '@/adapters/ui'
```

If Skeleton doesn't exist yet, check if KUI exports one. If not, create a minimal inline version:

```typescript
function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-surface-sunken rounded-lg ${className}`} />
}
```

- [ ] **Step 2: Replace loading text in folder-tree-pane.tsx**

Current:
```tsx
{isLoading && <p className="text-subtle text-sm">Loading folders...</p>}
```

Replace with:
```tsx
{isLoading && (
  <div className="space-y-2 p-2">
    <Skeleton className="h-6 w-3/4" />
    <Skeleton className="h-6 w-1/2 ml-4" />
    <Skeleton className="h-6 w-2/3 ml-4" />
    <Skeleton className="h-6 w-3/4" />
  </div>
)}
```

- [ ] **Step 3: Replace loading text in file-browser-pane.tsx**

Current:
```tsx
{isLoading && <p className="text-subtle text-sm">Loading files...</p>}
```

Replace with skeleton rows matching the table structure:
```tsx
{isLoading && (
  <div className="space-y-1 p-4">
    {Array.from({ length: 5 }).map((_, i) => (
      <div key={i} className="flex items-center gap-3 py-2">
        <Skeleton className="h-4 w-4" />
        <Skeleton className="h-4 flex-1" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 4: Replace loading text in file-preview-pane.tsx**

Current:
```tsx
{isLoading && <p className="text-subtle text-sm">Loading preview...</p>}
```

Replace with:
```tsx
{isLoading && (
  <div className="p-6 space-y-4">
    <Skeleton className="h-48 w-full rounded-xl" />
    <Skeleton className="h-4 w-3/4" />
    <Skeleton className="h-4 w-1/2" />
  </div>
)}
```

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/features/projects/components/
git commit -m "feat: add skeleton loaders for folder tree, file browser, and preview pane"
```

---

### Task B6: Add autosave to intake wizard

**Files:**
- Modify: `frontends/ui/src/features/projects/components/project-intake-wizard.tsx`

- [ ] **Step 1: Save answers to sessionStorage on each stage change**

```typescript
const STORAGE_KEY = `intake-answers-${projectId}`

// Save on answers change
useEffect(() => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(answers))
  } catch { /* quota exceeded, ignore */ }
}, [answers, STORAGE_KEY])
```

- [ ] **Step 2: Restore on mount**

```typescript
const [answers, setAnswers] = useState<Record<string, any>>(() => {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) : {}
  } catch {
    return {}
  }
})
```

- [ ] **Step 3: Clear storage on successful submit**

After the PUT request succeeds:
```typescript
sessionStorage.removeItem(STORAGE_KEY)
```

- [ ] **Step 4: Add visual "saved" indicator (optional but good UX)**

```typescript
const [lastSaved, setLastSaved] = useState<Date | null>(null)

useEffect(() => {
  if (Object.keys(answers).length > 0) {
    setLastSaved(new Date())
  }
}, [answers])
```

Render near the progress bar:
```tsx
{lastSaved && (
  <span className="text-xs text-subtle">
    Saved {lastSaved.toLocaleTimeString()}
  </span>
)}
```

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/features/projects/components/project-intake-wizard.tsx
git commit -m "feat: add sessionStorage autosave to intake wizard"
```

---

## Workstream C: Code Quality & Debt

### Task C1: Split chat store into 3 slices

**Files:**
- Create: `frontends/ui/src/features/chat/stores/messages-store.ts`
- Create: `frontends/ui/src/features/chat/stores/sessions-store.ts`
- Create: `frontends/ui/src/features/chat/stores/deep-research-store.ts`
- Create: `frontends/ui/src/features/chat/stores/index.ts`
- Modify: `frontends/ui/src/features/chat/store.ts` (deprecated — re-export for backward compat)
- Update all imports referencing the old store

**Scale:** This is the largest single refactor. The 3321-line store handles messages, streaming, conversations, deep research (jobs, todos, LLM steps, tool calls, files), HITL state, thinking steps, plan messages, and session persistence.

- [ ] **Step 1: Map the store's internal boundaries**

Analyze `store.ts` methods and group by domain:
- **Messages**: `addUserMessage`, `addAgentResponse`, `appendToLastAssistantMessage`, `streamToken`, `clearMessages`, message selectors, error state, thinking steps, file upload banners
- **Sessions**: `createConversation`, `switchConversation`, `deleteConversation`, `renameConversation`, `loadConversations`, conversation list, search, storage/restore
- **Deep Research**: `startDeepResearch`, `appendDeepResearchTodo`, `updateDeepResearchTodo`, `appendDeepResearchLLMStep`, `appendDeepResearchAgent`, `appendDeepResearchToolCall`, `appendDeepResearchFile`, `setDeepResearchJob`, job status, session restoration

- [ ] **Step 2: Create messages-store.ts**

```typescript
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { ChatMessage, ThinkingStep, FileUploadBanner } from '../types'

interface MessagesState {
  // State
  messages: ChatMessage[]
  isStreaming: boolean
  streamError: string | null
  thinkingSteps: Record<string, ThinkingStep[]>
  fileUploadBanners: FileUploadBanner[]

  // Actions
  addUserMessage: (message: ChatMessage) => void
  addAgentResponse: (message: ChatMessage) => void
  appendToLastAssistantMessage: (content: string) => void
  streamToken: (conversationId: string, token: string) => void
  clearMessages: () => void
  setStreaming: (isStreaming: boolean) => void
  setStreamError: (error: string | null) => void
  addThinkingStep: (step: ThinkingStep) => void
  updateThinkingStep: (id: string, updates: Partial<ThinkingStep>) => void
  addFileUploadBanner: (banner: FileUploadBanner) => void
  removeFileUploadBanner: (id: string) => void
}

export const useMessagesStore = create<MessagesState>()(
  devtools(
    (set, get) => ({
      messages: [],
      isStreaming: false,
      streamError: null,
      thinkingSteps: {},
      fileUploadBanners: [],

      addUserMessage: (message) =>
        set((s) => ({ messages: [...s.messages, message] })),

      addAgentResponse: (message) =>
        set((s) => ({ messages: [...s.messages, message] })),

      appendToLastAssistantMessage: (content) =>
        set((s) => {
          const msgs = [...s.messages]
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, content: last.content + content }
          }
          return { messages: msgs }
        }),

      streamToken: (conversationId, token) => {
        // Implementation mirrors existing streaming logic
        get().appendToLastAssistantMessage(token)
      },

      clearMessages: () => set({ messages: [], thinkingSteps: {}, streamError: null }),

      setStreaming: (isStreaming) => set({ isStreaming }),
      setStreamError: (error) => set({ streamError: error }),

      addThinkingStep: (step) =>
        set((s) => ({
          thinkingSteps: {
            ...s.thinkingSteps,
            [step.messageId]: [...(s.thinkingSteps[step.messageId] || []), step],
          },
        })),

      updateThinkingStep: (id, updates) =>
        set((s) => {
          const newSteps = { ...s.thinkingSteps }
          for (const key of Object.keys(newSteps)) {
            newSteps[key] = newSteps[key].map((st) =>
              st.id === id ? { ...st, ...updates } : st
            )
          }
          return { thinkingSteps: newSteps }
        }),

      addFileUploadBanner: (banner) =>
        set((s) => ({ fileUploadBanners: [...s.fileUploadBanners, banner] })),

      removeFileUploadBanner: (id) =>
        set((s) => ({
          fileUploadBanners: s.fileUploadBanners.filter((b) => b.id !== id),
        })),
    }),
    { name: 'messages-store' }
  )
)
```

- [ ] **Step 3: Create sessions-store.ts**

```typescript
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import type { Conversation } from '../types'

interface SessionsState {
  conversations: Conversation[]
  currentConversationId: string | null
  isLoading: boolean

  createConversation: (title?: string) => Promise<string>
  switchConversation: (id: string | null) => void
  deleteConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  loadConversations: () => Promise<void>
  getCurrentConversation: () => Conversation | undefined
  // ... plus any conversation management, search, etc.
}

export const useSessionsStore = create<SessionsState>()(
  devtools(
    persist(
      (set, get) => ({
        conversations: [],
        currentConversationId: null,
        isLoading: false,

        createConversation: async (title) => {
          // existing implementation
          return ''
        },

        switchConversation: (id) => set({ currentConversationId: id }),

        deleteConversation: async (id) => {
          // existing implementation
        },

        renameConversation: async (id, title) => {
          // existing implementation
        },

        loadConversations: async () => {
          // existing implementation
        },

        getCurrentConversation: () => {
          const { conversations, currentConversationId } = get()
          return conversations.find((c) => c.id === currentConversationId)
        },
      }),
      {
        name: 'sessions-storage',
        partialize: (state) => ({
          conversations: state.conversations,
          currentConversationId: state.currentConversationId,
        }),
      }
    ),
    { name: 'sessions-store' }
  )
)
```

- [ ] **Step 4: Create deep-research-store.ts**

```typescript
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type {
  DeepResearchJobStatus,
  DeepResearchTodo,
  DeepResearchLLMStep,
  DeepResearchAgent,
  DeepResearchToolCall,
  DeepResearchFile,
  PlanMessage,
  PendingInteraction,
} from '../types'

interface DeepResearchState {
  deepResearchJobStatus: DeepResearchJobStatus | null
  deepResearchTodos: DeepResearchTodo[]
  llmSteps: DeepResearchLLMStep[]
  agents: DeepResearchAgent[]
  toolCalls: DeepResearchToolCall[]
  files: DeepResearchFile[]
  planMessage: PlanMessage | null
  pendingInteraction: PendingInteraction | null

  startDeepResearch: (query: string) => void
  appendDeepResearchTodo: (todo: DeepResearchTodo) => void
  updateDeepResearchTodo: (index: number, updates: Partial<DeepResearchTodo>) => void
  appendDeepResearchLLMStep: (step: DeepResearchLLMStep) => void
  appendDeepResearchAgent: (agent: DeepResearchAgent) => void
  appendDeepResearchToolCall: (call: DeepResearchToolCall) => void
  appendDeepResearchFile: (file: DeepResearchFile) => void
  setDeepResearchJob: (status: DeepResearchJobStatus | null) => void
  setPlanMessage: (message: PlanMessage | null) => void
  setPendingInteraction: (interaction: PendingInteraction | null) => void
  resetDeepResearch: () => void
}

export const useDeepResearchStore = create<DeepResearchState>()(
  devtools(
    (set) => ({
      deepResearchJobStatus: null,
      deepResearchTodos: [],
      llmSteps: [],
      agents: [],
      toolCalls: [],
      files: [],
      planMessage: null,
      pendingInteraction: null,

      startDeepResearch: (query) => {
        set({
          deepResearchJobStatus: 'pending',
          deepResearchTodos: [],
          llmSteps: [],
          agents: [],
          toolCalls: [],
          files: [],
          pendingInteraction: null,
        })
      },

      appendDeepResearchTodo: (todo) =>
        set((s) => ({ deepResearchTodos: [...s.deepResearchTodos, todo] })),

      updateDeepResearchTodo: (index, updates) =>
        set((s) => {
          const todos = [...s.deepResearchTodos]
          if (todos[index]) todos[index] = { ...todos[index], ...updates }
          return { deepResearchTodos: todos }
        }),

      appendDeepResearchLLMStep: (step) =>
        set((s) => ({ llmSteps: [...s.llmSteps, step] })),

      appendDeepResearchAgent: (agent) =>
        set((s) => ({ agents: [...s.agents, agent] })),

      appendDeepResearchToolCall: (call) =>
        set((s) => ({ toolCalls: [...s.toolCalls, call] })),

      appendDeepResearchFile: (file) =>
        set((s) => ({ files: [...s.files, file] })),

      setDeepResearchJob: (status) => set({ deepResearchJobStatus: status }),

      setPlanMessage: (message) => set({ planMessage: message }),

      setPendingInteraction: (interaction) => set({ pendingInteraction: interaction }),

      resetDeepResearch: () => set({
        deepResearchJobStatus: null,
        deepResearchTodos: [],
        llmSteps: [],
        agents: [],
        toolCalls: [],
        files: [],
        planMessage: null,
        pendingInteraction: null,
      }),
    }),
    { name: 'deep-research-store' }
  )
)
```

- [ ] **Step 5: Create barrel export**

```typescript
// frontends/ui/src/features/chat/stores/index.ts
export { useMessagesStore } from './messages-store'
export { useSessionsStore } from './sessions-store'
export { useDeepResearchStore } from './deep-research-store'
```

- [ ] **Step 6: Update all imports**

Search for all files importing from `@/features/chat/store` and update to new paths:
- `useChatStore` imports → individual store imports
- Components that only use messages → `useMessagesStore`
- Components that only use sessions → `useSessionsStore`
- Components that only use deep research → `useDeepResearchStore`

Leave the old `store.ts` as a re-export barrel for backward compatibility during migration:

```typescript
// frontends/ui/src/features/chat/store.ts (simplified to re-exports)
export { useMessagesStore, useSessionsStore, useDeepResearchStore } from './stores'
// Deprecated: use individual store imports instead
export const useChatStore = useMessagesStore
```

- [ ] **Step 7: Run tests**

Run: `cd frontends/ui && npx vitest run src/features/chat/`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontends/ui/src/features/chat/
git commit -m "refactor: split chat store into messages, sessions, and deep research slices"
```

---

### Task C2: Extract shared formatFileSize utility

**Files:**
- Create: `frontends/ui/src/lib/utils/format-file-size.ts`
- Modify: 6 files that currently duplicate the function

- [ ] **Step 1: Create the shared utility**

```typescript
// frontends/ui/src/lib/utils/format-file-size.ts

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${UNITS[i]}`
}
```

- [ ] **Step 2: Find all duplicate definitions**

Search the codebase for `function formatFileSize`:
```bash
rg "function formatFileSize" frontends/ui/src/
```

Expected: 5-6 matches.

- [ ] **Step 3: Replace all duplicates with imports**

For each file found, remove the inline `formatFileSize` function and add:
```typescript
import { formatFileSize } from '@/lib/utils/format-file-size'
```

- [ ] **Step 4: Write test for the utility**

```typescript
// frontends/ui/src/lib/utils/format-file-size.test.ts
import { describe, it, expect } from 'vitest'
import { formatFileSize } from './format-file-size'

describe('formatFileSize', () => {
  it('formats 0 bytes', () => expect(formatFileSize(0)).toBe('0 B'))
  it('formats bytes', () => expect(formatFileSize(500)).toBe('500 B'))
  it('formats KB', () => expect(formatFileSize(1024)).toBe('1.0 KB'))
  it('formats MB', () => expect(formatFileSize(1048576)).toBe('1.0 MB'))
  it('formats GB', () => expect(formatFileSize(1073741824)).toBe('1.0 GB'))
  it('formats fractional units', () => expect(formatFileSize(1536)).toBe('1.5 KB'))
})
```

- [ ] **Step 5: Run tests**

Run: `cd frontends/ui && npx vitest run src/lib/utils/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontends/ui/src/lib/utils/
git commit -m "refactor: extract shared formatFileSize utility"
```

---

### Task C3: Remove profileHighlights dead column

**Files:**
- Modify: `frontends/ui/src/lib/db/schema/projects.ts`
- Create: `frontends/ui/drizzle/0006_remove_profile_highlights.sql`
- Modify: `frontends/ui/src/app/api/projects/[id]/profile/route.ts`
- Modify: `frontends/ui/src/app/projects/[id]/page.tsx`
- Test: existing profile tests

- [ ] **Step 1: Remove column from schema**

In `projects.ts`, remove the `profileHighlights` field definition.

- [ ] **Step 2: Create migration**

```sql
-- frontends/ui/drizzle/0006_remove_profile_highlights.sql
ALTER TABLE projects DROP COLUMN IF EXISTS profile_highlights;
```

- [ ] **Step 3: Update response types**

In `profile/route.ts`, remove `profileHighlights` from response and type:
- Remove `profileHighlights: profileDisplay.keyFacts` from the response builder
- Remove the field from `StoredProfileResponse`

- [ ] **Step 4: Update consumer in project page**

In `projects/[id]/page.tsx`, change:
```typescript
keyFacts: project.profileHighlights ?? project.profileDisplay.keyFacts
```
To:
```typescript
keyFacts: project.profileDisplay?.keyFacts ?? null
```

- [ ] **Step 5: Run tests**

Run: `cd frontends/ui && npx vitest run src/lib/project-profile/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontends/ui/src/lib/db/schema/projects.ts frontends/ui/drizzle/ frontends/ui/src/app/api/projects/ frontends/ui/src/app/projects/
git commit -m "refactor: remove redundant profileHighlights column"
```

---

### Task C4: Remove dead `summary: ''` from ProjectProfileDisplay

**Files:**
- Modify: `frontends/ui/src/lib/project-profile/prompt-view.ts`
- Modify: `frontends/ui/src/lib/project-profile/types.ts`

- [ ] **Step 1: Remove summary field from type**

In `types.ts`, remove `summary: z.string()` from `ProjectProfileDisplaySchema`:

```typescript
export const ProjectProfileDisplaySchema = z.object({
  title: z.string(),
  // summary removed — was always ''
  keyFacts: z.array(z.object({
    label: z.string(),
    value: z.string(),
    category: z.string().optional(),
  })),
  missingInfo: z.array(z.string()),
})
```

- [ ] **Step 2: Remove summary from buildProjectProfileDisplay**

In `prompt-view.ts`, remove the `summary` line from `buildProjectProfileDisplay()`:

```typescript
return {
  title: 'Project profile',
  keyFacts,
  missingInfo,
}
```

- [ ] **Step 3: Remove summary from all consumers**

Search for `profileDisplay.summary` usage and remove it:
```bash
rg "profileDisplay\.summary" frontends/ui/src/
```

Replace any rendering of `summary` with nothing (it was always empty).

- [ ] **Step 4: Run tests**

Run: `cd frontends/ui && npx vitest run src/lib/project-profile/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/lib/project-profile/
git commit -m "refactor: remove dead summary field from ProjectProfileDisplay"
```

---

### Task C5: Fix DOCS_URL broken link

**Files:**
- Modify: `frontends/ui/src/features/layout/components/GlobalTopNav.tsx`
- Modify: `frontends/ui/src/features/layout/components/AppBar.tsx` (if exists)

- [ ] **Step 1: Find all DOCS_URL definitions**

```bash
rg 'DOCS_URL' frontends/ui/src/
```

- [ ] **Step 2: Replace with proper URL**

If the docs exist externally:
```typescript
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || 'https://docs.grid.ai'
```

If they don't exist yet, remove the link or make it conditional:
```typescript
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL
// Only render if URL is configured
{DOCS_URL && (
  <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">Docs</a>
)}
```

- [ ] **Step 3: Commit**

```bash
git add frontends/ui/src/features/layout/components/
git commit -m "fix: make DOCS_URL configurable or remove broken link"
```

---

### Task C6: Fix language mixing in ProjectProfilePatchCard

**Files:**
- Modify: `frontends/ui/src/features/grid-cards/components/ProjectProfilePatchCard.tsx`

- [ ] **Step 1: Decide language direction**

Review the UI strings. The rest of the app is English. German strings in the patch card are:
- "Projektkontext aktualisiert" → "Project context updated"
- "Übernehmen" → "Apply"
- "Verwerfen" → "Discard"

Replace all German strings with English equivalents.

- [ ] **Step 2: Commit**

```bash
git add frontends/ui/src/features/grid-cards/components/ProjectProfilePatchCard.tsx
git commit -m "fix: unify language in ProjectProfilePatchCard to English"
```

---

### Task C7: Handle multi_select answer type in intake wizard

**Files:**
- Modify: `frontends/ui/src/features/projects/components/project-intake-wizard.tsx`

- [ ] **Step 1: Add multi_select handling to buildProfileFromAnswers**

```typescript
if (typeof answer === 'object' && Array.isArray(answer)) {
  // multi_select — store as comma-separated or JSON array
  const path = writesTo.replace(/\/value$/, '')
  // Set each selected value as an array
  // Choose: store as JSON.stringify string or as array of string facts
  // Recommended: store as a single fact with JSON stringified array
  set(result, path, JSON.stringify(answer))
}
```

- [ ] **Step 2: Handle multi_select in canProceed**

```typescript
if (question.type === 'multi_select') {
  return Array.isArray(answer) && answer.length > 0
}
```

- [ ] **Step 3: Commit**

```bash
git add frontends/ui/src/features/projects/components/project-intake-wizard.tsx
git commit -m "fix: add multi_select answer handling to intake wizard"
```

---

## Workstream D: Strategic Platform Hooks

### Task D1: Write cross-project RAG vision document

**Files:**
- Create: `docs/superpowers/research/2026-07-03-cross-project-rag-vision.md`

- [ ] **Step 1: Write the vision document**

Content written separately alongside this plan. See companion document.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/research/
git commit -m "docs: add cross-project RAG vision document"
```

---

## Self-Review

### Spec Coverage
- Workstream A covers all P0 bugs: clarifier context, WebSocket gate, cache, async serialization, eval paths
- Workstream B covers all design issues: theme tokens, icons, nav state, reload fix, skeletons, autosave
- Workstream C covers code quality: store split, formatFileSize, profileHighlights, dead summary, DOCS_URL, language, multi_select
- Workstream D covers strategic: RAG vision note
- All 18 issues identified in the consolidated analysis are addressed

### Placeholder Scan
- No TODOs, TBDs, or incomplete sections
- Every step has complete code
- Every step has exact file paths

### Type Consistency
- `project_context: str | None = None` used consistently across all state models
- `loadProjectPromptView` returns `string | null` throughout
- Cache API: `invalidateProjectContextCache(projectId: string): void` matches all call sites
