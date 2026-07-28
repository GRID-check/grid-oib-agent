/**
 * Herleitung source fan-out (click-dummy overhaul spec §7).
 *
 * Builds parallel **per-document** source cards from thinking-step payloads:
 *  1. Prefer the backend `## Trace-Lanes` JSON block (KB tool — authoritative).
 *  2. Fallback: parse Collection:/Source:/Citation: blocks from KB wording.
 *  3. Fallback: URL scan for web/RIS tools.
 *
 * Lane keys / German labels mirror `norm_registry.lane_for_hit`. Provenance
 * signals map onto the `--source-*` token family (law / project / office / auto).
 *
 * Card shape matches the click-dummy `traceSources[]`:
 *   tab (label) · name · detail · "N Treffer" | gap
 */

import type { SourceSignal } from '@/features/layout/lib/source-presets'
import type { ThinkingStep } from '../types'
import { KIND_TO_SIGNAL, authorityTag, kindForLane } from './source-kinds'
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
    hitCount?: number
    sources?: Array<{ name?: string; title?: string; detail?: string }>
  }>
}

const TRACE_LANES_RE = /##\s*Trace-Lanes\s*\n\s*(\{[\s\S]*?\})\s*(?:\n|$)/i

const RESULT_BLOCK_RE =
  /---\s*Result\s+\d+\s*---\s*([\s\S]*?)(?=---\s*Result\s+\d+\s*---|$|##\s*Trace-Lanes)/gi

const SOURCE_RE = /^Source:\s*(.+)$/im
const COLLECTION_RE = /^Collection:\s*(.+)$/im
const CITATION_RE = /^Citation:\s*(.+)$/im
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

/** Backend OIB class → lane (mirror of `_OIB_CLASS_LANES`). */
const OIB_CLASS_LANES: Record<string, { key: string; label: string }> = {
  richtlinie: { key: 'baurecht_oib', label: 'OIB-Richtlinie' },
  leitfaden: { key: 'baurecht_oib_leitfaden', label: 'OIB-Leitfaden' },
  erlaeuterungen: { key: 'baurecht_oib_erlaeuterung', label: 'OIB-Erläuterung' },
  begriffsbestimmungen: { key: 'baurecht_oib_begriffe', label: 'OIB-Begriffsbestimmungen' },
  zitierte_normen: { key: 'baurecht_oib_referenz', label: 'OIB-Referenzdokument' },
  aenderungen: { key: 'baurecht_oib_diff', label: 'OIB-Änderungsdokument' },
}

const OIB_CLASS_PREFIXES: Array<[string, string]> = [
  ['aenderungen_', 'aenderungen'],
  ['erlaeuterungen_', 'erlaeuterungen'],
  ['oib-rl_begriffsbestimmungen', 'begriffsbestimmungen'],
  ['oib-rl_zitierte', 'zitierte_normen'],
]

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

const oibDocClass = (fileName: string): string | null => {
  const name = fileName.toLowerCase()
  if (
    !name.startsWith('oib-rl_') &&
    !name.startsWith('aenderungen_') &&
    !name.startsWith('erlaeuterungen_')
  ) {
    return null
  }
  for (const [prefix, docClass] of OIB_CLASS_PREFIXES) {
    if (name.startsWith(prefix)) return docClass
  }
  if (name.includes('leitfaden')) return 'leitfaden'
  return 'richtlinie'
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

/** Mirror of backend `lane_for_hit` for fallback parsing (no norm registry). */
export const laneForHitClient = (opts: {
  fileName?: string | null
  sourceUrl?: string | null
  collection?: string | null
}): { key: string; label: string } => {
  const collection = opts.collection?.trim() || null
  if (collection) {
    if (collection.startsWith('archiv_')) return { key: 'buero', label: 'Büroarchiv' }
    if (collection.startsWith('proj_') || collection.startsWith('s_')) {
      return { key: 'projekt', label: 'Projektwissen' }
    }
  }
  const fileName = opts.fileName?.trim() || null
  if (fileName) {
    const base = fileName.split(/[/\\]/).pop() || fileName
    const docClass = oibDocClass(base)
    if (docClass) return OIB_CLASS_LANES[docClass]
  }
  const host = hostOfSource(opts.sourceUrl)
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
  if (collection) {
    // Named KB collection that is not project/archiv → base corpus
    return { key: 'baurecht_oib', label: 'OIB-Richtlinie' }
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
        return { key, label, hitCount, sources, signal: laneKeyToSignal(key) }
      })
      .filter((c): c is TraceLaneCard => c != null)
  } catch {
    return null
  }
}

/** Fallback: walk Result blocks for Collection/Source/Citation lines. */
export const parseKbResultBlocks = (payload: string): TraceLaneCard[] => {
  const buckets = new Map<string, TraceLaneCard>()
  for (const match of payload.matchAll(RESULT_BLOCK_RE)) {
    const block = match[1] || ''
    const fileName = SOURCE_RE.exec(block)?.[1]?.trim()
    const collection = COLLECTION_RE.exec(block)?.[1]?.trim()
    const citation = CITATION_RE.exec(block)?.[1]?.trim()
    if (!fileName && !citation) continue
    const name = fileName || citation!.split(',')[0]!.trim()
    const detailFromCitation = citation?.includes(',')
      ? citation.split(',').slice(1).join(',').trim()
      : undefined
    const { key, label } = laneForHitClient({ fileName: name, collection })
    let card = buckets.get(key)
    if (!card) {
      card = { key, label, hitCount: 0, sources: [], signal: laneKeyToSignal(key) }
      buckets.set(key, card)
    }
    card.hitCount += 1
    // One entry per hit (same doc/page may repeat) so flatten can count Treffer.
    card.sources.push({ name, detail: detailFromCitation })
  }
  return Array.from(buckets.values())
}

/** Fallback: URL scan — RIS vs web. */
export const parseUrlHits = (payload: string): TraceLaneCard[] => {
  const urls = payload.match(URL_RE) || []
  if (urls.length === 0) return []
  const buckets = new Map<string, TraceLaneCard>()
  const seen = new Set<string>()
  for (const raw of urls) {
    const url = raw.replace(/[.,;:]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    const { key, label } = laneForHitClient({ sourceUrl: url })
    let card = buckets.get(key)
    if (!card) {
      card = { key, label, hitCount: 0, sources: [], signal: laneKeyToSignal(key) }
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
 * `allowUrlScan` gates the bare-URL fallback (`parseUrlHits`): the structured
 * `## Trace-Lanes` / `--- Result N ---` parsers are always safe (they only fire
 * on explicit backend markers), but the loose URL scan turns any link in free
 * text into a source card. Callers pass `false` for agent/orchestrator steps so
 * an echoed URL in the agent's prose cannot fabricate a phantom source.
 */
export const extractTraceLanesFromPayload = (
  payload: string,
  allowUrlScan = true
): TraceLaneCard[] => {
  if (!payload?.trim()) return []
  const fromBlock = parseTraceLanesBlock(payload)
  if (fromBlock && fromBlock.length > 0) return fromBlock
  const fromKb = parseKbResultBlocks(payload)
  if (fromKb.length > 0) return fromKb
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
    const signal = lane.signal
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
