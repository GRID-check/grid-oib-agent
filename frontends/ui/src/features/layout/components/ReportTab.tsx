/**
 * ReportTab Component
 *
 * Displays research output in two visual modes:
 *   1. Research Notes (intermediate) -- preview styling with a header badge
 *   2. Final Report -- full-width rendered markdown with export footer
 *
 * Final reports get citation affordances:
 *   - a trailing sources section (## Sources / ## Quellen) is rendered as an
 *     anchored list so inline [N] markers become clickable links that scroll
 *     to the matching entry;
 *   - when the markdown has no sources section but the run collected cited
 *     sources, a localized "Sources"/"Quellen" list is appended from the store.
 *
 * A finished report also gets an OUTLINE: its `##`/`###` headings as a sticky,
 * collapsible list that jumps to a section and marks the one being read. See
 * {@link ReportOutline} for the layout reasoning and
 * {@link extractReportOutline} for where the headings come from.
 *
 * Shows streaming indicator when report is being generated.
 * Includes export footer for Markdown and PDF export (final report only).
 */

'use client'

import { type FC, type ReactNode, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PluggableList } from 'unified'
import { FileText } from 'lucide-react'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { headingAnchorId } from '@/shared/components/MarkdownRenderer/utils'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { useChatStore } from '@/features/chat'
import { ReportSourcePreviewChip, SourcePreviewChip } from '@/features/chat/components/SourcePreview'
import { buildCitationModel, refKey, type CitationRef } from '@/features/chat/lib/citations'
import { GridCards } from '@/features/grid-cards'
import { useTranslations } from '@/i18n'
import {
  REPORT_SOURCE_ANCHOR_PREFIX,
  splitReportSources,
  type ReportSourceEntry,
  type ReportSourceKind,
} from '../lib/report-citations'
import { remarkCitationMarkers } from '../lib/citation-markers'
import {
  MIN_REPORT_OUTLINE_ENTRIES,
  extractReportOutline,
  reportOutlineEntry,
  type ReportOutlineEntry,
} from '../lib/report-outline'
import { ExportFooter } from './ExportFooter'
import { ReportOutline } from './ReportOutline'

/**
 * Badge variant per source origin. The knowledge base carries the single blue
 * accent (trusted, primary source); web and the official Austrian legal system
 * (RIS) stay in muted, neutral tones per the design language.
 */
const SOURCE_KIND_BADGE_VARIANT: Record<ReportSourceKind, BadgeProps['variant']> = {
  kb: 'info',
  web: 'secondary',
  ris: 'outline',
}

interface ReportTabProps {
  /** Optional custom content to display instead of store content */
  children?: ReactNode
  /**
   * Whether the [KB]/[RIS]/[Web] origin badges render (WorkOS
   * `source-origin-badges` flag, FB-2). Defaults to true so the feature stays
   * visible with flag enforcement off (fail-open) and existing callers/specs
   * are unaffected. When off, source lines render as plain token-stripped text.
   */
  showSourceBadges?: boolean
}

/**
 * Anchored sources list rendered below the report body. Each entry carries a
 * DOM id so inline [N] anchor links (handled by MarkdownRenderer) can scroll
 * to it.
 */
const ReportSourcesList: FC<{
  heading: string
  /**
   * DOM id for the heading. The sources section is lifted out of the markdown
   * and rendered here, so react-markdown never sees it and never gives its
   * heading an id — which would leave the outline's "Quellen" entry as the one
   * dead link in the list. The caller spells the id with the same function the
   * renderer uses.
   */
  headingId: string
  entries: ReportSourceEntry[]
  sourceBadgeLabel: (kind: ReportSourceKind) => string
  /** Whether the origin badges are rendered (WorkOS `source-origin-badges`). */
  showSourceBadges: boolean
}> = ({ heading, headingId, entries, sourceBadgeLabel, showSourceBadges }) => (
  <section aria-label={heading}>
    <h2
      id={headingId}
      className="mb-2 mt-5 scroll-mt-12 text-xl font-semibold tracking-tight text-foreground"
    >
      {heading}
    </h2>
    <ol className="list-none space-y-1 pl-0">
      {entries.map((entry) => (
        <li
          key={entry.number}
          id={`${REPORT_SOURCE_ANCHOR_PREFIX}${entry.number}`}
          className="flex scroll-mt-4 items-baseline gap-2 text-sm text-foreground"
        >
          <span className="shrink-0 text-muted-foreground">[{entry.number}]</span>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            {/* The origin token is already stripped from entry.markdown during
                parsing, so gating only the badge falls back to plain text (never
                the raw [KB]/[RIS]/[Web] token) when the flag is off. */}
            {showSourceBadges && entry.sourceKind && (
              <Badge
                variant={SOURCE_KIND_BADGE_VARIANT[entry.sourceKind]}
                className="shrink-0 self-center"
              >
                {sourceBadgeLabel(entry.sourceKind)}
              </Badge>
            )}
            <div className="min-w-0">
              <MarkdownRenderer content={entry.markdown} compact className="max-w-none" />
            </div>
            {/* WS-9: [KB] entries that resolve to an openable document get an
                in-app preview affordance; unresolvable ones stay plain. */}
            {entry.sourceKind === 'kb' && (
              <ReportSourcePreviewChip locatorText={entry.markdown} />
            )}
          </div>
        </li>
      ))}
    </ol>
  </section>
)

