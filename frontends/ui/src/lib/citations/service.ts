/**
 * Citation-health service: business logic over the citation-event repository.
 * Caller authorization (requirePlatformPermission) happens in the routes — this
 * module is data-only, mirroring `lib/profiler/service.ts`.
 *
 * Turns the raw ledger into the one snapshot the platform dashboard renders:
 * how often citation verification had to intervene, what it caught, why, on
 * which retrieval lanes, for which organizations, and which turns to inspect.
 */

import 'server-only'
import {
  CITATION_BASELINE_KIND,
  CITATION_EVENT_KINDS,
  CITATION_PRECISION_KIND,
  type CitationEvent,
  type CitationEventAgent,
  type CitationEventKind,
  type CitationEventSeverity,
  type NewCitationEvent,
} from '@/lib/db/schema'
import { getWorkOS } from '@/lib/workos/client'
import { getKnowledgeBaseStatus } from '@/lib/knowledge/service'
import { getNormRegistry } from '@/lib/norms/service'
import { buildMissingSourceCandidates, type MissingSourceCandidate } from './missing-sources'
import * as repository from './repository'
import { clampWindowDays } from './window'

export { clampWindowDays, DEFAULT_WINDOW_DAYS, parseWindowDaysParam } from './window'

export async function recordCitationEvents(events: NewCitationEvent[]): Promise<number> {
  return repository.insertCitationEvents(events)
}

/** Every kind except the per-turn baseline row — i.e. the things that went wrong. */
export const CITATION_DEFECT_KINDS = CITATION_EVENT_KINDS.filter(
  (kind) => kind !== CITATION_BASELINE_KIND && kind !== CITATION_PRECISION_KIND,
) as readonly Exclude<CitationEventKind, 'turn_verified' | 'retrieval_precision'>[]

