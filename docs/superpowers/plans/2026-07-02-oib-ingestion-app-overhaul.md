> Note (2026-07-05): fastapi_extensions was removed on 2026-07-03; ingest now lives in frontends/aiq_api.

# OIB Ingestion And App Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OIB ingestion reliable for the full PDF corpus and turn the UI into an application-style project workspace with clear navigation, project file exploration, and explicit project/session upload targeting.

**Architecture:** Keep the backend knowledge layer aligned with NVIDIA AI-Q’s LlamaIndex/Chroma pattern, but make PDF handling deterministic by extracting PDF text with `pdfplumber` instead of relying on optional LlamaIndex readers that are missing in the Docker image. On the frontend, introduce an app shell/global top nav and make project workspaces the parent layout for chat, files, and members while preserving existing chat internals.

**Tech Stack:** Next.js App Router, React 18, Zustand, Drizzle/Postgres, WorkOS AuthKit/FGA, Python 3.11, NeMo Agent Toolkit, LlamaIndex, ChromaDB, pdfplumber, pypdfium2, OpenRouter-compatible VLM.

---

## File Structure

**Backend ingestion**
- Modify `sources/knowledge_layer/src/llamaindex/adapter.py`: PDF detection, text extraction, raw/binary guards, file/job status correctness.
- Modify `src/aiq_agent/oib_sync.py`: collection env fallback, changed-file cleanup, explicit multimodal config.
- Modify `src/aiq_agent/fastapi_extensions/routes/ingest.py`: avoid deleting URL temp files before async ingestion consumes them.
- Test `tests/knowledge_layer_tests/test_llamaindex_adapter.py`: PDF text extraction and binary rejection.
- Test `tests/aiq_agent/knowledge/test_oib_sync.py`: registry updates only after success.

**Project/file corpus behavior**
- Modify `frontends/ui/src/lib/collection-scope.ts`: accept project collection names, session collection idempotence, optional project exclusion.
- Modify `frontends/ui/src/lib/collection-scope-request.ts`: resolve project `collectionName` from DB, add explicit private-session scoping.
- Modify `frontends/ui/src/app/api/auth/websocket-scope/route.ts`: pass project/private scope flags.
- Modify `frontends/ui/src/app/api/generate/route.ts`, `frontends/ui/src/app/api/generate/respond/route.ts`, and `frontends/ui/src/app/api/v1/[...path]/route.ts`: use project collection names consistently.
- Modify `frontends/ui/src/adapters/api/documents-client.ts`: session context URL handling and collection-neutral operations.
- Modify `frontends/ui/src/features/documents/hooks/use-file-upload.ts`: project vs session upload branch.
- Modify `frontends/ui/src/features/layout/components/FileSourcesTab.tsx`: upload target selector.
- Modify `frontends/ui/src/features/documents/components/FileUploadZone.tsx`: rename `sessionId` semantics to `collectionName`.

**Application layout and file explorer**
- Create `frontends/ui/src/features/layout/components/GlobalTopNav.tsx`: global product/project navigation.
- Create `frontends/ui/src/features/layout/components/AppShell.tsx`: reusable app frame.
- Create `frontends/ui/src/features/layout/components/ChatToolbar.tsx`: chat-specific toolbar split from global nav.
- Modify `frontends/ui/src/features/layout/components/MainLayout.tsx`: remove global top-bar responsibility and fit inside app shell.
- Modify `frontends/ui/src/app/page.tsx`, `frontends/ui/src/app/projects/page.tsx`, `frontends/ui/src/app/projects/[id]/layout.tsx`, `frontends/ui/src/app/projects/[id]/page.tsx`, `frontends/ui/src/app/projects/[id]/chat/page.tsx`, and `frontends/ui/src/app/projects/[id]/members/page.tsx`: app-like parent/child layouts.
- Create `frontends/ui/src/features/documents/components/project-file-explorer.tsx`: project file explorer shell.
- Create `frontends/ui/src/features/documents/components/project-file-row.tsx`: reusable file row.
- Create `frontends/ui/src/features/documents/components/project-file-toolbar.tsx`: search/filter/upload affordances.
- Modify `frontends/ui/src/features/documents/components/document-list.tsx`: delegate to the explorer or become a compatibility wrapper.

