# Vision: The Collaborative Project Workspace (internal-team)

> **Read with [VISION.md](../../VISION.md).** This sketch predates it and is revised by [agentic-workspace-architecture.md](agentic-workspace-architecture.md). Where it calls Piloti a compliance workspace, the vision's frame holds: the workspace for architects, building law as one capability.

> Forward-looking product sketch — **not scoped for implementation.** Captured so
> the thinking isn't lost. Sibling to `cross-project-rag-vision.md`.
>
> **Substrate now specified.** The collaboration primitives this vision assumes —
> per-resource ACLs, real-time fan-out, mentions, and the notifications that carry
> them — are specified as requirements in
> [`../design/collaboration-sharing-and-inbox-spec.md`](../design/collaboration-sharing-and-inbox-spec.md),
> with shared chats as their first consumer. The board, the evidence links and the
> agent-as-reviewer described below sit on top of it: a compliance lane becomes
> another shareable resource type and "assigned to Anna" another inbox item type.

## Thesis

The next evolution of Piloti is not "cloud storage with comments." It is a
**project workspace** for the team: a project's files, building model and tasks sit
in one place, and a **compliance board** over the applicable OIB standards Piloti
already derives is the first lens on them. Files are the *evidence* underneath,
joined to standards by a first-class link. Collaboration is what makes
it multiplayer; the compliance board + the agent-as-reviewer is the wedge.

## Why not file-first

File-first competes with Dropbox / Drive / Bau-doc tools on features Piloti will
lose. Leading with the compliance board answers the firm's real anxiety — *"will
this Einreichung pass, on what, who owns it, where's the evidence"* — which no
generic tool does. Files stay the spine underneath: the board is a lens over them, not a replacement.

## The model

- **Files ↔ requirements** are a many-to-many "evidence" link. Model that link and
  both views fall out: a **board view** (group by standard) and a **files view**
  (each file shows the standards it covers). One dataset, two lenses. Default
  landing = the board.
- **Collaboration primitives** attach to whichever unit fits: a file, a *spot* on a
  plan, or a requirement. Status (open / in review / satisfied), owner, versions,
  activity feed.

## The differentiator: the agent as a review participant

The agent already derives applicable standards and reads the project's documents (RAG), so it can:
- **propose the evidence links** (this document is evidence for OIB 2 and 4),
- **pre-assess each lane** (OIB 4 looks unmet — WC door < 80 cm; OIB 6 has no
  evidence yet),
- draft the **gap list** humans then resolve, every claim grounded in the OIB corpus.

`remember` captures the decisions ("we treat the atrium as OIB 2.3") so teammates
and future conversations inherit them.

## v1 wedge (if ever built)

Board over applicable standards + status + owner; agent-proposed, human-confirmed
evidence links; comments on files + lanes; review status + version on files;
activity feed.

**Deliberately out (YAGNI):** live co-editing (Figma-style), external client/authority
portals, generic Drive-competing file features, heavy CAD/BIM processing.

## Architecture note

No file microservice. The collaborative core (board, links, ACLs, versions,
activity, presence) is shared consistent state that belongs with the single-writer
DB, WorkOS FGA, and the existing WebSocket gateway — a new **"workspace" bounded
context inside the BFF**, extending FGA (per-file review roles), the deletion model
(versioning + trash), and real-time fan-out over the existing WS. The only later
candidate for extraction is stateless *file processing*, and only when there is
processing to do.