/** Midnight UTC today — the same day boundary the spend ledger uses. */
export function utcDayStart(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export interface CitationKindTotal {
  kind: CitationEventKind
  /** Turns that hit this defect. */
  turns: number
  /** Individual items behind those turns (citations dropped, quotes unverified, …). */
  items: number
  /** Share of observed turns, 0–1. Zero when nothing was observed. */
  share: number
}

export interface CitationDailyPoint {
  day: string
  /** Research turns observed that day. */
  turns: number
  /** Of those, how many carried at least one defect. */
  defectTurns: number
  /** Turns per defect kind — the stacked series. */
  byKind: Record<string, number>
}

export interface CitationReasonTotal {
  kind: CitationEventKind
  reason: string
  occurrences: number
  /** Share of all reason occurrences in the window, 0–1. */
  share: number
}

export interface CitationOrganizationTotal {
  organizationId: string | null
  name: string | null
  turns: number
  defectTurns: number
  errorTurns: number
  /** defectTurns / turns, 0–1. Zero when no baseline rows landed. */
  defectRate: number
}

export interface CitationDefectSample {
  id: string
  createdAt: string
  kind: CitationEventKind
  severity: CitationEventSeverity
  agent: CitationEventAgent
  count: number
  reasons: Record<string, number> | null
  organizationId: string | null
  conversationId: string | null
  /** Shared with `agent_profiler_spans.turnId` — the link into the profiler timeline. */
  turnId: string
}

// ---------------------------------------------------------------------------
// Findings — the "what do I actually do about this" layer
// ---------------------------------------------------------------------------

/**
 * A diagnosis with a remedy, derived deterministically from the window's
 * rollups. Counts alone tell an operator that something is wrong but not what
 * to change; each finding names the likely cause, the thing to look at, and
 * the evidence behind it. The UI owns the prose (i18n keyed on `id`) — this
 * layer owns the rules and the numbers, so they are testable.
 */
export interface CitationFinding {
  id: CitationFindingId
  severity: 'error' | 'warn' | 'info'
  /** The concrete thing to look at (an organization, a tool), when there is one. */
  subject: { type: 'organization' | 'tool'; label: string } | null
  /** Interpolated into the localized copy: `{turns}`, `{share}` (already a %) … */
  metrics: Record<string, number>
}

export type CitationFindingId =
  | 'retrieval_unavailable'
  | 'answers_ungrounded'
  | 'citations_invented'
  | 'quotes_fabricated'
  | 'citation_format_unparsed'
  | 'duplicates_only'
  | 'organization_outlier'
  | 'sources_missing'
  | 'sources_unretrievable'
  | 'all_clear'

/** Rule thresholds. Deliberately explicit so tuning is one obvious edit. */
const THRESHOLDS = {
  /** Below this share of turns a defect is noise, not a trend. */
  ungroundedShare: 0.01,
  quotesShare: 0.02,
  fallbackShare: 0.05,
  removedShare: 0.05,
  /** Share of removal reasons that must be "not in registry" to blame invention. */
  inventedReasonShare: 0.4,
  /** Share of removal reasons that must be duplicates to call it cosmetic. */
  duplicateReasonShare: 0.5,
  /** Minimum turns before an organization's rate is worth comparing. */
  outlierMinTurns: 20,
  /** How many times the platform rate an organization must hit to stand out. */
  outlierRateMultiple: 2,
} as const

const SEVERITY_RANK: Record<CitationFinding['severity'], number> = { error: 0, warn: 1, info: 2 }
const pct = (value: number): number => Math.round(value * 1000) / 10

/**
 * Turn the window's rollups into a prioritized action list.
 *
 * Exported for tests: the rules ARE the product here, and they must be
 * verifiable without a database.
 */
export function buildFindings(input: {
  turns: number
  defectTurns: number
  byKind: CitationKindTotal[]
  reasons: CitationReasonTotal[]
  organizations: CitationOrganizationTotal[]
  unavailableTools: repository.UnavailableToolRow[]
  missingSources?: MissingSourceCandidate[]
  /**
   * Distinct turns behind the missing-source candidates, split by whether the
   * platform holds the source. Per-candidate `turns` cannot be summed (several
   * sources are typically rejected on the SAME turn), so the union comes from
   * the database; without it we fall back to the only bound we can prove.
   */
  missingSourceTurns?: { held: number; addable: number }
}): CitationFinding[] {
  const { turns, defectTurns, byKind, reasons, organizations, unavailableTools } = input
  const missingSources = input.missingSources ?? []
  if (turns === 0) return []

  const kindTurns = (kind: CitationEventKind): number => byKind.find((row) => row.kind === kind)?.turns ?? 0
  const kindItems = (kind: CitationEventKind): number => byKind.find((row) => row.kind === kind)?.items ?? 0
  const reasonShare = (...keys: string[]): number =>
    reasons.filter((row) => keys.includes(row.reason)).reduce((sum, row) => sum + row.share, 0)

  const findings: CitationFinding[] = []

  // The cited sources verification rejected, split by whether the platform
  // holds them. The split drives two mutually exclusive diagnoses below, so it
  // is computed once, up front.
  // `unheld` is the invention signal: the platform holds it nowhere, whatever
  // can be done about that. `addable` is the subset with a remedy — a web page
  // is not addable to the corpus, but citing one that was never retrieved is
  // still the model writing a source out of thin air.
  const unheld = missingSources.filter((candidate) => !candidate.present)
  const addable = unheld.filter((candidate) => candidate.action !== 'none')
  const heldButUnretrieved = missingSources.filter((candidate) => candidate.present)
  // Upper bound when the exact union is unavailable: a turn cannot be flagged
  // more often than it was flagged. Summing per-candidate turns would report
  // more turns than the whole window contains.
  const boundedTurns = (candidates: MissingSourceCandidate[], exact: number | undefined): number =>
    exact ?? Math.min(defectTurns, candidates.reduce((sum, candidate) => sum + candidate.turns, 0))

  // A retrieval integration is down — nothing else matters until it is back.
  const emptyTurns = kindTurns('registry_empty')
  if (emptyTurns > 0) {
    findings.push({
      id: 'retrieval_unavailable',
      severity: 'error',
      subject: unavailableTools[0] ? { type: 'tool', label: unavailableTools[0].tool } : null,
      metrics: { turns: emptyTurns, tools: unavailableTools.length },
    })
  }

  // Answers shipped with the visible "Ohne Quellenangabe" gap.
  const ungroundedTurns = kindTurns('answer_ungrounded')
  if (ungroundedTurns / turns >= THRESHOLDS.ungroundedShare) {
    findings.push({
      id: 'answers_ungrounded',
      severity: 'error',
      // Deliberately unattributed. The per-org rollup counts ALL defects, so the
      // worst org there may have zero ungrounded answers — naming it would send
      // an operator to audit the wrong tenant's corpus. Attributing this needs a
      // per-org breakdown of `answer_ungrounded` specifically, which the rollup
      // does not carry.
      subject: null,
      metrics: { turns: ungroundedTurns, share: pct(ungroundedTurns / turns) },
    })
  }

  // The model cites sources no tool ever returned — a prompt/model problem,
  // not a retrieval one, and the verifier is the only thing catching it.
  //
  // `*_not_in_registry` means "not among the sources RETRIEVED on that turn",
  // NOT "unknown to the platform" — the two read alike and are opposite
  // diagnoses. When the corpus cross-check says every rejected source is one
  // the platform holds, the removals are already explained by
  // `sources_unretrievable` (an indexing fault), and accusing the model of
  // citing from memory would send an operator to rewrite a prompt over a
  // retrieval bug. We cannot prove the model did not also guess a filename that
  // happens to exist, so the tie goes to the explanation backed by evidence.
  const removedTurns = kindTurns('citations_removed')
  const inventedShare = reasonShare('url_not_in_registry', 'citation_key_not_in_registry')
  const inventionUnexplained = missingSources.length === 0 || unheld.length > 0
  if (
    removedTurns / turns >= THRESHOLDS.removedShare &&
    inventedShare >= THRESHOLDS.inventedReasonShare &&
    inventionUnexplained
  ) {
    findings.push({
      id: 'citations_invented',
      severity: 'warn',
      subject: null,
      metrics: {
        turns: removedTurns,
        citations: kindItems('citations_removed'),
        share: pct(inventedShare),
        unheld: unheld.length,
      },
    })
  }

  // Real section, fabricated quote — the pattern quote verification exists for.
  const quoteTurns = kindTurns('quote_unverified')
  if (quoteTurns / turns >= THRESHOLDS.quotesShare) {
    findings.push({
      id: 'quotes_fabricated',
      severity: 'warn',
      subject: null,
      metrics: { turns: quoteTurns, quotes: kindItems('quote_unverified'), share: pct(quoteTurns / turns) },
    })
  }

  // Nothing the model wrote survived parsing, but a source existed and was
  // appended for it — usually a citation-FORMAT mismatch, not a bad answer.
  const fallbackTurns = kindTurns('citation_fallback')
  if (fallbackTurns / turns >= THRESHOLDS.fallbackShare) {
    findings.push({
      id: 'citation_format_unparsed',
      severity: 'warn',
      subject: null,
      metrics: { turns: fallbackTurns, share: pct(fallbackTurns / turns) },
    })
  }

  // One tenant is much worse than the platform — look at THEIR corpus, not the
  // pipeline. Guarded on volume so a single bad turn cannot raise this.
  const platformRate = defectTurns / turns
  const outlier = organizations.find(
    (org) =>
      // The unattributed bucket (organizationId null) is not somewhere an
      // operator can go look, and it would render an empty subject label.
      org.organizationId !== null &&
      org.turns >= THRESHOLDS.outlierMinTurns &&
      platformRate > 0 &&
      org.defectRate >= platformRate * THRESHOLDS.outlierRateMultiple,
  )
  if (outlier) {
    findings.push({
      id: 'organization_outlier',
      severity: 'warn',
      subject: { type: 'organization', label: outlier.name ?? outlier.organizationId! },
      metrics: {
        share: pct(outlier.defectRate),
        platformShare: pct(platformRate),
        turns: outlier.defectTurns,
      },
    })
  }

  // A specific source is cited over and over and the platform does not hold it
  // — the one finding with a concrete, addable remedy attached.
  if (addable.length > 0) {
    findings.push({
      id: 'sources_missing',
      severity: 'warn',
      subject: { type: 'tool', label: addable[0].fileName ?? addable[0].target },
      metrics: {
        sources: addable.length,
        turns: boundedTurns(addable, input.missingSourceTurns?.addable),
        automatic: addable.filter((candidate) => candidate.action === 'add_to_norm_catalog').length,
      },
    })
  }

  // The opposite case, and a genuinely different fix: the platform HAS the
  // source, so retrieval or indexing is at fault, not the corpus.
  if (heldButUnretrieved.length > 0) {
    findings.push({
      id: 'sources_unretrievable',
      severity: 'warn',
      subject: { type: 'tool', label: heldButUnretrieved[0].fileName ?? heldButUnretrieved[0].target },
      metrics: {
        sources: heldButUnretrieved.length,
        turns: boundedTurns(heldButUnretrieved, input.missingSourceTurns?.held),
      },
    })
  }

  // Duplicates dominate: cosmetic, and explicitly NOT worth acting on. Said out
  // loud so a big "citations removed" number is not mistaken for a crisis.
  if (defectTurns > 0 && reasonShare('duplicate') >= THRESHOLDS.duplicateReasonShare) {
    findings.push({
      id: 'duplicates_only',
      severity: 'info',
      subject: null,
      metrics: { share: pct(reasonShare('duplicate')) },
    })
  }

  if (findings.length === 0) {
    return [{ id: 'all_clear', severity: 'info', subject: null, metrics: { turns, share: pct(1 - platformRate) } }]
  }

  return findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.metrics.turns ?? 0) - (a.metrics.turns ?? 0),
  )
}