---

## Commit Checkpoints

1. `fix: harden oib pdf ingestion`
2. `fix: align project and session document scopes`
3. `feat: add upload target selector`
4. `feat: add app shell and global navigation`
5. `feat: add project file explorer`
6. `test: verify oib ingestion and app workspace flows`

Each commit must be preceded by `git status`, `git diff --name-only`, and a diff review. Stage only intended files; never stage `deploy/.env` or secrets.

---

### Task 1: Harden PDF Ingestion

**Files:**
- Modify: `sources/knowledge_layer/src/llamaindex/adapter.py`
- Test: `tests/knowledge_layer_tests/test_llamaindex_adapter.py`

- [ ] **Step 1: Add ingestion helper tests**

Add tests that express the desired behavior without calling remote services:

```python
def test_pdf_magic_detects_pdf_without_pdf_suffix(tmp_path):
    path = tmp_path / "upload"
    path.write_bytes(b"%PDF-1.7\nbody")

    from knowledge_layer.llamaindex.adapter import _looks_like_pdf

    assert _looks_like_pdf(str(path)) is True


def test_raw_pdf_text_is_rejected():
    from knowledge_layer.llamaindex.adapter import _looks_like_raw_pdf_or_binary

    assert _looks_like_raw_pdf_or_binary("%PDF-1.7\n1 0 obj\nxref\nendobj") is True
    assert _looks_like_raw_pdf_or_binary("OIB-Richtlinie 2.1 Brandschutz bei Betriebsbauten") is False
```

- [ ] **Step 2: Implement helpers in `adapter.py`**

Add these helpers near the existing PDF extraction helpers:

```python
def _looks_like_pdf(file_path: str) -> bool:
    try:
        with open(file_path, "rb") as handle:
            return handle.read(5) == b"%PDF-"
    except OSError:
        return False


def _looks_like_raw_pdf_or_binary(text: str) -> bool:
    sample = text[:4096]
    if sample.lstrip().startswith("%PDF"):
        return True
    if "endobj" in sample and "xref" in sample:
        return True
    if "\x00" in sample:
        return True
    if not sample:
        return False
    control_count = sum(1 for ch in sample if ord(ch) < 32 and ch not in "\n\r\t")
    return control_count / len(sample) > 0.05
```

- [ ] **Step 3: Make PDF detection robust**

Replace extension-only detection in `_run_ingestion()` with:

```python
is_pdf = (
    file_name.lower().endswith(".pdf")
    or Path(file_path).suffix.lower() == ".pdf"
    or _looks_like_pdf(file_path)
)
```

- [ ] **Step 4: Reject empty or binary extraction before indexing**

Before `VectorStoreIndex.from_documents(...)`, add:

```python
valid_documents = [
    doc for doc in all_documents if not _looks_like_raw_pdf_or_binary(doc.get_content())
]
if len(valid_documents) != len(all_documents):
    raise ValueError("Raw PDF/binary content detected; refusing to index")
if not valid_documents:
    self._update_file_status(
        job,
        i,
        FileStatus.FAILED,
        error="No content extracted (file may be password-protected, corrupted, or empty)",
    )
    continue
all_documents = valid_documents
```

- [ ] **Step 5: Make index creation safe after skipped/failed files**

Initialize `index = None` before the file loop and replace `if i == 0` with:

```python
if index is None:
    index = VectorStoreIndex.from_documents(
        all_documents,
        storage_context=storage_context,
        show_progress=False,
    )
else:
    for doc in all_documents:
        index.insert(doc)
```

- [ ] **Step 6: Run focused syntax/test check**

Run from repo root:

