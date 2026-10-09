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
import { getOrganizationDisplayNames } from '@/lib/organizations/display-names'
import { getKnowledgeBaseStatus } from '@/lib/knowledge/service'
import { getNormRegistry } from '@/lib/norms/service'
import { rangeDays, scopeBounds, type QualityScope } from '@/lib/quality/scope'
import {
  buildMissingSourceCandidates,
  type MissingSourceCandidate,
  type PlatformInventory,
} from './missing-sources'
import * as repository from './repository'

export async function recordCitationEvents(events: NewCitationEvent[]): Promise<number> {
  return repository.insertCitationEvents(events)
}

/** Every kind except the per-turn baseline row — i.e. the things that went wrong. */
export const CITATION_DEFECT_KINDS = CITATION_EVENT_KINDS.filter(
  (kind) => kind !== CITATION_BASELINE_KIND && kind !== CITATION_PRECISION_KIND
) as readonly Exclude<CitationEventKind, 'turn_verified' | 'retrieval_precision'>[]

/** The repository's filter for a scope: its UTC day bounds plus the id lists. */
export function citationScopeFilter(scope: QualityScope): repository.CitationScopeFilter {
  return {
    ...scopeBounds(scope),
    organizationIds: scope.organizationIds,
    projectIds: scope.projectIds,
  }
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
  /**
   * Share of THIS KIND's items in the window, 0–1: for `citations_removed`,
   * the share of removed citations dropped for this reason; for
   * `confidence_capped`, the share of capped answers. Never a share across
   * kinds, so reasons of different kinds do not add up to 1 together.
   */
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
  /**
   * Interpolated into the localized copy. Counts are plain integers; every
   * metric named `share` or `platformShare` is a FRACTION (0–1) the client
   * formats as a percentage in the reader's locale.
   */
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

/**
 * The organization the `organization_outlier` finding names, if any: enough
 * volume to compare, and at least `outlierRateMultiple` times the platform
 * rate. Exported so the service can resolve this one organization's name even
 * when it falls outside the displayed list.
 */
export function findOrganizationOutlier<
  T extends Pick<CitationOrganizationTotal, 'organizationId' | 'turns' | 'defectRate'>,
>(organizations: T[], platformRate: number): T | undefined {
  if (platformRate <= 0) return undefined
  return organizations.find(
    (org) =>
      // The unattributed bucket (organizationId null) is not somewhere an
      // operator can go look, and it would render an empty subject label.
      org.organizationId !== null &&
      org.turns >= THRESHOLDS.outlierMinTurns &&
      org.defectRate >= platformRate * THRESHOLDS.outlierRateMultiple
  )
}

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
  /** Distinct unavailable tools in the window; `unavailableTools` may be a top-N. */
  unavailableToolCount?: number
  /**
   * EVERY candidate the snapshot scanned, not the displayed top-N: the
   * findings' `sources` counts are totals and must be computed over all of them.
   */
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

  const kindTurns = (kind: CitationEventKind): number =>
    byKind.find((row) => row.kind === kind)?.turns ?? 0
  const kindItems = (kind: CitationEventKind): number =>
    byKind.find((row) => row.kind === kind)?.items ?? 0
  // Shares of REMOVED CITATIONS only, as the copy says ("{share}% of removed
  // citations"). Reasons of other kinds (`confidence_capped`) share the list,
  // and summing across kinds would mix two denominators.
  const reasonShare = (...keys: string[]): number =>
    reasons
      .filter((row) => row.kind === 'citations_removed' && keys.includes(row.reason))
      .reduce((sum, row) => sum + row.share, 0)

  const findings: CitationFinding[] = []

  // The cited sources verification rejected, split by whether the platform
  // holds them. The split drives two mutually exclusive diagnoses below, so it
  // is computed once, up front.
  // `unheld` is the invention signal: the platform holds it nowhere, whatever
  // can be done about that. `addable` is the subset with a remedy — a web page
  // is not addable to the corpus, but citing one that was never retrieved is
  // still the model writing a source out of thin air.
  // `present: null` (inventory unavailable) is in neither half: it is not
  // evidence the platform lacks the source, and not evidence it holds it.
  const unheld = missingSources.filter((candidate) => candidate.present === false)
  const addable = unheld.filter((candidate) => isAddable(candidate))
  const heldButUnretrieved = missingSources.filter((candidate) => candidate.present === true)
  // Upper bound when the exact union is unavailable: a turn cannot be flagged
  // more often than it was flagged. Summing per-candidate turns would report
  // more turns than the whole window contains.
  const boundedTurns = (candidates: MissingSourceCandidate[], exact: number | undefined): number =>
    exact ??
    Math.min(
      defectTurns,
      candidates.reduce((sum, candidate) => sum + candidate.turns, 0)
    )

  // A retrieval integration is down — nothing else matters until it is back.
  const emptyTurns = kindTurns('registry_empty')
  if (emptyTurns > 0) {
    findings.push({
      id: 'retrieval_unavailable',
      severity: 'error',
      subject: unavailableTools[0] ? { type: 'tool', label: unavailableTools[0].tool } : null,
      metrics: { turns: emptyTurns, tools: input.unavailableToolCount ?? unavailableTools.length },
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
      metrics: { turns: ungroundedTurns, share: ungroundedTurns / turns },
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
  // happens to exist, so the tie goes to the explanation backed by evidence —
  // and an unknown inventory is no evidence, so it leaves invention unexplained.
  const removedTurns = kindTurns('citations_removed')
  const inventedShare = reasonShare('url_not_in_registry', 'citation_key_not_in_registry')
  const inventionUnexplained =
    missingSources.length === 0 || missingSources.some((candidate) => candidate.present !== true)
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
        share: inventedShare,
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
      metrics: {
        turns: quoteTurns,
        quotes: kindItems('quote_unverified'),
        share: quoteTurns / turns,
      },
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
      metrics: { turns: fallbackTurns, share: fallbackTurns / turns },
    })
  }

  // One tenant is much worse than the platform — look at THEIR corpus, not the
  // pipeline. Guarded on volume so a single bad turn cannot raise this.
  const platformRate = defectTurns / turns
  const outlier = findOrganizationOutlier(organizations, platformRate)
  if (outlier) {
    findings.push({
      id: 'organization_outlier',
      severity: 'warn',
      subject: { type: 'organization', label: outlier.name ?? outlier.organizationId! },
      metrics: {
        share: outlier.defectRate,
        platformShare: platformRate,
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
      subject: {
        type: 'tool',
        label: heldButUnretrieved[0].fileName ?? heldButUnretrieved[0].target,
      },
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
      metrics: { share: reasonShare('duplicate') },
    })
  }

  if (findings.length === 0) {
    return [
      {
        id: 'all_clear',
        severity: 'info',
        subject: null,
        metrics: { turns, share: 1 - platformRate },
      },
    ]
  }

  return findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.metrics.turns ?? 0) - (a.metrics.turns ?? 0)
  )
}