export interface CitationHealthSnapshot {
  windowDays: number
  totals: {
    /** Research turns that reached citation verification in the window. */
    turns: number
    /** Turns carrying >=1 defect. */
    defectTurns: number
    /** turns - defectTurns. */
    cleanTurns: number
    /** cleanTurns / turns, 0–1. 1 when nothing was observed (nothing is broken). */
    cleanRate: number
    /** Individual citations the verifier dropped. */
    citationsRemoved: number
    /** Quoted spans that matched no retrieved passage. */
    unverifiedQuotes: number
    /** Answers shipped with the "Ohne Quellenangabe" gap. */
    ungroundedAnswers: number
    /** Turns that captured no source at all. */
    emptyRegistries: number
  }
  /** Prioritized diagnoses + remedies; the first thing the dashboard renders. */
  findings: CitationFinding[]
  byKind: CitationKindTotal[]
  dailyTrend: CitationDailyPoint[]
  reasons: CitationReasonTotal[]
  sourceMix: repository.SourceMixRow[]
  /** Retrieval tools reported unavailable on turns that captured no source. */
  unavailableTools: repository.UnavailableToolRow[]
  /** Sources answers keep citing that the platform does not (verifiably) hold. */
  missingSources: MissingSourceCandidate[]
  organizations: CitationOrganizationTotal[]
  recent: CitationDefectSample[]
}