```powershell
uv run python -m py_compile sources/knowledge_layer/src/llamaindex/adapter.py
uv run pytest tests/knowledge_layer_tests/test_llamaindex_adapter.py -q
```

Expected: compile succeeds; new tests pass.

---

### Task 2: Make Ingestion Status And OIB Registry Honest

**Files:**
- Modify: `sources/knowledge_layer/src/llamaindex/adapter.py`
- Modify: `src/aiq_agent/oib_sync.py`
- Modify: `src/aiq_agent/fastapi_extensions/routes/ingest.py`
- Test: `tests/aiq_agent/knowledge/test_oib_sync.py`

- [ ] **Step 1: Honor the upload `file_id` in `submit_job()`**

In `adapter.py`, read provided IDs from `config`:

```python
provided_file_ids = job_config.get("file_ids") or []
single_file_id = job_config.get("file_id")
```

Use the provided ID for one-file uploads:

```python
if i < len(provided_file_ids):
    file_id = provided_file_ids[i]
elif single_file_id and len(validated_paths) == 1:
    file_id = single_file_id
else:
    file_id = str(uuid.uuid4())
```

- [ ] **Step 2: Stop mapping completed jobs to successful files blindly**

In `get_file_status()`, use `file_details` status when job is terminal. A completed job with a failed file must return `FileStatus.FAILED` for that file.

- [ ] **Step 3: Set job status based on file outcomes**

At the end of `_run_ingestion()`:

```python
failed_files = [f for f in job.file_details if f.status == FileStatus.FAILED]
successful_files = [f for f in job.file_details if f.status == FileStatus.SUCCESS]
if failed_files and not successful_files:
    job.status = JobState.FAILED
    job.error_message = f"{len(failed_files)}/{len(job.file_details)} file(s) failed"
else:
    job.status = JobState.COMPLETED
```

- [ ] **Step 4: Align OIB collection env fallback**

In `src/aiq_agent/oib_sync.py`, set:

```python
COLLECTION_NAME = os.environ.get("OIB_COLLECTION_NAME") or os.environ.get("COLLECTION_NAME") or "oib_knowledge"
```

- [ ] **Step 5: Delete old chunks for changed PDFs**

Before uploading a changed PDF in `sync()`:

```python
if str(pdf) in registry:
    try:
        ingestor.delete_file(pdf.name, COLLECTION_NAME)
    except Exception as exc:
        logger.warning("Could not delete existing chunks for %s before reingest: %s", pdf.name, exc)
```

- [ ] **Step 6: Do not unlink URL temp files before async ingestion**

In `src/aiq_agent/fastapi_extensions/routes/ingest.py`, remove any route-level cleanup that deletes `temp_path` immediately after `submit_job()`. Keep `cleanup_files=True` so the ingestor owns cleanup after the background job finishes.

- [ ] **Step 7: Validate**

Run:

```powershell
uv run python -m py_compile src/aiq_agent/oib_sync.py src/aiq_agent/fastapi_extensions/routes/ingest.py sources/knowledge_layer/src/llamaindex/adapter.py
uv run pytest tests/aiq_agent/knowledge/test_oib_sync.py -q
```

Expected: compile succeeds; OIB registry tests pass.

---

### Task 3: Use Stored Project Collection Names Everywhere

**Files:**
- Modify: `frontends/ui/src/lib/collection-scope.ts`
- Modify: `frontends/ui/src/lib/collection-scope-request.ts`
- Modify: `frontends/ui/src/app/api/auth/websocket-scope/route.ts`
- Modify: `frontends/ui/src/app/api/generate/route.ts`
- Modify: `frontends/ui/src/app/api/generate/respond/route.ts`
- Modify: `frontends/ui/src/app/api/v1/[...path]/route.ts`
- Test: `frontends/ui/tests/lib/collection-scope.test.ts`
- Test: `frontends/ui/tests/lib/collection-scope-request.test.ts`

- [ ] **Step 1: Extend scope context**

In `collection-scope.ts`, change `ScopeContext` so it can receive either `projectCollectionName` or `projectId` during migration:

