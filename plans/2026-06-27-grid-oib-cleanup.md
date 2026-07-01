# Grid OIB Agent MVP — Phase 1: Cleanup and Re-branding Base

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Implement the tasks below in order, run the verification commands, and commit.

**Goal:** Remove unneeded NVIDIA/template files, keep the runtime pieces the user wants, update metadata, and prepare the repo for the OIB backend and frontend work.

**Architecture:** This phase is a surgical deletion/rewrite pass. Nothing new is built; we only delete files, move docs, update `.pre-commit-config.yaml`, `.gitignore`, `README.md`, `AGENTS.md`, `CLAUDE.md`, and Docker Compose defaults.

**Tech Stack:** git, pre-commit, Docker Compose, Markdown.

---

## File inventory (repo root: `D:\Personal\GRID\gridAgent\.worktrees\aiq\aiq`)

All paths below are relative to the repo root unless noted.

---

### Task 1: Remove template/corporate files

**Files:**
- Delete: `CHANGELOG.md`
- Delete: `CODE-OF-CONDUCT.md`
- Delete: `CONTRIBUTING.md`
- Delete: `SECURITY.md`
- Delete: `LICENSE`
- Delete: `LICENSE-THIRD-PARTY`
- Delete: `.coderabbit.yaml`
- Delete: `CLAUDE.md` (but we will recreate a minimal one in Task 5)
- Delete: `GRID_SETUP.md` (content moves into new README)
- Delete zip archives at root:
  - `gesamtfassung-oib-richtlinien-2023-komprimiert-teil-1.zip`
  - `gesamtfassung-oib-richtlinien-2023-komprimiert-teil-2.zip`

- [ ] **Step 1: Delete the listed files**

```bash
git rm -f CHANGELOG.md CODE-OF-CONDUCT.md CONTRIBUTING.md SECURITY.md LICENSE LICENSE-THIRD-PARTY .coderabbit.yaml CLAUDE.md GRID_SETUP.md
git rm -f gesamtfassung-oib-richtlinien-2023-komprimiert-teil-1.zip gesamtfassung-oib-richtlinien-2023-komprimiert-teil-2.zip
```

- [ ] **Step 2: Verify deletions**

```bash
git status --short
```

Expected: the deleted files show as `D` and no other changes yet.

- [ ] **Step 3: Commit**

```bash
git commit -s -m "chore: remove NVIDIA template artifacts and corporate files"
```

---

### Task 2: Trim `.github/`

**Files:**
- Delete: `.github/copy-pr-bot.yaml`
- Delete: `.github/ops-bot.yaml`
- Delete directory: `.github/skill-eval/`
- Keep: `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`, `.github/workflows/`

- [ ] **Step 1: Remove the listed GitHub files**

```bash
git rm -f .github/copy-pr-bot.yaml .github/ops-bot.yaml
rm -rf .github/skill-eval
```

- [ ] **Step 2: Stage directory removal and verify**

```bash
git add -A .github
git status --short
```

Expected: only the deleted/removed items under `.github/` are staged.

- [ ] **Step 3: Commit**

```bash
git commit -s -m "chore: trim GitHub automation to essentials"
```

---

### Task 3: Trim `deploy/`

**Files:**
- Delete Helm chart files but keep the readme:
  - Delete directory: `deploy/helm/deployment-k8s/`
  - Delete directory: `deploy/helm/helm-charts-k8s/`
  - Keep and rewrite if desired: `deploy/helm/README.md`
- Delete stray test files in compose:
  - Delete: `deploy/compose/aiq_config.json`
  - Delete: `deploy/compose/test_doc.txt`
- Keep: `deploy/compose/docker-compose.yaml`, `deploy/compose/init-db.sql`, `deploy/compose/README.md`, `deploy/Dockerfile`, `deploy/entrypoint.py`, `deploy/start_web.py`, `deploy/.env.example`, `deploy/README.md`

- [ ] **Step 1: Remove Helm chart directories and compose test files**