/** A candidate with an add action the operator can take. */
const isAddable = (candidate: MissingSourceCandidate): boolean =>
  candidate.action === 'add_to_norm_catalog' || candidate.action === 'upload_to_base_knowledge'

/** How many rows the dashboard lists; totals are reported beside them. */
const MISSING_SOURCES_SHOWN = 25
const ORGANIZATIONS_SHOWN = 50

export interface CitationHealthSnapshot {
  /** The scope every figure below was read in, echoed so the client labels what it shows. */
  scope: QualityScope
  /** Days in the scope's range, inclusive. */
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
  /** Retrieval tools reported unavailable on turns that captured no source (top 8). */
  unavailableTools: repository.UnavailableToolRow[]
  /**
   * The most-cited sources verification rejected, cross-checked against what
   * the platform holds (top 25 by affected turns).
   */
  missingSources: MissingSourceCandidate[]
  /** Distinct rejected sources in the window; `missingSources` lists the first 25. */
  missingSourcesTotal: number
  /**
   * False when the corpus or the norm catalog could not be read. Candidates
   * that depend on the missing inventory then carry `present: null` and the
   * `inventory_unknown` action instead of an add.
   */
  inventoryKnown: boolean
  /** Most defective turns first (top 50). */
  organizations: CitationOrganizationTotal[]
  /** Organizations with any turn in the window; `organizations` lists the first 50. */
  organizationsTotal: number
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
  /**
   * The `retrieval_precision` observation for this turn, when one was
   * recorded: how many retrieved sources the answer used, and which it ignored.
   */
  precision: {
    retrievedCount: number | null
    citedCount: number | null
    uncitedCount: number | null
    uncitedSources: string[]
  } | null
  problems: {
    kind: CitationEventKind
    severity: CitationEventSeverity
    /** How many items this problem covers (citations dropped, quotes, …). */
    count: number
    reasons: Record<string, number> | null
    /** The specific sources that failed, and why: `{target, reason}`. */
    failedSources: { target: string; reason: string }[]
    /** `registry_empty` only: the retrieval tools reported unavailable. */
    unavailableTools: string[]
  }[]
}

