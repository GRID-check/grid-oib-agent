/**
 * Trace-lane PARSING — one of the citation model's producers, nothing more.
 *
 * This module turns thinking-step payloads into lane buckets and stops there.
 * It used to also flatten them into per-document render cards and derive their
 * tab labels, tints and hit tallies — a second, parallel presentation pipeline
 * that the answer's chips knew nothing about, which is why the Herleitung and
 * the "Belegt durch" row could disagree about a document's name and colour.
 * That half now lives in `lib/citations`, which builds the documents BOTH
 * surfaces render. What is left here is the parse:
 *  1. The backend `## Trace-Lanes` JSON block — the authoritative classification
 *     for every knowledge-layer hit. It ships the fine lane (`key`/`label`) AND
 *     the coarse `kind` from `source_kinds.kind_for_lane`, i.e. exactly the
 *     taxonomy `source_entry_to_wire` puts on a citation, so this surface and
 *     the "Belegt durch" chips read one classification instead of two.
 *  2. URL scan for the web/RIS tools, which have no structured block of their
 *     own. Deliberately narrow — see `extractTraceLanesFromPayload`.
 *
 * Lane keys / German labels are produced by `norm_registry.lane_for_hit` on the
 * backend; nothing here re-derives them for knowledge-layer hits.
 */

import type { SourceSignal } from '@/features/layout/lib/source-presets'
import type { ThinkingStep } from '../types'
import type { SourceKind } from './source-kinds'
import { KIND_TO_SIGNAL, asSourceKind, kindForLane } from './source-kinds'

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

/**
 * Lane key → provenance signal. Delegates to the canonical SourceKind mapping
 * (ADR-0026) so the Herleitung fan-out and the "Belegt durch" chips agree on
 * every lane — notably external norms (`norm_extern`) are `law`, not `web`.
 */
export const laneKeyToSignal = (key: string): SourceSignal => KIND_TO_SIGNAL[kindForLane(key)]

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

/** Total hits across lane buckets — the parser's own tally, before folding. */
export const totalTraceSourceCount = (lanes: TraceLaneCard[]): number =>
  lanes.reduce((sum, lane) => sum + lane.hitCount, 0)
