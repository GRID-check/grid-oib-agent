/**
 * Herleitung source fan-out (click-dummy overhaul spec §7).
 *
 * Builds parallel **per-document** source cards from thinking-step payloads:
 *  1. The backend `## Trace-Lanes` JSON block — the authoritative classification
 *     for every knowledge-layer hit. It ships the fine lane (`key`/`label`) AND
 *     the coarse `kind` from `source_kinds.kind_for_lane`, i.e. exactly the
 *     taxonomy `source_entry_to_wire` puts on a citation, so this surface and
 *     the "Belegt durch" chips read one classification instead of two.
 *  2. URL scan for the web/RIS tools, which have no structured block of their
 *     own. Deliberately narrow — see `extractTraceLanesFromPayload`.
 *
 * Lane keys / German labels are produced by `norm_registry.lane_for_hit` on the
 * backend; nothing here re-derives them for knowledge-layer hits. Provenance
 * signals map onto the `--source-*` token family (law / project / office / auto).
 *
 * Card shape matches the click-dummy `traceSources[]`:
 *   tab (label) · name · detail · "N Treffer" | gap
 */

import type { SourceSignal } from '@/features/layout/lib/source-presets'
import type { ThinkingStep } from '../types'
import type { SourceKind } from './source-kinds'
import { KIND_TO_SIGNAL, asSourceKind, authorityTag, kindForLane } from './source-kinds'
import { documentShortName } from './document-names'

/** One document/source hit inside a lane (wire / storage intermediate). */
export interface TraceSourceHit {
  /** Raw document identity (corpus filename / hostname) — used for dedup. */
  name: string
  /**
   * Authoritative human title from the backend (stored `display_title` or its
   * derived default). Absent on older payloads and on the FE fallback parsers;
   * `documentShortName` then derives one from `name`.
   */
  title?: string
  detail?: string
}

/** Lane bucket on the wire (`## Trace-Lanes`) and in storage prune. */
export interface TraceLaneCard {
  key: string
  label: string
  hitCount: number
  sources: TraceSourceHit[]
  /**
   * Canonical coarse source kind (ADR-0026), as the backend classified it.
   * Optional because lanes persisted to localStorage before the wire carried it
   * only have `signal`; `signal` therefore stays the field every consumer reads.
   */
  kind?: SourceKind
  /** Provenance signal for --source-* tint */
  signal: SourceSignal
}

/**
 * One parallel card in the Herleitung fan-out (click-dummy `traceSources` item).
 * Individual document — not a lane aggregate.
 */
export interface TraceSourceCard {
  /** Stable list key */
  id: string
  laneKey: string
  /** Tab strip label (e.g. "OIB-Richtlinie", "Büroarchiv", "Lücke") */
  tabLabel: string
  signal: SourceSignal
  /** Compact authority badge (OIB / RIS / ÖNORM) — same as the Belegt-durch chips. */
  authority?: string
  /** Human display name — never a raw corpus filename. */
  name: string
  /** Raw filename behind `name`, kept for the tooltip and for source dedup. */
  fileName?: string
  detail?: string
  hitCount: number
  kind: 'hit' | 'gap'
}

/** Backend JSON shape under `## Trace-Lanes`. */
interface TraceLanesPayload {
  lanes?: Array<{
    key?: string
    label?: string
    /** Coarse source kind from `source_kinds.kind_for_lane` (ADR-0026). */
    kind?: string
    hitCount?: number
    sources?: Array<{ name?: string; title?: string; detail?: string }>
  }>
}

const TRACE_LANES_RE = /##\s*Trace-Lanes\s*\n\s*(\{[\s\S]*?\})\s*(?:\n|$)/i

/**
 * Markers that identify a payload as knowledge-layer tool output.
 * `_format_results` emits the `--- Result N ---` blocks and the `## Trace-Lanes`
 * summary into the SAME string, so either marker means "this payload's lanes are
 * owned by the structured block" — see `extractTraceLanesFromPayload`.
 */
const KB_OUTPUT_MARKER_RE = /---\s*Result\s+\d+\s*---|##\s*Trace-Lanes/i

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi

/**
 * Orchestrator / research-agent step names. Their function names contain
 * "research", which the tool heuristic's `/search/` matches — so without this
 * guard their PROSE gets URL-scanned as if it were tool evidence, and a URL the
 * agent merely echoes (e.g. the `oib.or.at` example link from the shallow-agent
 * prompt) becomes a phantom source card with no tool call behind it. We still
 * honor an explicit `## Trace-Lanes` / `--- Result N ---` block they re-emit;
 * we just never fabricate lanes from their bare text via the URL scan.
 */
const RESEARCH_AGENT_STEP_RE =
  /^(chat_researcher|chat_deepresearcher_agent|intent_classifier|depth_router|shallow_research|deep_research|meta_chatter)/i