function toSample(event: CitationEvent): CitationDefectSample {
  return {
    id: event.id,
    createdAt: event.createdAt.toISOString(),
    kind: event.kind as CitationEventKind,
    severity: event.severity as CitationEventSeverity,
    agent: event.agent as CitationEventAgent,
    count: event.count,
    reasons: (event.reasons as Record<string, number> | null) ?? null,
    organizationId: event.organizationId,
    conversationId: event.conversationId,
    turnId: event.turnId,
  }
}

// ---------------------------------------------------------------------------
// Diagnostic export
// ---------------------------------------------------------------------------

/** One flagged turn, with the sources involved and what went wrong on it. */
export interface CitationExportTurn {
  turnId: string
  conversationId: string | null
  organizationId: string | null
  organization: string | null
  agent: CitationEventAgent
  jobId: string | null
  occurredAt: string
  /** How many sources retrieval captured, and how many the answer cited. */
  sourceCount: number | null
  citedCount: number | null
  /** Source identities retrieval returned on this turn (document keys / URLs). */
  retrievedSources: string[]
  /** Source identities the answer cited and that survived verification. */
  citedSources: string[]
  problems: {
    kind: CitationEventKind
    severity: CitationEventSeverity
    /** How many items this problem covers (citations dropped, quotes, …). */
    count: number
    reasons: Record<string, number> | null
    /** The specific sources that failed, and why: `{target, reason}`. */
    failedSources: { target: string; reason: string }[]
  }[]
}