```bash
git rm -rf deploy/helm/deployment-k8s deploy/helm/helm-charts-k8s
rm -f deploy/compose/aiq_config.json deploy/compose/test_doc.txt
```

- [ ] **Step 2: If `deploy/helm/README.md` is mostly NVIDIA-specific, rewrite it to a short note**

Modify `deploy/helm/README.md` to contain only:

```markdown
# Grid Helm deployment (not maintained in MVP)

Helm charts were removed for the MVP because the target deployment platform is Coolify/Docker Compose.
This file is kept as a placeholder for future Kubernetes deployment notes.
```

- [ ] **Step 3: Stage and commit**

```bash
git add -A deploy
git commit -s -m "chore: remove Helm charts, keep Docker Compose runtime"
```

---

### Task 4: Flatten/remove `docs/`

**Files:**
- Delete the entire `docs/` directory.
- Move the Kubernetes deployment guide content into `deploy/helm/README.md` if it contains useful Coolify/K8s notes; otherwise leave the short placeholder from Task 3.

- [ ] **Step 1: Remove docs**

```bash
git rm -rf docs
```

- [ ] **Step 2: Verify**

```bash
git status --short
```

Expected: `docs/` deletion staged.

- [ ] **Step 3: Commit**

```bash
git commit -s -m "chore: remove Sphinx docs, keep helm placeholder"
```

---

### Task 5: Update `.pre-commit-config.yaml`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`

**Files:**
- Modify: `.pre-commit-config.yaml`
- Modify: `.gitignore`
- Modify: `AGENTS.md`
- Create: `CLAUDE.md`

- [ ] **Step 1: Update `.pre-commit-config.yaml` to remove checks for deleted files**

Open `.pre-commit-config.yaml` and remove any hooks that reference `docs/`, `.agents/skills/`, `skills/`, or `CHANGELOG.md` validation. Keep the ruff/format/secret hooks. If a hook is unclear, leave it but ensure it does not fail on the deleted paths.

- [ ] **Step 2: Update `.gitignore`**

Add these entries near the top:

```gitignore
# OIB source data and registry
/data/oib_registry.json
/data/*.zip

# Local environment and job stores
.env
deploy/.env
jobs.db
summaries.db
checkpoints.db
```

- [ ] **Step 3: Rewrite `AGENTS.md` into a concise Grid contributor guide**

Replace the entire content of `AGENTS.md` with:

```markdown
# Grid Agent Contributor Guide

This repo is the Grid-branded AI-Q agent worktree. It contains a Next.js UI, a Python backend using the NeMo Agent Toolkit, and a custom OIB knowledge source.

## Repository layout

| Path | Purpose |
|------|---------|
| `src/aiq_agent/` | Backend agent, FastAPI extensions, knowledge layer |
| `sources/` | NAT data-source packages, including `oib_knowledge` |
| `frontends/ui/` | Next.js chat UI |
| `frontends/debug/` | Debug console mounted at `/debug` |
| `frontends/cli/` | `aiq-research` CLI |
| `frontends/benchmarks/` | Evaluation harnesses |
| `frontends/aiq_api/` | Python API client library |
| `configs/` | Workflow configs, including `config_grid_oib.yml` |
| `deploy/` | Docker Compose assets |
| `skills/` | API-consumer skill examples |
| `scripts/` | Utility scripts, including `scripts/ingest_oib.py` |
| `data/oib/` | OIB Richtlinien PDFs (not committed) |

## Quick start

```bash
cp deploy/.env.example deploy/.env
# edit deploy/.env with KIMI_API_KEY and NVIDIA_API_KEY
docker compose -f deploy/compose/docker-compose.yaml up -d
```

## Backend commands

```bash
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

## Frontend commands

```bash
cd frontends/ui
npm install
npm run lint
npm run type-check
npm run test:ci
npm run dev
```

## Conventions