export interface CitationExportBundle {
  /** What this file is, so an agent reading it cold knows the contract. */
  schema: 'grid.citation-health.export/v1'
  generatedAt: string
  /** The date range and the organizations/projects the export was taken in. */
  scope: QualityScope
  windowDays: number
  /** First instant in the range (UTC midnight of `scope.from`). */
  windowStart: string
  /** First instant AFTER the range (UTC midnight after `scope.to`). */
  windowEnd: string
  /** True when the row cap was reached — the export is a prefix, not the whole window. */
  truncated: boolean
  /** Plain-language description of every problem kind, for an agent's benefit. */
  glossary: Record<string, string>
  summary: CitationHealthSnapshot['totals'] & { findings: CitationFinding[] }
  turns: CitationExportTurn[]
}

/**
 * What each problem kind, reason and field MEANS. Shipped inside the export so
 * an AI agent given the file needs no other context to reason about it. Every
 * field named here is one the export actually carries — a glossary that
 * describes fields the file lacks sends its reader looking for them.
 *
 * The reason vocabularies mirror the emitter: removal reasons from
 * `verify_citations` (`citation_events.normalize_removal_reason`), confidence
 * reasons from `CappedReason` (`agents/piloti/markers.py`).
 */
const EXPORT_GLOSSARY: Record<string, string> = {
  scope:
    'The filter the export was taken in: UTC days from..to inclusive (windowStart <= occurredAt < windowEnd), and, when non-empty, only those organizationIds and projectIds. A project filter keeps only turns whose conversation belongs to one of those projects; turns with no recorded conversation are left out of it.',
  citations_removed:
    'Citation verification removed one or more citations the model wrote. problems[].reasons counts the removed citations by reason (see reason.*); problems[].failedSources lists each cited target and its reason.',
  quote_unverified:
    'A passage the answer put in quotation marks could not be found (fuzzy match) in any retrieved passage. citedSources lists the documents the answer cited; the quoted wording itself is deliberately not recorded.',
  answer_ungrounded:
    'Sources were retrieved but no citation survived verification, so the answer shipped with a visible "without source citation" gap. retrievedSources shows what the model had available; failedSources shows what it cited instead.',
  registry_empty:
    'The turn captured no source at all: retrieval returned nothing. problems[].unavailableTools names the tools reported unavailable.',
  citation_fallback:
    'Nothing the model cited survived verification, but exactly one retrieved source existed and was attached automatically. Usually a citation-format mismatch rather than a wrong answer.',
  confidence_capped:
    "The deterministic overconfidence guard lowered the answer's self-reported confidence. problems[].reasons holds exactly one confidence reason (see confidence.*).",
  precision:
    'Not a defect. turns[].precision is the retrieval_precision observation: retrievedCount unique sources retrieval returned, citedCount of them the answer cited, uncitedCount it ignored, and uncitedSources naming those (at most 10). null when the turn recorded none.',
  'reason.url_not_in_registry':
    'Removal: the cited URL was not among the sources retrieved on that turn. Means "not retrieved", not "unknown to the platform".',
  'reason.citation_key_not_in_registry':
    'Removal: the cited document key (file name, page) was not among the sources retrieved on that turn.',
  'reason.unverifiable':
    'Removal: the source line named no URL or document key the verifier could check.',
  'reason.digest_line_not_citable':
    "Removal: the line cited the conversation's read index (a digest line), not a retrieved passage.",
  'reason.duplicate': 'Removal: the citation repeated one already present in the same answer.',
  'confidence.ungrounded':
    'Confidence capped to low: no verified citation, and nothing was measured.',
  'confidence.quote_unverified':
    'Confidence capped to low: a quoted span matched no retrieved passage.',
  'confidence.normative_claim_uncited':
    'Confidence capped: the answer was grounded in a measurement but also made a legal claim without a verified citation.',
  'confidence.measurement_only':
    'Confidence reduced from high to medium: grounded in a measurement only and purely descriptive.',
  'confidence.citation_fallback':
    'Confidence capped: the only grounding is the single source attached automatically by the citation fallback.',
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const asNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null)