/** Product-stratum tab when the fine lane label is too granular for the chip. */
const COARSE_TAB: Record<SourceSignal, string> = {
  law: 'Baurecht',
  project: 'Projektwissen',
  office: 'Büroarchiv',
  auto: 'Web',
}

/**
 * Lane key → provenance signal. Delegates to the canonical SourceKind mapping
 * (ADR-0026) so the Herleitung fan-out and the "Belegt durch" chips agree on
 * every lane — notably external norms (`norm_extern`) are `law`, not `web`.
 */
export const laneKeyToSignal = (key: string): SourceSignal => KIND_TO_SIGNAL[kindForLane(key)]

/** Prefer fine backend label; fall back to product stratum. */
export const tabLabelForLane = (laneKey: string, laneLabel: string): string => {
  const trimmed = laneLabel.trim()
  if (trimmed) return trimmed
  return COARSE_TAB[laneKeyToSignal(laneKey)]
}

/**
 * Host of a source URL, lowercased, or `null` when it has none.
 *
 * Scheme-less values (`wien.gv.at/x`) are still real host references, so they
 * get an assumed `https://` prefix before parsing.
 */
const hostOfSource = (url?: string | null): string | null => {
  const raw = (url || '').trim()
  if (!raw) return null
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * True when `host` is `domain` or a subdomain of it.
 *
 * Lanes are provenance labels, so they must key off the real host: a substring
 * test would also accept lookalike hosts (`wien.gv.at.evil.example`) and mere
 * path/query text (`evil.example/?q=wien.gv.at`). Mirrors `_host_matches` in
 * the backend `norm_registry`.
 */
const isHost = (host: string | null, domain: string): boolean =>
  !!host && (host === domain || host.endsWith(`.${domain}`))

/**
 * Lane for a bare URL — the *only* classification this module still performs.
 *
 * Web and RIS tools ship no structured lane block (unlike the knowledge layer,
 * whose `## Trace-Lanes` block is authoritative and is never second-guessed
 * here), so their URLs have to be placed client-side. Deliberately host-only:
 * the document-identity half of the old `lane_for_hit` mirror — OIB filename
 * classes and collection prefixes — is gone, because every payload that carried
 * a filename or a collection also carried the backend's own classification of it.
 */
export const laneForSourceUrl = (sourceUrl?: string | null): { key: string; label: string } => {
  const host = hostOfSource(sourceUrl)
  if (isHost(host, 'ris.bka.gv.at')) {
    return { key: 'baurecht_ris', label: 'Rechtsquelle (RIS)' }
  }
  // The official OIB site is the base OIB corpus, not a generic web hit.
  // Without this, any oib.or.at URL (e.g. the example link the shallow-agent
  // prompt hands the model) would default to the "Web" lane and read as a web
  // search — the OIB domain belongs in the Baurecht/OIB family.
  if (isHost(host, 'oib.or.at')) {
    return { key: 'baurecht_oib', label: 'OIB-Richtlinie' }
  }
  // wien.gv.at in norm-registry output is the curated MA-37 (Baupolizei Wien)
  // entry — official municipal building information, so it belongs to the
  // Baurecht family (behördliche Information), never the generic Web lane.
  if (isHost(host, 'wien.gv.at')) {
    return { key: 'behoerde', label: 'Behördliche Information' }
  }
  return { key: 'web', label: 'Web' }
}

const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return url.length > 48 ? `${url.slice(0, 47)}…` : url
  }
}

/** Parse the authoritative `## Trace-Lanes` JSON block if present. */
export const parseTraceLanesBlock = (payload: string): TraceLaneCard[] | null => {
  const match = payload.match(TRACE_LANES_RE)
  if (!match) return null
  try {
    const data = JSON.parse(match[1]) as TraceLanesPayload
    if (!Array.isArray(data.lanes) || data.lanes.length === 0) return null
    return data.lanes
      .map((lane): TraceLaneCard | null => {
        const key = (lane.key || '').trim()
        const label = (lane.label || '').trim()
        if (!key || !label) return null
        // The backend classifies the lane and ships the coarse kind with it.
        // `kindForLane` is the back-compat path for ONE case only: a message
        // persisted (or a stream produced) before the block carried `kind`. It
        // is the same shared lane→kind table the backend applies, so the two
        // agree by construction — it is a decode fallback, not a classifier.
        const kind = asSourceKind(lane.kind) ?? kindForLane(key)
        const sources = (lane.sources || [])
          .map((s): TraceSourceHit | null => {
            const name = (s.name || '').trim()
            if (!name) return null
            const detail = (s.detail || '').trim() || undefined
            const title = (s.title || '').trim() || undefined
            return { name, title, detail }
          })
          .filter((s): s is TraceSourceHit => s != null)
        const hitCount =
          typeof lane.hitCount === 'number' && lane.hitCount > 0
            ? lane.hitCount
            : Math.max(sources.length, 1)
        return { key, label, hitCount, sources, kind, signal: KIND_TO_SIGNAL[kind] }
      })
      .filter((c): c is TraceLaneCard => c != null)
  } catch {
    return null
  }
}