- Python: ruff, line length 120, Python 3.11.
- New tools use `@register_function` and a `FunctionBaseConfig` subclass.
- Secrets live in environment variables only.
```

- [ ] **Step 4: Create minimal `CLAUDE.md`**

```markdown
AGENTS.md
```

- [ ] **Step 5: Stage and commit**

```bash
git add -A
git commit -s -m "chore: update agent guides, gitignore, and pre-commit config"
```

---

### Task 6: Rewrite root `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace `README.md` with a Grid-focused README**

Content:

```markdown
# Grid OIB Research Agent

A specialized AI research agent for Austrian building regulations (OIB Richtlinien), built on the NVIDIA AI-Q Blueprint.

## What it does

- Answers questions about OIB Richtlinien using a persistent local knowledge base.
- Can fall back to web search for context that is not in the OIB documents.
- Restricts conversation to Austrian building-regulation topics.
- Returns structured response cards (Summary, Legal Basis) in a Next.js chat UI.

## Project structure

- `src/aiq_agent/` — backend agent runtime
- `sources/oib_knowledge/` — custom OIB retrieval source
- `frontends/ui/` — Next.js chat interface
- `configs/config_grid_oib.yml` — Grid workflow configuration
- `scripts/ingest_oib.py` — incremental OIB PDF ingestion
- `data/oib/` — OIB PDFs (add your own, not committed)

## Quick start

1. Copy and fill environment variables:
   ```bash
   cp deploy/.env.example deploy/.env
   ```
   Set at least `KIMI_API_KEY` and `NVIDIA_API_KEY`.

2. Place OIB PDFs in `data/oib/`.

3. Start the stack:
   ```bash
   docker compose -f deploy/compose/docker-compose.yaml up -d
   ```

4. Trigger initial ingestion:
   ```bash
   docker compose -f deploy/compose/docker-compose.yaml exec aiq-agent python scripts/ingest_oib.py
   ```

5. Open the UI at `http://localhost:3000`.

## Development

See `AGENTS.md` for contributor commands and conventions.
```

- [ ] **Step 2: Stage and commit**

```bash
git add README.md
git commit -s -m "docs: rewrite README for Grid OIB agent"
```

---

### Task 7: Update Docker Compose default config

**Files:**
- Modify: `deploy/compose/docker-compose.yaml`
- Modify: `deploy/.env.example`

- [ ] **Step 1: Change backend config in compose**

Open `deploy/compose/docker-compose.yaml` and find the environment variable `BACKEND_CONFIG`. Set it to:

```yaml
BACKEND_CONFIG=/app/configs/config_grid_oib.yml
```

Also ensure the service name is `aiq-agent` and that `data/oib/` and `data/chroma_data` are mounted. Add a volume mount for the OIB folder:

```yaml
volumes:
  - ../../data/oib:/app/data/oib:ro
  - chroma_data:/app/data/chroma_data
```

- [ ] **Step 2: Update `deploy/.env.example`**

Add or ensure these variables exist:

```env
KIMI_API_KEY=
NVIDIA_API_KEY=
GRID_ADMIN_TOKEN=change-me-in-production
BACKEND_CONFIG=/app/configs/config_grid_oib.yml
COLLECTION_NAME=oib_knowledge
AIQ_CHROMA_DIR=/app/data/chroma_data
```

- [ ] **Step 3: Stage and commit**

```bash
git add deploy/compose/docker-compose.yaml deploy/.env.example
git commit -s -m "chore: point compose to Grid OIB config"
```

---

### Task 8: Final cleanup verification

- [ ] **Step 1: Run pre-commit on all files**

```bash
uv run pre-commit run --all-files
```

Expected: any remaining failures are only about code you will fix in later phases, not missing files.

- [ ] **Step 2: Run backend lint/tests narrowly**

```bash
uv run ruff check src/aiq_agent
uv run pytest tests/ -q --tb=short
```

Expected: ruff passes; pytest may still have tests referencing removed packages (e.g., `aiq_api` tests for removed features) — note them but do not fix unrelated failures here.

- [ ] **Step 3: Mark phase complete**

Update the parent TodoWrite: Phase 1 complete.
