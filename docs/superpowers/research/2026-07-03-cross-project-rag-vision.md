# Cross-Project RAG: The Grid Data Flywheel

> **Status:** Future idea — not an implementation plan.
> This document captures a strategic direction. No dates, no tasks, no commitments.

## The Problem

Right now, every project on Grid is an island. Project A's profile, files, and chat history are invisible to Project B. The agent never says "this looks like the Hochhausprojekt from Q2 2025 where the MEP routing conflicted with the sprinkler riser." It can't — it has no cross-project memory.

This means:

- **No pattern mining**: Every architect rediscovers the same solutions
- **No institutional memory**: When someone leaves, their project knowledge leaves with them
- **No predictive intelligence**: The agent can't warn about common failure modes because it's never seen one
- **No network effects**: 100 projects on Grid is not more valuable than 1 project on Grid

## The Vision

Grid becomes a **learning system**. Every project enriches a cross-project embedding index. The agent uses similar past projects to inform current decisions. The platform gets smarter with every project it hosts.

## Proposed Architecture

```
                    ┌─────────────────────┐
                    │   Cross-Project      │
                    │   Embedding Store    │
                    │   (pgvector)         │
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
   │  Project A   │    │  Project B   │    │  Project C   │
   │  Profile     │    │  Profile     │    │  Profile     │
   │  Files       │    │  Files       │    │  Files       │
   │  Decisions   │    │  Decisions   │    │  Decisions   │
   └──────────────┘    └──────────────┘    └──────────────┘
```

### Ingestion Sources

| Source | Embedding Strategy | Update Trigger |
|--------|-------------------|----------------|
| Project profile (facts + goals) | Full profile vector | On profile update |
| File contents (per chunk) | Chunk + embed pipeline | On file ingestion |
| Agent decisions (patches + accept/reject) | Decision + outcome vector | On patch accept |
| Chat summaries | Per-conversation summary vector | On conversation close |

### Query Flow

```
User asks: "What are the fire safety gotchas for a 6-story hotel?"

1. Embed the query
2. pgvector similarity search across ALL project embeddings
3. Return top K similar projects with relevance scores
4. Agent prompt includes: "Similar projects suggest: [summary]"
5. Architect sees: "3 similar projects found. Most relevant: Hotel X (Q1 2025) — approach: ..."
```

### What This Unlocks

1. **"Ask the portfolio"**: User asks a question and gets answers informed by every project the firm has ever done
2. **Pattern detection**: "80% of mixed-use projects in zone B2 required a variance on parking ratio"
3. **Risk prediction**: "Your project timeline estimate is 30% shorter than 5 similar projects — here's why"
4. **Design precedent**: "Building this in timber? Here are 3 timber-hybrid projects with similar parameters"
5. **Feedback loops**: Agent patch accept/reject becomes training signal — what do architects actually agree with?

## Technical Considerations

### Storage
- Existing Postgres can use pgvector extension (no new infrastructure)
- Embedding dimension: 768 (NV-Embed-QA) or 1536 (OpenAI ada-002)
- Index type: IVFFlat for <100K vectors, HNSW for >100K

### Privacy & Isolation
- Cross-project search must respect organization boundaries
- Project-level opt-out: "Exclude this project from cross-project learning"
- Tenant isolation: queries never cross organization_id

### Performance
- Profile embedding: ~100ms, on profile write (rare)
- File chunk embedding: async background job per file
- Query-time search: <50ms with proper indexing
- Agent prompt injection: cached embedding results with TTL

### MVP Scope (If Build)

```
Week 1-2:
  - Add pgvector extension to Postgres
  - Create embeddings table (project_id, chunk_id, embedding vector, source type, metadata)
  - Embed project profiles on write

Week 3-4:
  - Embed file chunks (reuse existing chunking from knowledge layer)
  - Simple similarity search API: GET /api/projects/{id}/similar?query=...

Week 5-6:
  - Inject similar projects into agent prompts
  - UI: "Similar projects" panel on project overview
  - Feedback: accept/reject similar project suggestions

Week 7-8:
  - Decision embedding (track patch accept/reject as training signal)
  - Cross-project pattern mining (basic statistical aggregation)
  - Agent uses patterns in recommendations
```

## Why Not Now

1. The foundation (project profiles, file ingestion, agent context injection) is still being stabilized
2. No embedding infrastructure exists yet — this is a new dependency
3. The immediate P0/P1 consolidation issues must ship first
4. Cross-project learning without a stable profile system would learn from broken data

## Readiness Gate

- [ ] Workstream A (context bugfixes) is deployed
- [ ] Workstream B (design coherence) is deployed
- [ ] Project intake wizard has been used on 10+ real projects
- [ ] Profile patch accept/reject flow is in production
- [ ] pgvector extension is available in the target Postgres environment
