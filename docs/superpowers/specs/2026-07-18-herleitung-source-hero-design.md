# Herleitung Source-Hero Panel (Chat Thinking)

**Date:** 2026-07-18
**Status:** Design approved (UX direction locked); ready for implementation plan
**Branch:** `feature/research-trace-lanes`
**Related:** `docs/design/click-dummy-overhaul-spec.md` §7 · dummy `Ask Piloti v6 (standalone)` · ADR-0025 lane keys · `fix/oib-source-lane`

## Problem

Architects must trust *how* GRID reached an answer. Today the in-chat thinking UI is a **flat NAT function-step list** (“Web Search Tool”, timestamps). The click-dummy shows a **Herleitung** with parallel **per-document source cards** (provenance tab · name · detail · Treffer / Lücke). Backend already has `lane_for_hit` / `source_lane` and KB `Collection:` metadata; until this work they were not productized on the chat surface.

## Goals

1. In-chat **Herleitung** that makes **sources the hero** (what was touched, with signal colors and hit counts).
2. Match the dummy’s **information architecture**, not pixel-perfect chrome.
3. Prefer trust and scan speed over diagram novelty.
4. Reuse existing intermediate-step transport and lane helpers; minimal new wire.
5. Deep-research canvas (React Flow style) is **out of scope** for this change.

## Non-goals

- Pixel match of dummy layout, fonts, or single-turn theatrical staging.
- Embedding React Flow / xyflow / graphviz in the chat transcript.
- Full stage model (`understood` → findings → HITL decision → Ergebnis) beyond a light spine — only where it improves orientation without blocking ship.
- Emitting gap cards from the backend in v1 (gaps remain a future enhancement when catalog miss data is available).
- Changing deep-research Research panel tabs beyond optional shared card primitives later.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Graph library in chat | **No** | Canvas fights chat scroll, multi-turn collapse, and citation scanning. Graph tools reserved for a later deep-research debug/DAG view. |
| Layout | **Source-hero panel** | Dummy value is source cards + meta bar, not a flowchart. |
| Card grain | **One card per document/source**, not one card per lane aggregate | Dummy `traceSources[]` is `name + detail + hits` per doc; lane is the chip/tab. |
| Wire | **Prefer structured `## Trace-Lanes` on tool output**; FE fallbacks for web/RIS | Avoid new WS event types in v1; prune can keep derived cards after content strip. |
| Scope priority | **Chat Herleitung first** | User confirmed chat over deep-research panel. |
| Visual fidelity | **IA + provenance language**, not pixel clone | Aesthetic overhaul follows if needed. |

## UX contract

### Collapsed bar

Always visible under the user turn (existing placement in `ChatArea`):

```
[status icon]  Herleitung · {n} Zwischenschritte · {m} Quellen
                                                    [expand]
```

- **Working:** spinner + existing “Antwort wird erstellt …” (or short working label).
- **Done:** check.
- **Interrupted / waiting:** keep current icons and copy.
- `{n}` = thinking step count (product-facing steps; may exclude pure debug noise later).
- `{m}` = unique source-card count (hits + gaps), **not** enabled-toggle count.

### Expanded body (top → bottom)

1. **Optional light spine** (compact, non-blocking)
   Product stages as subtle chips or a one-line progress:
   `Verstehen → Recherchieren → Quellen → Antwort`
   Driven only from signals we already have (classifier/router complete, tool activity, final response). No fake timers. May ship as a thin second slice if spine mapping is ambiguous.

2. **Source fan-out (required)**
   Responsive grid/list of **source cards**:

   | Field | Source | Example |
   |-------|--------|---------|
   | `tabLabel` | backend lane label (fine) or coarse product tab | `OIB-Richtlinie`, `Büroarchiv` |
   | `signal` | map of lane key → `--source-*` | law / project / office / auto |
   | `name` | document / title | `OIB-RL 2 Brandschutz` |
   | `detail` | page, citation key, snippet, URL host | `S. 12 · oib_knowledge` |
   | `hits` | count string or gap | `3 Treffer` / `Nicht im Bestand` |
   | `kind` | `hit` \| `gap` | gap uses muted/auto signal |

   Card chrome: left inset or chip tint via existing `--source-law|project|office|auto` tokens + `SourceSignalChip`. Motion: light enter only (`nodeIn`-class restraint via existing motion primitives); no auto-collapse.

3. **Technical steps (secondary)**
   Existing chronological NAT steps stay, **collapsed by default** or under “Technische Schritte”, so power users and support still see Function Start/Complete without dominating the product surface.

4. **Enabled sources footer**
   Keep “Ausgewählte Datenquellen” as context (toggles + files), clearly secondary to **actual hits**.

### Multi-turn

Unchanged: one Herleitung block per user message that has steps. Do not collapse other turns when a new one streams.

### Deep research

Deep steps remain filtered out of the in-chat list (current behavior). Research panel unchanged in v1. Shared `TraceSourceCard` types may be reused later.

## Data model