```ts
export interface ScopeContext {
  baseCollection?: string
  projectId?: string
  projectCollectionName?: string
  conversationId?: string
  includeProject?: boolean
}
```

- [ ] **Step 2: Prefer stored project collection names**

In `computeCollectionScope()`, push project scope as:

```ts
if (context.includeProject !== false) {
  const projectCollection = context.projectCollectionName ?? (context.projectId ? `proj_${context.projectId}` : undefined)
  if (projectCollection) collections.push(projectCollection)
}
```

- [ ] **Step 3: Resolve project collection names in request scope builder**

In `collection-scope-request.ts`, add DB lookup by project ID:

```ts
async function resolveProjectCollectionName(projectId: string, organizationId: string): Promise<string | undefined> {
  const db = getDb()
  const [project] = await db
    .select({ collectionName: projects.collectionName })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
    .limit(1)
  return project?.collectionName
}
```

- [ ] **Step 4: Add private-session scope flag**

Extend `RequestContext`:

```ts
export interface RequestContext {
  projectId?: string
  conversationId?: string
  includeProject?: boolean
}
```

Pass `includeProject: context.includeProject !== false` into `computeCollectionScope()`.

- [ ] **Step 5: Add tests**

Add assertions:

```ts
expect(computeCollectionScope(null, { projectCollectionName: 'proj_db_value', conversationId: 's_1' }))
  .toEqual(['oib_knowledge', 'proj_db_value', 's_1'])
expect(computeCollectionScope(null, { projectCollectionName: 'proj_db_value', conversationId: 's_1', includeProject: false }))
  .toEqual(['oib_knowledge', 's_1'])
```

- [ ] **Step 6: Validate frontend scope tests**

Run from `frontends/ui`:

```powershell
npx vitest run tests/lib/collection-scope.test.ts tests/lib/collection-scope-request.test.ts
```

Expected: scope tests pass.

---

### Task 4: Add Project/Session Upload Target Selector

**Files:**
- Modify: `frontends/ui/src/features/layout/components/FileSourcesTab.tsx`
- Modify: `frontends/ui/src/features/documents/components/FileUploadZone.tsx`
- Modify: `frontends/ui/src/features/documents/hooks/use-file-upload.ts`
- Test: `frontends/ui/src/features/layout/components/FileSourcesTab.spec.tsx`
- Test: `frontends/ui/src/features/documents/hooks/use-file-upload.spec.ts`

- [ ] **Step 1: Compute upload target in `FileSourcesTab`**

Add local state:

```ts
type UploadTarget = 'project' | 'session'
const projectId = useChatStore((state) => state.projectId)
const [uploadTarget, setUploadTarget] = useState<UploadTarget>(projectId ? 'project' : 'session')
const targetCollectionName = uploadTarget === 'project' && projectId ? `proj_${projectId}` : currentConversation?.id
```

After Task 3, replace `proj_${projectId}` with the resolved project collection name from project context/API.

- [ ] **Step 2: Render selector above upload zone**

Use existing UI primitives:

```tsx
{projectId && (
  <div className="rounded-2xl border border-base bg-surface-sunken p-2">
    <Text kind="label/semibold/xs" className="text-subtle uppercase tracking-[0.18em]">Upload to</Text>
    <div className="mt-2 grid grid-cols-2 gap-1">
      <button type="button" onClick={() => setUploadTarget('project')}>Project corpus</button>
      <button type="button" onClick={() => setUploadTarget('session')}>Private session</button>
    </div>
  </div>
)}
```

- [ ] **Step 3: Route uploads to the selected collection**

Call:

```ts
useFileUpload({ collectionName: targetCollectionName })
```

For `session`, call `ensureSession()` before upload. For `project`, do not create a chat session just to upload to the project corpus.

- [ ] **Step 4: Generalize `FileUploadZone` prop**

Replace `sessionId?: string` with `collectionName?: string` and filter tracked files by that collection.