function asPrecision(detail: Record<string, unknown> | null): CitationExportTurn['precision'] {
  if (!detail) return null
  return {
    retrievedCount: asNumber(detail.retrieved_count),
    citedCount: asNumber(detail.cited_count),
    uncitedCount: asNumber(detail.uncited_count),
    uncitedSources: asStringArray(detail.uncited_sources),
  }
}

function asFailedSources(value: unknown): { target: string; reason: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const { target, reason } = item as { target?: unknown; reason?: unknown }
    if (typeof target !== 'string') return []
    return [{ target, reason: typeof reason === 'string' ? reason : 'unverifiable' }]
  })
}

const detailOf = (event: CitationEvent | undefined): Record<string, unknown> | null =>
  (event?.detail as Record<string, unknown> | null | undefined) ?? null

/**
 * One flagged turn's record, or null for a clean turn. Clean turns are
 * omitted: the export exists to be handed to an agent for diagnosis, and a
 * turn with nothing wrong carries no signal. Counts for the whole window still
 * live in `summary`.
 */
function toExportTurn(
  turnId: string,
  turnEvents: CitationEvent[],
  names: Map<string, string>
): CitationExportTurn | null {
  const problems = turnEvents.filter(
    (event) => event.kind !== CITATION_BASELINE_KIND && event.kind !== CITATION_PRECISION_KIND
  )
  if (problems.length === 0) return null

  const head = turnEvents.find((event) => event.kind === CITATION_BASELINE_KIND) ?? problems[0]

  // Retrieved/cited identities live on whichever event carried them: the
  // baseline row for a verified turn, the defect row for a failed one.
  const retrieved = new Set<string>()
  const cited = new Set<string>()
  for (const event of turnEvents) {
    for (const label of asStringArray(detailOf(event)?.retrieved_sources)) retrieved.add(label)
    for (const label of asStringArray(detailOf(event)?.cited_sources)) cited.add(label)
  }

  return {
    turnId,
    conversationId: head.conversationId,
    organizationId: head.organizationId,
    organization: head.organizationId ? (names.get(head.organizationId) ?? null) : null,
    agent: head.agent as CitationEventAgent,
    jobId: head.jobId,
    occurredAt: head.createdAt.toISOString(),
    sourceCount: asNumber(detailOf(head)?.source_count),
    citedCount: asNumber(detailOf(head)?.cited_count),
    retrievedSources: [...retrieved],
    citedSources: [...cited],
    precision: asPrecision(
      detailOf(turnEvents.find((event) => event.kind === CITATION_PRECISION_KIND))
    ),
    problems: problems.map((event) => ({
      kind: event.kind as CitationEventKind,
      severity: event.severity as CitationEventSeverity,
      count: event.count,
      reasons: (event.reasons as Record<string, number> | null) ?? null,
      failedSources: asFailedSources(detailOf(event)?.targets),
      unavailableTools: asStringArray(detailOf(event)?.unavailable_tools),
    })),
  }
}

/**
 * Group the window's raw events into one record per flagged turn, resolving
 * "what was the source" and "what was the problem" into the same object.
 */
export async function getCitationExport(scope: QualityScope): Promise<CitationExportBundle> {
  const filter = citationScopeFilter(scope)

  const [rows, snapshot] = await Promise.all([
    repository.listEventsForExport(filter),
    getCitationHealth(scope),
  ])

  const capped = rows.length > repository.EXPORT_ROW_CAP
  const events = capped ? rows.slice(0, repository.EXPORT_ROW_CAP) : rows

  const byTurn = new Map<string, CitationEvent[]>()
  for (const event of events) {
    const list = byTurn.get(event.turnId)
    if (list) list.push(event)
    else byTurn.set(event.turnId, [event])
  }

  // Every organization the exported turns name, not just the dashboard's top
  // list: a turn from an organization outside it would otherwise lose its name.
  const names = await getOrganizationDisplayNames(events.map((event) => event.organizationId))
  const turns = [...byTurn].flatMap(
    ([turnId, turnEvents]) => toExportTurn(turnId, turnEvents, names) ?? []
  )

  return {
    schema: 'grid.citation-health.export/v1',
    generatedAt: new Date().toISOString(),
    scope,
    windowDays: snapshot.windowDays,
    windowStart: filter.start.toISOString(),
    windowEnd: filter.endExclusive.toISOString(),
    truncated: capped,
    glossary: EXPORT_GLOSSARY,
    summary: { ...snapshot.totals, findings: snapshot.findings },
    turns,
  }
}