export interface CitationExportBundle {
  /** What this file is, so an agent reading it cold knows the contract. */
  schema: 'grid.citation-health.export/v1'
  generatedAt: string
  windowDays: number
  windowStart: string
  /** True when the row cap was reached — the export is a prefix, not the whole window. */
  truncated: boolean
  /** Plain-language description of every problem kind, for an agent's benefit. */
  glossary: Record<string, string>
  summary: CitationHealthSnapshot['totals'] & { findings: CitationFinding[] }
  turns: CitationExportTurn[]
}

/**
 * What each problem kind MEANS. Shipped inside the export so an AI agent given
 * the file needs no other context to reason about it.
 */
const EXPORT_GLOSSARY: Record<string, string> = {
  citations_removed:
    'Citation verification removed one or more citations the model wrote because their target was not among the sources retrieval actually returned. failedSources lists the cited target and the reason.',
  quote_unverified:
    'A passage the answer put in quotation marks could not be found (fuzzy match) in any retrieved passage. The cited documents are listed; the quoted wording itself is deliberately not recorded.',
  answer_ungrounded:
    'Sources were retrieved but no citation survived verification, so the answer shipped with a visible "without source citation" gap. retrievedSources shows what the model had available and ignored.',
  registry_empty:
    'The turn captured no source at all — retrieval returned nothing. detail.unavailable_tools names the tools reported unavailable.',
  citation_fallback:
    'Nothing the model cited survived verification, but exactly one retrieved source existed and was attached automatically. Usually a citation-format mismatch rather than a wrong answer.',
  confidence_capped:
    'The deterministic overconfidence guard downgraded the answer\'s self-reported confidence to "low". The reason is either ungrounded or quote_unverified.',
  retrieval_precision:
    'Info-only: how many of the sources retrieval returned for the turn were actually cited in the answer. detail.retrieved_count / cited_count / uncited_count / uncited_sources quantify the gap; not a defect.',
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const asNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null)

function asFailedSources(value: unknown): { target: string; reason: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const { target, reason } = item as { target?: unknown; reason?: unknown }
    if (typeof target !== 'string') return []
    return [{ target, reason: typeof reason === 'string' ? reason : 'unverifiable' }]
  })
}

/**
 * Group the window's raw events into one record per flagged turn, resolving
 * "what was the source" and "what was the problem" into the same object.
 *
 * Clean turns are omitted: the export exists to be handed to an agent for
 * diagnosis, and a turn with nothing wrong carries no signal. Counts for the
 * whole window still live in `summary`.
 */
export async function getCitationExport(options: { days?: number } = {}): Promise<CitationExportBundle> {
  const windowDays = clampWindowDays(options.days)
  const start = utcDayStart()
  start.setUTCDate(start.getUTCDate() - (windowDays - 1))

  const [rows, snapshot] = await Promise.all([
    repository.listEventsForExport(start),
    getCitationHealth({ days: windowDays }),
  ])

  const capped = rows.length > repository.EXPORT_ROW_CAP
  const events = capped ? rows.slice(0, repository.EXPORT_ROW_CAP) : rows

  const byTurn = new Map<string, CitationEvent[]>()
  for (const event of events) {
    const list = byTurn.get(event.turnId)
    if (list) list.push(event)
    else byTurn.set(event.turnId, [event])
  }

  const turns: CitationExportTurn[] = []
  for (const [turnId, turnEvents] of byTurn) {
    const problems = turnEvents.filter(
      (event) => event.kind !== CITATION_BASELINE_KIND && event.kind !== CITATION_PRECISION_KIND,
    )
    if (problems.length === 0) continue

    const baseline = turnEvents.find((event) => event.kind === CITATION_BASELINE_KIND)
    const head = baseline ?? problems[0]
    const detailOf = (event: CitationEvent): Record<string, unknown> =>
      (event.detail as Record<string, unknown> | null) ?? {}

    // Retrieved/cited identities live on whichever event carried them: the
    // baseline row for a verified turn, the defect row for a failed one.
    const retrieved = new Set<string>()
    const cited = new Set<string>()
    for (const event of turnEvents) {
      for (const label of asStringArray(detailOf(event).retrieved_sources)) retrieved.add(label)
      for (const label of asStringArray(detailOf(event).cited_sources)) cited.add(label)
    }

    turns.push({
      turnId,
      conversationId: head.conversationId,
      organizationId: head.organizationId,
      organization: head.organizationId
        ? (snapshot.organizations.find((org) => org.organizationId === head.organizationId)?.name ?? null)
        : null,
      agent: head.agent as CitationEventAgent,
      jobId: head.jobId,
      occurredAt: head.createdAt.toISOString(),
      sourceCount: asNumber(detailOf(head).source_count),
      citedCount: asNumber(detailOf(head).cited_count),
      retrievedSources: [...retrieved],
      citedSources: [...cited],
      problems: problems.map((event) => ({
        kind: event.kind as CitationEventKind,
        severity: event.severity as CitationEventSeverity,
        count: event.count,
        reasons: (event.reasons as Record<string, number> | null) ?? null,
        failedSources: asFailedSources(detailOf(event).targets),
      })),
    })
  }

  return {
    schema: 'grid.citation-health.export/v1',
    generatedAt: new Date().toISOString(),
    windowDays,
    windowStart: start.toISOString(),
    truncated: capped,
    glossary: EXPORT_GLOSSARY,
    summary: { ...snapshot.totals, findings: snapshot.findings },
    turns,
  }
}