### Frontend

```ts
// Product card (dummy-aligned)
interface TraceSourceCard {
  id: string
  laneKey: string
  tabLabel: string
  signal: SourceSignal  // law | project | office | auto
  name: string
  detail?: string
  hitCount: number
  kind: 'hit' | 'gap'
}

// Optional: keep intermediate lane buckets for wire/prune
interface TraceLaneCard {
  key: string
  label: string
  hitCount: number
  sources: { name: string; detail?: string }[]
  signal: SourceSignal
}
```

- `ThinkingStep` gains optional `traceLanes?: TraceLaneCard[]` (or derived-only at render time from `content` while streaming).
- Storage prune: after stripping step `content`, **persist derived source cards/lanes** so reload still shows Herleitung without raw payloads.

### Backend (KB / knowledge_layer)

After human-readable results, append:

```markdown
## Trace-Lanes
{"lanes":[{"key":"baurecht_oib","label":"OIB-Richtlinie","hitCount":2,"sources":[{"name":"…","detail":"…"}]}]}
```

- Build with existing `lane_for_hit` / collection metadata (`Collection:` already threaded — `fix/oib-source-lane`).
- Fail-open: never break tool output if JSON emit fails.
- Web/RIS tools: v1 may rely on FE URL/heuristic fallbacks; optional same block later.

### Lane → signal map (product)

| Lane keys (examples) | Signal |
|----------------------|--------|
| `baurecht_*`, `behoerde`, … | `law` |
| `projekt` | `project` |
| `buero` | `office` |
| `web`, `norm_extern`, `gap` | `auto` |

Fine German labels stay on the chip when present; coarse tabs (`Baurecht` / `Projektwissen` / …) are fallback only.

## Architecture

```
knowledge_layer._format_results
        │  ## Trace-Lanes JSON
        ▼
NAT intermediate payload (existing WS frames)
        ▼
use-websocket-chat → ThinkingStep.content (+ optional parse cache)
        ▼
trace-lanes.ts → deriveTraceSourceCards(steps)
        ▼
ChatThinking → bar + source grid + secondary steps
        ▼
prune-message-for-storage → keep cards/lanes, drop heavy content
```

No new BFF routes. No new WS message types in v1.

## Components / files (expected)

| Path | Role |
|------|------|
| `frontends/ui/src/features/chat/lib/trace-lanes.ts` | Parse wire, fallbacks, `deriveTraceSourceCards`, signal map |
| `frontends/ui/src/features/chat/components/ChatThinking.tsx` | Herleitung UI |
| `frontends/ui/src/features/chat/types.ts` | Optional `traceLanes` on step |
| `frontends/ui/src/features/chat/lib/prune-message-for-storage.ts` | Persist derived sources |
| `frontends/ui/src/i18n/dictionaries/{de,en}/chat.ts` | Herleitung strings |
| `sources/knowledge_layer/src/register.py` | Emit `## Trace-Lanes` |
| Tests: `trace-lanes.spec.ts`, ChatThinking specs, KB unit tests | |

## Error handling & empty states

- No sources derived → show steps + enabled-sources footer only; bar `m = 0` (“0 Quellen”), no empty card grid thrash.
- Malformed Trace-Lanes JSON → ignore block, use fallbacks.
- Interrupted mid-stream → keep partial cards + interrupted status.
- Gap cards: only if we have an explicit gap signal; do **not** invent Lücke cards for documents the model merely did not cite.

## Testing

- Unit: parse Trace-Lanes; Result-block fallback; URL fallback; collection → OIB lane; prune keeps cards without content.
- Component: collapsed meta string; expanded cards with name/detail/hits; gap styling; secondary steps hidden by default (if implemented that way).
- Backend: formatted KB output includes valid Trace-Lanes; no crash on empty hits.
- Manual: shallow OIB question shows **OIB-Richtlinie** (not Web/Projekt) on cards after `fix/oib-source-lane` + this work.

## Rollout

1. Backend Trace-Lanes emit (KB) + tests.
2. FE derive + ChatThinking source-hero + i18n.
3. Prune/persistence.
4. Docs: short note in `docs/design/click-dummy-overhaul-spec.md` (live mapping) and architecture if wire is mentioned.
5. Deep-research / React Flow: separate ADR later if needed.

## Success criteria

- Collapsed bar reads as **Herleitung · n Schritte · m Quellen** (localized).
- Expanded view gives an architect a 2-second answer to “which documents/lanes did we actually hit?”
- OIB base-corpus hits surface as Baurecht/OIB, not conflated with project/web.
- No graph canvas in chat; multi-turn step attachment unchanged.
- Reloaded conversations still show source cards after prune.

## Open follow-ups (explicitly deferred)

- Backend gap emission (catalog misses → true Lücke cards like dummy TRVB F 134).
- Structured “understood / findings” nodes.
- HITL option cards styled as Folgeweg.
- Deep-research DAG with React Flow.
- Dedicated intermediate event type if parse-from-payload proves fragile.