/** URL scan for the web/RIS tools — the only sources with no structured block. */
export const parseUrlHits = (payload: string): TraceLaneCard[] => {
  const urls = payload.match(URL_RE) || []
  if (urls.length === 0) return []
  const buckets = new Map<string, TraceLaneCard>()
  const seen = new Set<string>()
  for (const raw of urls) {
    const url = raw.replace(/[.,;:]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    const { key, label } = laneForSourceUrl(url)
    let card = buckets.get(key)
    if (!card) {
      const kind = kindForLane(key)
      card = { key, label, hitCount: 0, sources: [], kind, signal: KIND_TO_SIGNAL[kind] }
      buckets.set(key, card)
    }
    card.hitCount += 1
    // A hostname is already the human label — mark it as the authoritative
    // title so the filename humanizer never touches it (`ris.bka.gv.at` must
    // not become "Ris.bka.gv.at").
    const name = hostnameOf(url)
    card.sources.push({ name, title: name, detail: url })
  }
  return Array.from(buckets.values())
}

/**
 * Extract lane cards from one tool payload string.
 *
 * Knowledge-layer output classifies itself: `_format_results` writes the
 * `## Trace-Lanes` block into the same string as the `--- Result N ---` blocks,
 * backed by the store-authoritative `doc_class` and the norm registry — neither
 * of which exists on this side. So for a KB payload the block is the whole
 * answer: if it is missing or empty, the producer has already said "no lanes",
 * and we yield nothing rather than re-deriving a classification from strictly
 * less information (that mirror is what let the fan-out and the chips drift) or
 * URL-scanning retrieved passages, whose prose routinely contains links.
 *
 * No legacy adapter is kept for the pre-block KB format: messages reach
 * localStorage through `pruneMessageForStorage`, which drops
 * `content`/`rawPayload` and stores the already-derived `traceLanes`, so a
 * persisted message never re-enters this function. A live payload always comes
 * from the current backend.
 *
 * `allowUrlScan` gates the bare-URL scan for everything else: web/RIS tools have
 * no structured block, but the scan turns any link in free text into a source
 * card. Callers pass `false` for agent/orchestrator steps so an echoed URL in
 * the agent's prose cannot fabricate a phantom source.
 */
export const extractTraceLanesFromPayload = (
  payload: string,
  allowUrlScan = true
): TraceLaneCard[] => {
  if (!payload?.trim()) return []
  const fromBlock = parseTraceLanesBlock(payload)
  if (fromBlock && fromBlock.length > 0) return fromBlock
  if (KB_OUTPUT_MARKER_RE.test(payload)) return []
  return allowUrlScan ? parseUrlHits(payload) : []
}

const mergeCards = (into: Map<string, TraceLaneCard>, cards: TraceLaneCard[]) => {
  for (const card of cards) {
    let existing = into.get(card.key)
    if (!existing) {
      existing = {
        key: card.key,
        label: card.label,
        hitCount: 0,
        sources: [],
        kind: card.kind,
        signal: card.signal,
      }
      into.set(card.key, existing)
    }
    existing.hitCount += card.hitCount
    for (const src of card.sources) {
      existing.sources.push(src)
    }
  }
}

/**
 * Aggregate lane cards across thinking steps. Prefer compact `traceLanes`
 * (survives storage prune); else parse content/rawPayload.
 */
export const deriveTraceLanes = (
  steps: Array<
    Pick<ThinkingStep, 'content' | 'rawPayload' | 'traceLanes' | 'functionName' | 'category'>
  >
): TraceLaneCard[] => {
  const buckets = new Map<string, TraceLaneCard>()
  for (const step of steps) {
    if (step.traceLanes && step.traceLanes.length > 0) {
      mergeCards(buckets, step.traceLanes)
      continue
    }
    const payload = [step.content, step.rawPayload].filter(Boolean).join('\n')
    if (!payload.trim()) continue
    // Only tool-ish steps contribute sources; agent LLM chatter is skipped
    // unless it already has a Trace-Lanes block (re-emitted tooloidal text).
    const looksLikeTool =
      step.category === 'tools' ||
      /tool|search|knowledge|retriev|ris/i.test(step.functionName || '') ||
      /##\s*Trace-Lanes/i.test(payload) ||
      /---\s*Result\s+\d+\s*---/i.test(payload)
    if (!looksLikeTool) continue
    // Research/orchestrator steps match the tool heuristic only because
    // "reSEARCH" contains "search". Never scan their prose for source URLs
    // (that invents web cards from echoed example links); still honor an
    // explicit structured block inside extractTraceLanesFromPayload.
    const allowUrlScan = !RESEARCH_AGENT_STEP_RE.test((step.functionName || '').trim())
    mergeCards(buckets, extractTraceLanesFromPayload(payload, allowUrlScan))
  }
  // Stable-ish order: law first, then project, office, auto; within signal by label.
  const signalOrder: Record<SourceSignal, number> = {
    law: 0,
    project: 1,
    office: 2,
    auto: 3,
  }
  return Array.from(buckets.values()).sort((a, b) => {
    const sig = signalOrder[a.signal] - signalOrder[b.signal]
    if (sig !== 0) return sig
    return a.label.localeCompare(b.label, 'de')
  })
}

/** Flatten lane buckets into click-dummy per-document source cards. */
export const flattenTraceSourceCards = (lanes: TraceLaneCard[]): TraceSourceCard[] => {
  const byDoc = new Map<string, TraceSourceCard>()

  for (const lane of lanes) {
    const tabLabel = tabLabelForLane(lane.key, lane.label)
    // The canonical kind wins when the lane carries one; `signal` is what a
    // lane persisted before the wire shipped `kind` still has.
    const signal = lane.kind ? KIND_TO_SIGNAL[lane.kind] : lane.signal
    const authority = authorityTag(lane.key) ?? undefined
    if (lane.sources.length === 0) {
      // Layer count without names — one synthetic card for the lane.
      if (lane.hitCount <= 0) continue
      const id = `${lane.key}|*`
      byDoc.set(id, {
        id,
        laneKey: lane.key,
        tabLabel,
        signal,
        authority,
        name: lane.label,
        hitCount: lane.hitCount,
        kind: 'hit',
      })
      continue
    }

    for (const src of lane.sources) {
      // Dedup on the RAW name (document identity); the card shows the derived
      // display name, which several raw names could legitimately share.
      const id = `${lane.key}|${src.name}`
      const existing = byDoc.get(id)
      if (existing) {
        existing.hitCount += 1
        // Keep first non-http detail; append extra page refs if distinct.
        if (src.detail && !src.detail.startsWith('http')) {
          if (!existing.detail) {
            existing.detail = src.detail
          } else if (!existing.detail.includes(src.detail)) {
            existing.detail = `${existing.detail}, ${src.detail}`
          }
        }
      } else {
        byDoc.set(id, {
          id,
          laneKey: lane.key,
          tabLabel,
          signal,
          authority,
          name: documentShortName(src.name, src.title),
          fileName: src.name,
          detail: src.detail?.startsWith('http') ? undefined : src.detail,
          hitCount: 1,
          kind: 'hit',
        })
      }
    }

    // If backend hitCount > listed unique sources (only name listed once in
    // Trace-Lanes JSON), boost the first card so Treffer stays honest.
    const listed = lane.sources.length
    if (lane.hitCount > listed && listed > 0) {
      const firstName = lane.sources[0]!.name
      const first = byDoc.get(`${lane.key}|${firstName}`)
      if (first && first.hitCount < lane.hitCount && listed === 1) {
        first.hitCount = lane.hitCount
      } else if (first && listed > 1) {
        // distribute remainder onto first
        first.hitCount += lane.hitCount - listed
      }
    }
  }

  const signalOrder: Record<SourceSignal, number> = {
    law: 0,
    project: 1,
    office: 2,
    auto: 3,
  }
  return Array.from(byDoc.values()).sort((a, b) => {
    const sig = signalOrder[a.signal] - signalOrder[b.signal]
    if (sig !== 0) return sig
    const tab = a.tabLabel.localeCompare(b.tabLabel, 'de')
    if (tab !== 0) return tab
    return a.name.localeCompare(b.name, 'de')
  })
}

/** Lanes → individual source cards across thinking steps. */
export const deriveTraceSourceCards = (
  steps: Array<
    Pick<ThinkingStep, 'content' | 'rawPayload' | 'traceLanes' | 'functionName' | 'category'>
  >
): TraceSourceCard[] => flattenTraceSourceCards(deriveTraceLanes(steps))

/** Total unique source hits across lane cards (bar "m Quellen"). */
export const totalTraceSourceCount = (lanes: TraceLaneCard[]): number =>
  lanes.reduce((sum, lane) => sum + lane.hitCount, 0)

/** Total hits across flattened source cards. */
export const totalSourceCardHits = (cards: TraceSourceCard[]): number =>
  cards.reduce((sum, c) => sum + (c.kind === 'gap' ? 0 : c.hitCount), 0)