/**
 * What the platform currently holds: base-corpus filenames and catalogued RIS
 * document numbers. Best-effort — an unreachable backend yields empty
 * inventories, which makes every candidate read as "not held". That is the
 * safer failure direction (it over-reports work to do rather than declaring
 * everything fine), and the UI labels an unknown inventory as such.
 */
async function platformInventory(): Promise<{ corpusFileNames: string[]; documentNumbers: string[]; known: boolean }> {
  const [corpus, norms] = await Promise.all([
    getKnowledgeBaseStatus().catch(() => null),
    getNormRegistry().catch(() => null),
  ])
  return {
    corpusFileNames: (corpus?.files ?? []).map((file) => file.fileName).filter((name): name is string => Boolean(name)),
    documentNumbers: (norms?.registry?.entries ?? [])
      .map((entry) => entry.document_number)
      .filter((value): value is string => Boolean(value)),
    known: corpus !== null && norms !== null,
  }
}

/**
 * Organization id -> display name, best-effort. A WorkOS outage must degrade
 * the card to bare ids, never fail the whole snapshot.
 */
async function organizationNames(): Promise<Map<string, string>> {
  try {
    const list = await getWorkOS().organizations.listOrganizations({ limit: 100 })
    return new Map(list.data.map((org) => [org.id, org.name]))
  } catch {
    return new Map()
  }
}