/**
 * Report tab content - displays research output.
 * Subscribes to chat store for report content, category, and streaming state.
 * Renders research notes with a subtle preview treatment and the final report at full prominence.
 */
export const ReportTab: FC<ReportTabProps> = ({ children, showSourceBadges = true }) => {
  const t = useTranslations('research')
  const {
    reportContent,
    reportContentCategory,
    isStreaming,
    currentStatus,
    deepResearchCards,
    deepResearchCitations,
    projectId,
  } = useChatStore(
    useShallow((s) => ({
      reportContent: s.reportContent,
      reportContentCategory: s.reportContentCategory,
      isStreaming: s.isStreaming,
      currentStatus: s.currentStatus,
      deepResearchCards: s.deepResearchCards,
      deepResearchCitations: s.deepResearchCitations,
      projectId: s.projectId,
    }))
  )

  const reportContentStr = typeof reportContent === 'string' ? reportContent : ''
  const cards = deepResearchCards ?? []
  const isEmpty = !reportContentStr.trim()
  const isGeneratingReport = isStreaming && currentStatus === 'writing'
  const isResearchNotes = reportContentCategory === 'research_notes'

  // Citation handling for the final report:
  //  - extract a markdown sources section (if any) and render it with
  //    per-entry anchors, linkifying inline [N] markers to those anchors;
  //  - otherwise fall back to the cited sources collected during the run.
  const { body, sourceEntries, sourcesHeading, citationNumbers } = useMemo(() => {
    const unsplit = {
      body: reportContentStr,
      sourceEntries: [] as ReportSourceEntry[],
      sourcesHeading: null as string | null,
      citationNumbers: new Set<number>(),
    }
    if (isResearchNotes || !reportContentStr.trim()) return unsplit
    const split = splitReportSources(reportContentStr)
    if (split.entries.length === 0) return unsplit
    return {
      body: split.body,
      sourceEntries: split.entries,
      sourcesHeading: split.heading,
      citationNumbers: new Set(split.entries.map((entry) => entry.number)),
    }
  }, [isResearchNotes, reportContentStr])

  // The `[N]` markers are linked on the parsed body, so adjacent ones (`[1][2]`,
  // a claim carried by two sources) resolve as two markers rather than being
  // mistaken for reference-link syntax and left as text.
  const markerPlugins = useMemo(
    (): PluggableList => [[remarkCitationMarkers, { numbers: citationNumbers }]],
    [citationNumbers]
  )

  // Fallback sources list from run citations, only when the markdown itself
  // has no sources section and the run is complete enough to trust the list.
  // Built with the SAME derivation the answer's provenance row uses, so these
  // rows carry a real label, tint, authority badge and preview target instead
  // of a bare URL (which a document source does not even have).
  const citedFallbackSources = useMemo((): CitationRef[] => {
    if (isResearchNotes || sourceEntries.length > 0 || isGeneratingReport) return []
    const cited = (deepResearchCitations ?? []).filter((citation) => citation.isCited)
    if (cited.length === 0) return []
    // A bibliography is the LOCUS-level projection: one row per place the
    // report cites, uncapped. The answer's chip row is the document-level
    // projection of the same model — a summary — and applying its 8-source cap
    // here would silently show 8 of 12 on the one surface whose whole job is to
    // account for all of them.
    return buildCitationModel({ citations: cited }).flatMap((document) =>
      document.loci.length > 0
        ? document.loci.map((locus) => ({ document, locus }))
        : [{ document }]
    )
  }, [isResearchNotes, sourceEntries.length, isGeneratingReport, deepResearchCitations])

  // The sources heading, whatever produced it — the report's own „## Quellen“,
  // or the localized one this component appends when the markdown has none.
  // Named once here so the rendered heading and the outline entry that links to
  // it cannot disagree.
  const sourcesSectionHeading =
    sourceEntries.length > 0
      ? (sourcesHeading ?? t('reportTab.sourcesTitle'))
      : citedFallbackSources.length > 0
        ? t('reportTab.sourcesTitle')
        : null

  /**
   * The outline of the finished report.
   *
   * WHILE WRITING, THERE IS NO OUTLINE. Headings are still arriving, the last
   * one is usually half a word, and the slug of half a word is an id that stops
   * existing a moment later — so an entry clicked mid-stream would scroll
   * nowhere. Marking a current section is meaningless too while the document is
   * still growing under the reader. The reader watching a report being written
   * is watching, not navigating; the outline appears when the report settles.
   *
   * Research notes never get one. They are the intermediate working document,
   * shown behind a banner that says as much and replaced wholesale by the
   * report — a reader does not arrive at them with a question to look up.
   *
   * The entries come from `body`, which is the markdown after the sources
   * section has been lifted out, plus one synthesized entry for the sources
   * section itself. That is what keeps the list honest in both directions: the
   * sources section is rendered by this component rather than by the markdown,
   * so extracting from the full text would list it while the rendered heading
   * carried no id, and extracting from the body alone would drop the entry
   * readers reach for most.
   */
  const outline = useMemo((): ReportOutlineEntry[] => {
    if (isResearchNotes || isGeneratingReport || !body.trim()) return []
    const entries = extractReportOutline(body)
    const sources = sourcesSectionHeading
      ? reportOutlineEntry(sourcesSectionHeading, 2, entries.length)
      : null
    if (sources) entries.push(sources)
    return entries.length >= MIN_REPORT_OUTLINE_ENTRIES ? entries : []
  }, [isResearchNotes, isGeneratingReport, body, sourcesSectionHeading])

  // The outline observes headings against the panel's own scroll box, not the
  // window: a heading in the middle of a scrolled-away panel is not in view.
  const scrollRef = useRef<HTMLDivElement>(null)

  return (
    <div className="flex h-full flex-col">
      {/* Scrollable content area */}
      <div
        ref={scrollRef}
        className="flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain"
      >
        {children ? (
          children
        ) : isEmpty ? (
          <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
            <FileText className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              {t('reportTab.contentWhenAvailable')}
            </p>
          </div>
        ) : isResearchNotes ? (
          /* Research notes: preview treatment */
          <div className="flex flex-1 flex-col gap-3">
            <div className="flex shrink-0 items-center gap-2 rounded-md border border-warning bg-warning-subtle px-3 py-2">
              <div className="size-2 animate-pulse rounded-full bg-warning motion-reduce:animate-none" />
              <span className="text-sm text-warning">
                {t('reportTab.notesBanner')}
              </span>
            </div>
            <div className="flex-1 opacity-80">
              <MarkdownRenderer
                content={reportContentStr}
                isStreaming={false}
                className="max-w-none"
              />
            </div>
          </div>
        ) : (
          /* Final report: full prominence, with Grid cards when available */
          <div className="flex flex-1 flex-col gap-4">
            <ReportOutline entries={outline} scrollRootRef={scrollRef} />
            {/* No `messageId`: report cards are rendered from transient
                `deepResearchCards`, which has no reliable owning message —
                `activeDeepResearchMessageId` is null after a session switch +
                "View report", and `restoreSessionState` re-points it at the
                LAST agent_response, which may be an unrelated later answer.
                Binding decisions to it would record them onto the wrong
                message, so an interactive card here keeps the old local-state
                behaviour until the report owns a stable message id.
                See ADR-0030 §Open Questions. */}
            {cards.length > 0 && <GridCards cards={cards} projectId={projectId} />}
            {/* The outline bar is sticky at the top of this scroll box, so a
                heading jumped to with `block: 'start'` would land underneath
                it. The renderer's own `scroll-mt-4` is sized for a container
                with nothing on top; this raises it to clear the bar. */}
            <MarkdownRenderer
              content={body}
              isStreaming={isGeneratingReport}
              className="max-w-none [&_h2]:scroll-mt-12 [&_h3]:scroll-mt-12"
              remarkPlugins={markerPlugins}
            />
            {sourceEntries.length > 0 && (
              <ReportSourcesList
                heading={sourcesSectionHeading ?? t('reportTab.sourcesTitle')}
                headingId={headingAnchorId(sourcesSectionHeading ?? t('reportTab.sourcesTitle'))}
                entries={sourceEntries}
                sourceBadgeLabel={(kind) => t(`reportTab.sourceBadge.${kind}`)}
                showSourceBadges={showSourceBadges}
              />
            )}
            {citedFallbackSources.length > 0 && (
              <section aria-label={t('reportTab.sourcesTitle')}>
                <h2
                  id={headingAnchorId(t('reportTab.sourcesTitle'))}
                  className="mb-2 mt-5 scroll-mt-12 text-xl font-semibold tracking-tight text-foreground"
                >
                  {t('reportTab.sourcesTitle')}
                </h2>
                {/* Rendered through the same citation component as every other
                    surface. This list used to print `citation.url` as its only
                    content, which was blank for a knowledge-base source — a
                    latent hole that only became reachable once KB sources could
                    be marked cited at all. */}
                {/* No list marker: the card already prints the source's `[N]`
                    from the answer's prose, and a positional marker is a
                    DIFFERENT number. Cited sources 2 and 5 sit at positions 1
                    and 2, so the row would show two numbers that disagree. The
                    `[N]` is what an inline marker points at, so the card keeps
                    it and the list drops its own. */}
                <ol className="list-none space-y-2 pl-0">
                  {citedFallbackSources.map((ref) => (
                    <li key={refKey(ref)} className="text-sm text-foreground">
                      <SourcePreviewChip citation={ref} variant="card" />
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        )}
      </div>

      {/* Export footer - only meaningful for the final report */}
      <ExportFooter />
    </div>
  )
}