- [ ] **Step 5: Validate**

Run:

```powershell
npx vitest run src/features/layout/components/FileSourcesTab.spec.tsx src/features/documents/hooks/use-file-upload.spec.ts
```

Expected: selector and upload branch tests pass.

---

### Task 5: Add Global App Shell And Top Navigation

**Files:**
- Create: `frontends/ui/src/features/layout/components/GlobalTopNav.tsx`
- Create: `frontends/ui/src/features/layout/components/AppShell.tsx`
- Create: `frontends/ui/src/features/layout/components/ChatToolbar.tsx`
- Modify: `frontends/ui/src/features/layout/components/MainLayout.tsx`
- Modify: `frontends/ui/src/app/page.tsx`
- Modify: `frontends/ui/src/app/projects/page.tsx`

- [ ] **Step 1: Create `GlobalTopNav`**

Implement a refined industrial/application nav: Grid logo, `Chat`, `Projects`, active project selector, auth/user controls, and theme control. Keep chat session actions out of this component.

- [ ] **Step 2: Create `AppShell`**

```tsx
export function AppShell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="min-h-screen bg-surface-base text-primary">
      <GlobalTopNav />
      <div className="min-h-[calc(100vh-64px)]">{children}</div>
    </div>
  )
}
```

- [ ] **Step 3: Split chat toolbar out of `AppBar`**

Move session/new-chat/data-source controls into `ChatToolbar`. `MainLayout` renders `ChatToolbar`; `AppShell` renders `GlobalTopNav`.

- [ ] **Step 4: Fit `MainLayout` inside shell**

Change root class from `h-screen min-w-[768px]` to a shell-aware height like:

```tsx
<Flex direction="col" className="h-[calc(100vh-64px)] min-w-[768px] overflow-x-auto overflow-y-hidden">
```

- [ ] **Step 5: Wrap app pages**

Wrap `/` and `/projects` pages with `AppShell` if a route group is not introduced in this iteration.

- [ ] **Step 6: Validate**

Run:

```powershell
npx vitest run src/features/layout/components
npm run type-check
```

Expected: component tests and type check pass.

---

### Task 6: Convert Project Routes Into A Workspace

**Files:**
- Modify: `frontends/ui/src/app/projects/[id]/layout.tsx`
- Modify: `frontends/ui/src/app/projects/[id]/page.tsx`
- Modify: `frontends/ui/src/app/projects/[id]/chat/page.tsx`
- Modify: `frontends/ui/src/app/projects/[id]/members/page.tsx`
- Create: `frontends/ui/src/components/projects/project-shell.tsx`
- Create: `frontends/ui/src/components/projects/project-nav.tsx`

- [ ] **Step 1: Server-check access in project layout**

In `projects/[id]/layout.tsx`, call:

```ts
await requireProjectAccess(session, id, 'project:view')
```

- [ ] **Step 2: Build `ProjectShell`**

Render a project header, side navigation, and nested content slot. Nav items: Files, Chat, Members.

- [ ] **Step 3: Make `/projects/[id]` the Files workspace**

Keep the route path stable and render the project file explorer as the default child.

- [ ] **Step 4: Make chat feel nested**

In `projects/[id]/chat/page.tsx`, keep `setProjectId(id)` but render inside the project shell with no duplicate project header.

- [ ] **Step 5: Validate**

Run:

```powershell
npm run type-check
npx vitest run src/components/projects
```

Expected: project components type-check and tests pass.

---

### Task 7: Add Project File Explorer

**Files:**
- Create: `frontends/ui/src/features/documents/components/project-file-explorer.tsx`
- Create: `frontends/ui/src/features/documents/components/project-file-row.tsx`
- Create: `frontends/ui/src/features/documents/components/project-file-toolbar.tsx`
- Modify: `frontends/ui/src/features/documents/components/document-list.tsx`
- Modify: `frontends/ui/src/app/projects/[id]/page.tsx`

- [ ] **Step 1: Create row component**