/** Zero-fill the daily series so a quiet day renders as a gap, not a missing column. */
function buildDailyTrend(
  kindRows: repository.DailyKindRow[],
  turnRows: repository.DailyTurnRow[],
  start: Date,
  days: number,
): CitationDailyPoint[] {
  const kindsByDay = new Map<string, repository.DailyKindRow[]>()
  for (const row of kindRows) {
    if (row.kind === CITATION_BASELINE_KIND || row.kind === CITATION_PRECISION_KIND) continue
    const list = kindsByDay.get(row.day)
    if (list) list.push(row)
    else kindsByDay.set(row.day, [row])
  }
  const turnsByDay = new Map(turnRows.map((row) => [row.day, row.turns]))

  const series: CitationDailyPoint[] = []
  const cursor = new Date(start)
  for (let index = 0; index < days; index += 1) {
    const day = cursor.toISOString().slice(0, 10)
    const turns = turnsByDay.get(day) ?? 0
    const byKind: Record<string, number> = {}
    for (const row of kindsByDay.get(day) ?? []) byKind[row.kind] = row.turns
    const kindTurns = Object.values(byKind)
    series.push({
      day,
      turns,
      // A turn can carry several defects at once, so the per-kind turn counts
      // are NOT additive. The honest "how many turns were bad" figure is at
      // least the largest single kind and at most the turns observed that day;
      // we take the lower bound rather than overstate the damage.
      defectTurns: Math.min(turns, kindTurns.length > 0 ? Math.max(...kindTurns) : 0),
      byKind,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return series
}

/**
 * The full citation-health snapshot for the platform dashboard.
 *
 * Every rate is computed against `turn_verified` rows (one per observed
 * research turn), so a window with no research traffic reports a 100 % clean
 * rate rather than dividing by zero.
 */
export async function getCitationHealth(options: { days?: number } = {}): Promise<CitationHealthSnapshot> {
  const windowDays = clampWindowDays(options.days)
  const start = utcDayStart()
  start.setUTCDate(start.getUTCDate() - (windowDays - 1))

  const [
    kindRows,
    turns,
    defectTurns,
    dailyKindRows,
    dailyTurnRows,
    reasonRows,
    sourceMix,
    unavailableTools,
    orgRows,
    recentRows,
    names,
    failedTargets,
    inventory,
  ] = await Promise.all([
    repository.aggregateByKind(start),
    repository.countObservedTurns(start),
    repository.countDefectiveTurns(start),
    repository.aggregateDailyByKind(start),
    repository.aggregateDailyTurns(start),
    repository.aggregateReasons(start),
    repository.aggregateDefectiveSourceMix(start),
    repository.aggregateUnavailableTools(start),
    repository.aggregateByOrganization(start),
    repository.listRecentDefects(start),
    organizationNames(),
    repository.aggregateFailedTargets(start),
    platformInventory(),
  ])

  const missingSources = buildMissingSourceCandidates(
    failedTargets,
    inventory.corpusFileNames,
    inventory.documentNumbers,
  )

  // How many DISTINCT turns each half of that list accounts for. Per-candidate
  // counts overlap (one turn commonly cites several of them), so the union is
  // a second query rather than a sum — see `countTurnsForTargets`.
  const [heldTurns, addableTurns] = await Promise.all([
    repository.countTurnsForTargets(
      start,
      missingSources.filter((candidate) => candidate.present).map((candidate) => candidate.target),
    ),
    repository.countTurnsForTargets(
      start,
      missingSources
        .filter((candidate) => !candidate.present && candidate.action !== 'none')
        .map((candidate) => candidate.target),
    ),
  ])

  const byKindMap = new Map(kindRows.map((row) => [row.kind, row]))
  const cleanTurns = Math.max(0, turns - defectTurns)
  const share = (value: number): number => (turns > 0 ? value / turns : 0)

  const byKind: CitationKindTotal[] = CITATION_DEFECT_KINDS.map((kind) => {
    const row = byKindMap.get(kind)
    return { kind, turns: row?.turns ?? 0, items: row?.items ?? 0, share: share(row?.turns ?? 0) }
  })
    .filter((entry) => entry.turns > 0)
    .sort((a, b) => b.turns - a.turns)

  const reasonTotal = reasonRows.reduce((sum, row) => sum + row.occurrences, 0)
  const reasons: CitationReasonTotal[] = reasonRows.map((row) => ({
    ...row,
    share: reasonTotal > 0 ? row.occurrences / reasonTotal : 0,
  }))
  const organizations: CitationOrganizationTotal[] = orgRows
    .map((row) => ({
      organizationId: row.organizationId,
      name: row.organizationId ? (names.get(row.organizationId) ?? null) : null,
      turns: row.turns,
      defectTurns: row.defectTurns,
      errorTurns: row.errorTurns,
      defectRate: row.turns > 0 ? row.defectTurns / row.turns : 0,
    }))
    // Worst first, but an org with a single bad turn must not outrank one with
    // hundreds of bad turns — rate breaks ties on volume, not the reverse.
    .sort((a, b) => b.defectTurns - a.defectTurns || b.defectRate - a.defectRate)

  return {
    windowDays,
    totals: {
      turns,
      defectTurns,
      cleanTurns,
      cleanRate: turns > 0 ? cleanTurns / turns : 1,
      citationsRemoved: byKindMap.get('citations_removed')?.items ?? 0,
      unverifiedQuotes: byKindMap.get('quote_unverified')?.items ?? 0,
      ungroundedAnswers: byKindMap.get('answer_ungrounded')?.turns ?? 0,
      emptyRegistries: byKindMap.get('registry_empty')?.turns ?? 0,
    },
    findings: buildFindings({
      turns,
      defectTurns,
      byKind,
      reasons,
      organizations,
      unavailableTools,
      missingSources,
      missingSourceTurns: { held: heldTurns, addable: addableTurns },
    }),
    byKind,
    dailyTrend: buildDailyTrend(dailyKindRows, dailyTurnRows, start, windowDays),
    reasons,
    sourceMix,
    unavailableTools,
    missingSources,
    organizations,
    recent: recentRows.map(toSample),
  }
}
