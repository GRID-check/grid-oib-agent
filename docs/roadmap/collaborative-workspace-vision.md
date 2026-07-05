# Vision: The Compliance Workspace (collaborative, internal-team)

> Forward-looking product sketch — **not scoped for implementation.** Captured so
> the thinking isn't lost. Sibling to `cross-project-rag-vision.md`.

## Thesis

The next evolution of GRID is not "cloud storage with comments." It is a
**compliance workspace**: a project's hero view is a **compliance board** — the
applicable OIB standards GRID already derives — and files are the *evidence*
underneath, joined to standards by a first-class link. Collaboration is what makes
it multiplayer; the compliance board + the agent-as-reviewer is the wedge.

## Why not file-first

File-first competes with Dropbox / Drive / Bau-doc tools on features GRID will
lose. Leading with the compliance board answers the firm's real anxiety — *"will
this Einreichung pass, on what, who owns it, where's the evidence"* — which no
generic tool does.

## The model

- **Files ↔ requirements** are a many-to-many "evidence" link. Model that link and
  both views fall out: a **board view** (group by standard) and a **files view**
  (each file shows the standards it covers). One dataset, two lenses. Default
  landing = the board.
- **Collaboration primitives** attach to whichever unit fits: a file, a *spot* on a
  plan, or a requirement. Status (open / in review / satisfied), owner, versions,
  activity feed.

## The differentiator: the agent as a review participant

The agent already derives applicable standards and reads the plans (RAG), so it can:
- **propose the evidence links** (this plan is evidence for OIB 2 & 4),
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