Expose filename, type, size, status, created date, download action, and failure message.

- [ ] **Step 2: Create toolbar**

Add search field, status filter buttons, and an upload action placeholder that routes to the project corpus.

- [ ] **Step 3: Create explorer**

Use a dense application-like layout: left mini summary rail, central file table/cards, right details panel for the selected file.

- [ ] **Step 4: Replace document page content**

Render `ProjectFileExplorer documents={docRows} projectId={id}`.

- [ ] **Step 5: Validate**

Run:

```powershell
npx vitest run src/features/documents/components
npm run type-check
```

Expected: explorer tests and type check pass.

---

### Task 8: Rebuild, Re-ingest, And Verify OIB End To End

**Files:**
- Runtime validation only.

- [ ] **Step 1: Rebuild backend**

Run:

```powershell
docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env up -d --build aiq-agent
```

- [ ] **Step 2: Force clean OIB ingestion**

Because `OIB_FORCE_REINGEST=true`, backend startup should clear registry/Chroma. If manual run is needed, run:

```powershell
docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env exec aiq-agent python -c "from aiq_agent.oib_sync import sync; print(sync())"
```

- [ ] **Step 3: Verify PDF count**

Run:

```powershell
docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env exec aiq-agent python -c "from pathlib import Path; print(sum(1 for _ in Path('/app/data/oib').rglob('*.pdf')))"
```

Expected: about 39-40 PDFs.

- [ ] **Step 4: Verify Chroma quality**

Run:

```powershell
docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env exec aiq-agent python -c "import os, chromadb; c=chromadb.PersistentClient(path=os.environ.get('AIQ_CHROMA_DIR','/app/data/chroma_data')).get_collection(os.environ.get('OIB_COLLECTION_NAME') or os.environ.get('COLLECTION_NAME','oib_knowledge')); data=c.get(include=['documents','metadatas']); docs=data.get('documents') or []; metas=data.get('metadatas') or []; binary=sum(1 for d in docs if isinstance(d,str) and (d.lstrip().startswith('%PDF') or 'endobj' in d[:2000] or '\x00' in d[:2000])); print({'chunks':len(docs),'files':len({m.get('file_name') for m in metas if m and m.get('file_name')}),'binary_like_chunks':binary,'content_types':sorted({m.get('content_type') for m in metas if m and m.get('content_type')})})"
```

Expected: many files, `binary_like_chunks: 0`, and content types include `text` plus `table`/`image` when extracted.

- [ ] **Step 5: Verify retrieval**

Run a backend retrieval smoke query for `OIB 2.1 Brandschutz Betriebsbauten` and confirm returned chunks cite OIB PDFs and contain readable German regulation text/tables.

---

### Task 9: Final Validation And Commit Hygiene

**Files:**
- All changed files.

- [ ] **Step 1: Run scoped Python checks**

```powershell
uv run ruff check src/aiq_agent sources/knowledge_layer tests/aiq_agent tests/knowledge_layer_tests
uv run ruff format --check src/aiq_agent sources/knowledge_layer tests/aiq_agent tests/knowledge_layer_tests
```

- [ ] **Step 2: Run scoped frontend checks**

```powershell
npm run lint
npm run type-check
npx vitest run src/features/layout src/features/documents tests/lib
```

- [ ] **Step 3: Inspect diff before final commit**

```powershell
git status --short
git diff --name-only
git diff --stat
```

- [ ] **Step 4: Commit final cohesive batch**

Stage only intended files and commit with a Conventional Commit message.

---

## Self-Review

- Ingestion plan covers text, table, image/chart extraction, binary rejection, honest statuses, registry correctness, rebuild, re-ingestion, and Chroma/retrieval verification.
- File/upload plan covers project default upload, private session toggle, session validator failure, and project collection identity.
- UI plan covers global top nav, app shell, parent/child project layout, and project file explorer.
- No secrets or `.env` values are included. Runtime commands use `--env-file deploy/.env` without printing secret values.