/**
 * What the platform currently holds: base-corpus filenames and catalogued RIS
 * document numbers. Best-effort per inventory — one that cannot be read is
 * `null` (unknown), never an empty list, so an unreachable backend cannot make
 * every held document read as missing.
 */
async function platformInventory(): Promise<PlatformInventory> {
  const [corpus, norms] = await Promise.all([
    getKnowledgeBaseStatus().catch(() => null),
    getNormRegistry().catch(() => null),
  ])
  return {
    corpusFileNames: corpus
      ? corpus.files.map((file) => file.fileName).filter((name): name is string => Boolean(name))
      : null,
    catalogedDocumentNumbers: norms
      ? (norms.registry?.entries ?? [])
          .map((entry) => entry.document_number)
          .filter((value): value is string => Boolean(value))
      : null,
  }
}

/** Zero-fill the daily series so a quiet day renders as a gap, not a missing column. */
function buildDailyTrend(
  kindRows: repository.DailyKindRow[],
  turnRows: repository.DailyTurnRow[],
  start: Date,
  days: number
): CitationDailyPoint[] {
  const kindsByDay = new Map<string, repository.DailyKindRow[]>()
  for (const row of kindRows) {
    if (row.kind === CITATION_BASELINE_KIND || row.kind === CITATION_PRECISION_KIND) continue
    const list = kindsByDay.get(row.day)
    if (list) list.push(row)
    else kindsByDay.set(row.day, [row])
  }
  const turnsByDay = new Map(turnRows.map((row) => [row.day, row]))

  const series: CitationDailyPoint[] = []
  const cursor = new Date(start)
  for (let index = 0; index < days; index += 1) {
    const day = cursor.toISOString().slice(0, 10)
    const byKind: Record<string, number> = {}
    for (const row of kindsByDay.get(day) ?? []) byKind[row.kind] = row.turns
    // Distinct defective turns, counted in SQL. The per-kind counts above are
    // not additive (one turn often carries several defects), so they cannot
    // stand in for it.
    series.push({
      day,
      turns: turnsByDay.get(day)?.turns ?? 0,
      defectTurns: turnsByDay.get(day)?.defectTurns ?? 0,
      byKind,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return series
}

/**
 * Each reason's share of its OWN kind's items: removed citations for
 * `citations_removed`, capped answers for `confidence_capped`. The denominator
 * is the kind's summed `count` from SQL, so it is untruncated whatever the
 * reason list shows.
 */
function toReasonTotals(
  reasonRows: repository.ReasonTotalRow[],
  itemsByKind: Map<CitationEventKind, number>
): CitationReasonTotal[] {
  const occurrencesByKind = new Map<CitationEventKind, number>()
  for (const row of reasonRows) {
    occurrencesByKind.set(row.kind, (occurrencesByKind.get(row.kind) ?? 0) + row.occurrences)
  }
  return reasonRows.map((row) => {
    // Fallback for a kind whose rows carry no count; the reason list itself
    // is per-kind complete (`REASONS_PER_KIND`) for every emitted taxonomy.
    const denominator = itemsByKind.get(row.kind) || occurrencesByKind.get(row.kind) || 0
    return { ...row, share: denominator > 0 ? Math.min(1, row.occurrences / denominator) : 0 }
  })
}

/** Rows with their rates, most defective turns first. */
function toOrganizationTotals(
  rows: repository.OrganizationTotalRow[]
): CitationOrganizationTotal[] {
  return (
    rows
      .map((row) => ({
        organizationId: row.organizationId,
        name: null as string | null,
        turns: row.turns,
        defectTurns: row.defectTurns,
        errorTurns: row.errorTurns,
        defectRate: row.turns > 0 ? row.defectTurns / row.turns : 0,
      }))
      // Worst first, but an org with a single bad turn must not outrank one with
      // hundreds of bad turns — rate breaks ties on volume, not the reverse.
      .sort((a, b) => b.defectTurns - a.defectTurns || b.defectRate - a.defectRate)
  )
}

/**
 * How many DISTINCT turns each half of the candidate list accounts for.
 * Per-candidate counts overlap (one turn commonly cites several of them), so
 * the union is a query rather than a sum — see `countTurnsForTargets`.
 */
async function countMissingSourceTurns(
  filter: repository.CitationScopeFilter,
  candidates: MissingSourceCandidate[]
): Promise<{ held: number; addable: number }> {
  const targets = (keep: (candidate: MissingSourceCandidate) => boolean): string[] =>
    candidates.filter(keep).map((candidate) => candidate.target)
  const [held, addable] = await Promise.all([
    repository.countTurnsForTargets(
      filter,
      targets((candidate) => candidate.present === true)
    ),
    repository.countTurnsForTargets(
      filter,
      targets((candidate) => candidate.present === false && isAddable(candidate))
    ),
  ])
  return { held, addable }
}

/**
 * The full citation-health snapshot for the platform dashboard, read in one
 * scope (date range, and optionally organizations and projects). Every query
 * takes the same filter, so the totals, the trend and every list describe the
 * same rows.
 *
 * Every rate is computed against distinct observed turns, so a window with no
 * research traffic reports a 100 % clean rate rather than dividing by zero.
 */
export async function getCitationHealth(scope: QualityScope): Promise<CitationHealthSnapshot> {
  const filter = citationScopeFilter(scope)
  const windowDays = rangeDays(scope.from, scope.to)

  const [
    kindRows,
    turns,
    defectTurns,
    dailyKindRows,
    dailyTurnRows,
    reasonRows,
    sourceMix,
    tools,
    orgs,
    recentRows,
    failedTargets,
    inventory,
  ] = await Promise.all([
    repository.aggregateByKind(filter),
    repository.countObservedTurns(filter),
    repository.countDefectiveTurns(filter),
    repository.aggregateDailyByKind(filter),
    repository.aggregateDailyTurns(filter),
    repository.aggregateReasons(filter),
    repository.aggregateDefectiveSourceMix(filter),
    repository.aggregateUnavailableTools(filter),
    repository.aggregateByOrganization(filter),
    repository.listRecentDefects(filter),
    repository.aggregateFailedTargets(filter),
    platformInventory(),
  ])

  const missingSources = buildMissingSourceCandidates(failedTargets.rows, inventory)
  const organizations = toOrganizationTotals(orgs.rows)
  const shownOrganizations = organizations.slice(0, ORGANIZATIONS_SHOWN)
  // Names for the listed organizations, plus the outlier the findings may
  // name from further down the list. Resolved per id, so none is cut off by a
  // WorkOS page boundary.
  const outlier =
    turns > 0 ? findOrganizationOutlier(organizations, defectTurns / turns) : undefined
  const [missingSourceTurns, names] = await Promise.all([
    countMissingSourceTurns(filter, missingSources),
    getOrganizationDisplayNames(
      [...shownOrganizations, ...(outlier ? [outlier] : [])].map((org) => org.organizationId)
    ),
  ])
  for (const org of organizations)
    org.name = org.organizationId ? (names.get(org.organizationId) ?? null) : null

  const byKindMap = new Map(kindRows.map((row) => [row.kind, row]))
  const cleanTurns = Math.max(0, turns - defectTurns)
  const byKind: CitationKindTotal[] = CITATION_DEFECT_KINDS.map((kind) => {
    const row = byKindMap.get(kind)
    return {
      kind,
      turns: row?.turns ?? 0,
      items: row?.items ?? 0,
      share: turns > 0 ? (row?.turns ?? 0) / turns : 0,
    }
  })
    .filter((entry) => entry.turns > 0)
    .sort((a, b) => b.turns - a.turns)
  const reasons = toReasonTotals(reasonRows, new Map(kindRows.map((row) => [row.kind, row.items])))

  return {
    scope,
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
      unavailableTools: tools.rows,
      unavailableToolCount: tools.total,
      missingSources,
      missingSourceTurns,
    }),
    byKind,
    dailyTrend: buildDailyTrend(dailyKindRows, dailyTurnRows, filter.start, windowDays),
    reasons,
    sourceMix,
    unavailableTools: tools.rows,
    missingSources: missingSources.slice(0, MISSING_SOURCES_SHOWN),
    missingSourcesTotal: failedTargets.total,
    inventoryKnown:
      inventory.corpusFileNames !== null && inventory.catalogedDocumentNumbers !== null,
    organizations: shownOrganizations,
    organizationsTotal: orgs.total,
    recent: recentRows.map(toSample),
  }
}
