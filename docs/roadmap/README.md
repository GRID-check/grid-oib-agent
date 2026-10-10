# Roadmap: where Piloti is going

Piloti is the workspace for architects and planning offices, and building law is one capability in it, not the frame. [VISION.md](../../VISION.md) says what the product is; where a roadmap doc disagrees with it, the doc is the one that is out of date.

Status is read from each doc's header. A **dated review** is a record of what was true on its date: its argument stays, and a banner points to the vision where its frame is superseded. **Live** docs are current and act on the code. Nothing here is a plan of record unless its header says so.

| Doc | Status | What it covers |
|---|---|---|
| [agent-spatial-reasoning.md](agent-spatial-reasoning.md) | dated proposal 2026-08-12, nothing built | Giving the agent a spatial model of an IFC building instead of a table of elements. Revisits ADR-0045. |
| [agentic-workspace-architecture.md](agentic-workspace-architecture.md) | dated review 2026-09-01; revises [collaborative-workspace-vision.md](collaborative-workspace-vision.md) | What Piloti becomes as an agentic workspace: what exists, where it stops, and the order to close the gaps. |
| [architect-workspace-voice-and-agentic-loop.md](architect-workspace-voice-and-agentic-loop.md) | live, research report 2026-09-08 | Voice, output shape and the agent loop for a chat turn. Its turn examples are copied, so they are kept current. |
| [collaborative-workspace-vision.md](collaborative-workspace-vision.md) | revised by [agentic-workspace-architecture.md](agentic-workspace-architecture.md) | A shared project workspace for the team, with a compliance board over the applicable standards. Not scoped. |
| [compliance-derivation-graph.md](compliance-derivation-graph.md) | dated review 2026-09-01 | Argues that a graph of facts, rules and decisions should replace the RAG chat baseline for building law. Companion to the agentic architecture review. |
| [continuous-improvement-ledger.md](continuous-improvement-ledger.md) | live, loop state | The improvement loop's running state: a ranked backlog and one row per iteration, with evidence. |
| [cross-project-rag-vision.md](cross-project-rag-vision.md) | superseded by [office-experience.md](office-experience.md) (2026-10-07) | The July goal of learning across projects. Kept for its reasoning; do not plan from it. |
| [feature-opportunities.md](feature-opportunities.md) | unclear: undated menu; frame superseded by VISION.md (banner) | A menu of feature options after the stabilization work, one shipped item, and a recommended sequence. |
| [ifc-compliance-ledger.md](ifc-compliance-ledger.md) | live, proposed | A ledger that records each check of the building model against the rules. Extends ADR-0045. |
| [ifc-review-findings.md](ifc-review-findings.md) | live, open findings | IFC/BIM review findings that are not fixed yet, each with its file and failure. |
| [ifc-viewer-capabilities.md](ifc-viewer-capabilities.md) | live, audit | What the ifc-lite packages offer against what the viewer uses, read from their type declarations. |
| [ifc-viewer-card-spec.md](ifc-viewer-card-spec.md) | superseded by ADR-0045 (2026-08-08) | The viewer card design that was considered and where it went wrong. |
| [office-experience.md](office-experience.md) | live, product direction 2026-10-07; replaces [cross-project-rag-vision.md](cross-project-rag-vision.md) | The office as Piloti's memory: the horizons, the access model, and the open questions for the product owner. |
| [oib-geometry-coverage.md](oib-geometry-coverage.md) | live, reference (verified 2026-08-13) | What each OIB-Richtlinie needs from the building model, and which operators an agent can call. |
| [piloti-writes-artifacts-and-approval.md](piloti-writes-artifacts-and-approval.md) | live, design of record 2026-09-10 | How Piloti writes documents: the working directory, the document lifecycle, and the publish step with approval. |
| [piloti-writes-perspective-review.md](piloti-writes-perspective-review.md) | dated review 2026-09-10 | A product review of what the Piloti writes branch delivers, and what it leaves open. |
| [plan-measurement-from-drawings.md](plan-measurement-from-drawings.md) | live, research note 2026-08-19 | Whether a dimension can be measured from a 2D drawing with one known length, and with what uncertainty. |
| [spatial-review-findings.md](spatial-review-findings.md) | dated review 2026-08-12 | An adversarial review of `ifc_measure` and `ifc-spatial-py`: defects reachable through the tool surface that no test catches. |

`agent-spatial-reasoning-architecture.excalidraw` is the diagram that goes with [agent-spatial-reasoning.md](agent-spatial-reasoning.md).
