'use client'

import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { Camera, ChevronDown, CornerDownRight, RotateCcw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Chip, ChipCount, ChipLabel } from '@/components/ui/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SegmentMeter, ToneSwatch, type MeterTone } from '@/components/ui/segment-meter'
import { useLocale, useTranslations } from '@/i18n'
import { formatDayRange } from '@/lib/format'
import { offeredForRetry } from '@/lib/documents/retry-policy'
import { cn } from '@/lib/utils'
import type { BulkReingestProgress } from '../hooks/use-bulk-reingest'
import { FolderReadState } from './folder-read-state'
import type { MissingDocument } from '@/lib/document-roles/prompt-loader'
import {
  readShare,
  type BriefSelection,
  type FolderBrief as FolderBriefData,
  type FolderLocation,
  type KnowledgeTally,
  type PhotoSpan,
  type ReadState,
} from '../lib/folder-knowledge'

/** Read state → the tone its swatch and meter segment are drawn in. */
export const READ_STATE_TONE: Record<ReadState, MeterTone> = {
  readable: 'success',
  reading: 'info',
  failed: 'destructive',
  held: 'warning',
  unindexed: 'muted',
}

/**
 * The states Piloti is meant to read, in the order the legend reads them: what
 * Piloti has, then what is moving, then what needs a person. Their counts add
 * up to the headline's „von N", which is the whole point of listing them
 * apart from `unindexed`: a reader who adds up the legend gets the headline.
 */
const MEANT_TO_READ: readonly ReadState[] = ['readable', 'reading', 'failed', 'held']

/**
 * The states the bar and the legend draw. `unindexed` is out of the headline's
 * denominator (`readShare`), so it is out of the bar too and named as an aside
 * (`UnindexedAside`), unless it is all there is.
 */
function meterStates(tally: KnowledgeTally): readonly ReadState[] {
  return tally.total - tally.unindexed > 0 ? MEANT_TO_READ : ['unindexed']
}

/** Whether the documents Piloti never reads are named beside the legend rather than in it. */
function hasUnindexedAside(tally: KnowledgeTally): boolean {
  return tally.unindexed > 0 && tally.total - tally.unindexed > 0
}

export interface FolderBriefProps {
  brief: FolderBriefData
  /** The folder the brief is about, or null at the shelf root. */
  folderName: string | null
  /** Which shelf's root the null folder is — the words differ, the brief does not. */
  shelfKind: 'project' | 'office'
  /** Show a slice of the subtree as a flat listing below the brief. */
  onSelect: (selection: BriefSelection) => void
  /** Walk into a folder below this one. */
  onOpenFolder: (folderId: string) => void
  /**
   * Re-read every failed document in the subtree. Absent when the reader may
   * not write here — a re-read changes the document's state for everybody.
   */
  onReadAgain?: () => void
  readAgainProgress?: BulkReingestProgress | null
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  /**
   * What Piloti expects the PROJECT to hold and does not (`useMissingDocuments`)
   * — the agent's own `documents_missing:` list. Shown at the project root only;
   * null when unknown, so an unread list is never presented as "nothing missing".
   */
  missing?: readonly MissingDocument[] | null
  /**
   * Load what Piloti put on each document, for a {@link FolderBriefData.partial}
   * brief (ADR-0102): the workspace then reads the whole shelf once and the
   * brief is built from it. Absent offers nothing to load.
   */
  onLoadDetails?: () => void
  /** The shelf is being read for {@link onLoadDetails}. */
  detailsLoading?: boolean
}

/**
 * „Was Piloti hier weiß" — the folder, as Piloti understands it.
 *
 * A file manager answers "what is in here" with a list of names. That is the
 * wrong question for a shelf whose point is that an assistant reads it: the
 * planner wants to know whether Piloti has READ what is in here, what it took
 * it to be, and what it could not make sense of — and before this, the only way
 * to find out was to open each folder and each file in turn (feld72, Jour fixe
 * 2026-10-09: answers reported documents missing that had been read).
 *
 * So every level opens with Piloti's account of its whole subtree, built from
 * nothing but what the listing already carries (`folder-knowledge.ts`):
 *
 * 1. How much of it Piloti can cite — one sentence and one bar, every state a
 *    swatch AND a word, each a way into exactly those documents.
 * 2. What it is about — the document types and disciplines Piloti assigned, and
 *    the kinds of content it found, as chips that narrow the listing to them.
 * 3. What needs a person — failures with a single re-read for all of them,
 *    documents the content screen is holding, documents Piloti could not place.
 * 4. Where below it the trouble sits — the deepest folder, one click away.
 *
 * It never shows CONTENT of a document Piloti cannot cite: a quarantined file
 * is counted, never described (`buildFolderBrief`).
 */
export function FolderBrief({
  brief,
  folderName,
  shelfKind,
  onSelect,
  onOpenFolder,
  onReadAgain,
  readAgainProgress,
  collapsed,
  onCollapsedChange,
  missing,
  onLoadDetails,
  detailsLoading = false,
}: FolderBriefProps): JSX.Element | null {
  const t = useTranslations('files')
  const { tally } = brief
  if (tally.total === 0) return null

  const scope = folderName
    ? t('brief.scopeFolder', { name: folderName })
    : t(shelfKind === 'office' ? 'brief.scopeOffice' : 'brief.scopeProject')
  const headline = briefHeadline(tally, t)
  const meterLabel = `${headline} ${scope}. ${legendSentence(tally, t)}`

  // ONE ELEMENT THAT OPENS IN PLACE.
  //
  // Folded, the brief is one quiet line above the listing: what Piloti has read
  // is worth a glance, not the top third of every folder. It used to open by
  // swapping that line for a different element, a card with its own header, so
  // the thing just clicked vanished and the words reappeared elsewhere in
  // another size. Now the line IS the card's header in both states: it never
  // moves, the card's border fades in around it, and the details open below.
  // The `-mx-3` holds in both states, so the line's text stays on the
  // listing's edge whether or not a border is drawn around it.
  const open = !collapsed
  return (
    <Card
      className={cn(
        '-mx-3 gap-0 py-0 transition-[background-color,border-color,box-shadow] duration-quick ease-out motion-reduce:transition-none',
        collapsed && 'border-transparent bg-transparent shadow-none'
      )}
      data-testid="folder-brief"
      data-state={open ? 'open' : 'closed'}
      aria-labelledby="folder-brief-title"
      role="region"
    >
      <Collapsible open={open} onOpenChange={(next) => onCollapsedChange(!next)}>
        <h2 className="m-0">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              id="folder-brief-title"
              title={t(open ? 'brief.collapse' : 'brief.expand')}
              className={cn(
                'hover:text-foreground focus-visible:ring-ring flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset motion-reduce:transition-none pointer-coarse:min-h-11',
                open ? 'text-foreground' : 'text-muted-foreground hover:bg-accent/60'
              )}
              data-testid="folder-brief-toggle"
            >
              <Sparkles className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                <span className={cn(open && 'font-medium')}>{headline}</span>{' '}
                <span className="text-muted-foreground">{scope}</span>
              </span>
              <ChevronDown
                className={cn(
                  'text-muted-foreground size-3.5 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
                  open && 'rotate-180'
                )}
                aria-hidden
              />
            </button>
          </CollapsibleTrigger>
        </h2>

        <CollapsibleContent id="folder-brief-body">
          <div className="flex flex-col gap-2.5 px-3 pb-3 pt-0.5">
            <SegmentMeter
              label={meterLabel}
              segments={meterStates(tally).map((state) => ({ key: state, value: tally[state], tone: READ_STATE_TONE[state] }))}
            />
            <ReadStateLegend tally={tally} onSelect={onSelect} />
          </div>

          {/* Ordered by what the reader has to do: what needs them first, open;
              then what Piloti is missing, what the folder is about and where the
              trouble sits, each folded to one line that already names its content.
              Open in full, the brief was taller than a laptop screen and the
              listing it introduces started below the fold. */}
          <div className="flex flex-col divide-y border-t" data-testid="folder-brief-sections">
            <NeedsYouSection
              brief={brief}
              onSelect={onSelect}
              onReadAgain={onReadAgain}
              readAgainProgress={readAgainProgress}
            />
            {folderName === null && missing && missing.length > 0 && <MissingSection missing={missing} />}
            {brief.partial ? (
              <DeferredAboutSection tally={tally} onLoadDetails={onLoadDetails} loading={detailsLoading} />
            ) : (
              <AboutSection brief={brief} onSelect={onSelect} />
            )}
            <HotspotSection hotspots={brief.hotspots} onOpenFolder={onOpenFolder} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

type Translate = ReturnType<typeof useTranslations>

function briefHeadline(tally: KnowledgeTally, t: Translate): string {
  const share = readShare(tally)
  if (share === null) return t('brief.headlineNothingToRead', { count: tally.total })
  const meantToRead = tally.total - tally.unindexed
  if (tally.readable === meantToRead) return t('brief.headlineAll', { count: meantToRead })
  if (tally.readable === 0) return t('brief.headlineNone', { count: meantToRead })
  return t('brief.headlineSome', { readable: tally.readable, count: meantToRead })
}

function legendSentence(tally: KnowledgeTally, t: Translate): string {
  const states = meterStates(tally)
    .filter((state) => tally[state] > 0)
    .map((state) => t(`brief.states.${state}`, { count: tally[state] }))
  if (hasUnindexedAside(tally)) states.push(t('brief.unindexedAside', { count: tally.unindexed }))
  return states.join(', ')
}

/** Each state with documents in it, as swatch + count + word — and a way into exactly those documents. */
function ReadStateLegend({ tally, onSelect }: { tally: KnowledgeTally; onSelect: (s: BriefSelection) => void }) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const states = meterStates(tally).filter((state) => tally[state] > 0)
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {states.map((state) => (
        <button
          key={state}
          type="button"
          onClick={() => onSelect({ kind: 'state', state })}
          className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring touch-target inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none"
          title={t('brief.showState', { state: t(`brief.slice.${state}`) })}
          data-testid={`folder-brief-state-${state}`}
        >
          <ToneSwatch tone={READ_STATE_TONE[state]} />
          <span>{t(`brief.states.${state}`, { count: tally[state] })}</span>
        </button>
      ))}
      {hasUnindexedAside(tally) && (
        <button
          type="button"
          onClick={() => onSelect({ kind: 'state', state: 'unindexed' })}
          className="text-muted-foreground/80 hover:bg-accent hover:text-foreground focus-visible:ring-ring touch-target inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none"
          title={t('brief.showState', { state: t('brief.slice.unindexed') })}
          data-testid="folder-brief-state-unindexed"
        >
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span>{t('brief.unindexedAside', { count: tally.unindexed })}</span>
        </button>
      )}
      {tally.pages > 0 && (
        <span className="text-muted-foreground/80 ml-auto px-1.5 text-xs tabular-nums">
          {t('brief.pages', { count: tally.pages, formatted: tally.pages.toLocaleString(locale) })}
        </span>
      )}
    </div>
  )
}

/**
 * What Piloti took the documents to be: the document types and disciplines it
 * assigned, each family under its own label, the topics it recognised, and the
 * kinds of content in them. Folded to one line by default; the line names the
 * biggest types, so the folder still says what it is without being opened.
 */
function AboutSection({ brief, onSelect }: { brief: FolderBriefData; onSelect: (s: BriefSelection) => void }) {
  const t = useTranslations('files')
  const { documentTypes, disciplines, contents, tally, topics, photos } = brief
  const { locale } = useLocale()
  if (tally.readable === 0) return null
  const contentNames = contents.map(({ label }) => t(`preview.contentTypeNames.${label}`))
  const summary =
    documentTypes.length + disciplines.length > 0
      ? [...documentTypes, ...disciplines].map(({ label }) => label).join(' · ')
      : t('brief.noTypes')
  return (
    <BriefDisclosure id="folder-brief-about" title={t('brief.aboutTitle')} summary={summary}>
      {documentTypes.length === 0 && disciplines.length === 0 ? (
        <p className="text-muted-foreground text-xs leading-relaxed">{t('brief.noTypes')}</p>
      ) : (
        <div className="flex flex-col gap-2" data-testid="folder-brief-types">
          {documentTypes.length > 0 && (
            <ChipFamily label={t('brief.typesLabel')}>
              {documentTypes.map(({ label, count }) => (
                <TagChip key={label} label={label} count={count} onSelect={onSelect} />
              ))}
            </ChipFamily>
          )}
          {disciplines.length > 0 && (
            <ChipFamily label={t('brief.disciplinesLabel')}>
              {disciplines.map(({ label, count }) => (
                <TagChip key={label} label={label} count={count} onSelect={onSelect} variant="outline" />
              ))}
            </ChipFamily>
          )}
        </div>
      )}
      {topics.length > 0 && (
        <ChipFamily label={t('brief.topicsTitle')} testId="folder-brief-topics">
          {topics.map(({ label, count }) => (
            <Chip key={label} asChild interactive variant="muted" size="sm" className="text-foreground/80">
              <button
                type="button"
                onClick={() => onSelect({ kind: 'topic', topic: label })}
                title={t('brief.showTag', { tag: label })}
                data-testid={`folder-brief-topic-${label}`}
              >
                <ChipLabel>{label}</ChipLabel>
                <ChipCount>{count}</ChipCount>
              </button>
            </Chip>
          ))}
        </ChipFamily>
      )}
      {contentNames.length > 0 && (
        <p className="text-muted-foreground text-xs">{t('brief.contains', { list: contentNames.join(' · ') })}</p>
      )}
      {photos && (
        <button
          type="button"
          onClick={() => onSelect({ kind: 'photos' })}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring touch-target inline-flex items-center gap-1.5 self-start rounded-sm text-left text-xs underline underline-offset-2 decoration-muted-foreground/40 transition-colors duration-quick ease-out hover:decoration-current focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none"
          data-testid="folder-brief-photos"
        >
          <Camera className="size-3.5 shrink-0" aria-hidden />
          {photoLine(photos, locale, t)}
        </button>
      )}
    </BriefDisclosure>
  )
}

/**
 * „Worum es hier geht“ before the documents are loaded (ADR-0102). The folder
 * is read page by page, and what Piloti put on each document lives beside the
 * rows rather than in the counts, so the section says that and offers to load
 * them instead of claiming Piloti recognised nothing.
 */
function DeferredAboutSection({
  tally,
  onLoadDetails,
  loading,
}: {
  tally: KnowledgeTally
  onLoadDetails?: () => void
  loading: boolean
}) {
  const t = useTranslations('files')
  if (tally.readable === 0) return null
  return (
    <BriefDisclosure id="folder-brief-about" title={t('brief.aboutTitle')} summary={t('brief.aboutDeferred')}>
      <p className="text-muted-foreground text-xs leading-relaxed">{t('brief.aboutDeferredHint')}</p>
      {onLoadDetails && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 self-start"
          onClick={onLoadDetails}
          disabled={loading}
          data-testid="folder-brief-load-details"
        >
          {loading ? t('brief.loadingDetails') : t('brief.loadDetails')}
        </Button>
      )}
    </BriefDisclosure>
  )
}

/**
 * One family of chips under its run-in label — „Dokumentart", „Fachbereich",
 * „Themen" — so a type and a discipline are told apart by a word, not only by
 * fill against outline.
 */
function ChipFamily({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <p className="text-muted-foreground/80 text-[11px]">{label}</p>
      <div className="flex min-w-0 flex-wrap gap-1.5 pointer-coarse:gap-2">{children}</div>
    </div>
  )
}

/**
 * A secondary section of the brief, folded to its title and one line of what
 * it holds. The heading wraps the trigger (the disclosure pattern): a heading
 * inside a button is not one a screen reader can jump to.
 */
function BriefDisclosure({
  id,
  title,
  summary,
  children,
}: {
  id: string
  title: string
  summary: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section aria-labelledby={id} data-testid={id} data-state={open ? 'open' : 'closed'}>
        <h3 id={id} className="m-0">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="hover:bg-accent/60 focus-visible:ring-ring group flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset motion-reduce:transition-none pointer-coarse:min-h-11"
              data-testid={`${id}-toggle`}
            >
              <span className="text-muted-foreground shrink-0 text-xs font-medium">{title}</span>
              {/* What the section holds, while it is shut; open, the section says it itself. */}
              <span className="text-muted-foreground/80 min-w-0 flex-1 truncate text-xs font-normal" aria-hidden={open}>
                {open ? '' : summary}
              </span>
              <ChevronDown
                className={cn(
                  'text-muted-foreground size-3.5 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
                  open && 'rotate-180'
                )}
                aria-hidden
              />
            </button>
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent className="flex flex-col gap-2.5 px-3 pb-3">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  )
}

function TagChip({
  label,
  count,
  onSelect,
  variant = 'secondary',
}: {
  label: string
  count: number
  onSelect: (s: BriefSelection) => void
  variant?: 'secondary' | 'outline'
}) {
  const t = useTranslations('files')
  return (
    <Chip asChild interactive variant={variant} size="sm">
      <button
        type="button"
        onClick={() => onSelect({ kind: 'tag', tag: label })}
        title={t('brief.showTag', { tag: label })}
        data-testid={`folder-brief-tag-${label}`}
      >
        <ChipLabel>{label}</ChipLabel>
        <ChipCount>{count}</ChipCount>
      </button>
    </Chip>
  )
}

/** Failures, holds and unplaced documents — the things a person has to do something about. */
function NeedsYouSection({
  brief,
  onSelect,
  onReadAgain,
  readAgainProgress,
}: {
  brief: FolderBriefData
  onSelect: (s: BriefSelection) => void
  onReadAgain?: () => void
  readAgainProgress?: BulkReingestProgress | null
}) {
  const t = useTranslations('files')
  // Counted from the tally, which both briefs carry exactly; the attention
  // lists only NAME documents for an action, and a summary-built brief names
  // the failed ones alone, up to the summary's limit (ADR-0102). The re-read
  // button counts what it will send: not a file that failed for a lasting
  // reason (`offeredForRetry`), which stays in the tally and is not sent.
  const { failed, held, unplaced } = brief.tally
  const sendable = offeredForRetry(brief.attention.failed).length
  if (failed + held + unplaced === 0) return null
  return (
    <section className="flex flex-col gap-2.5 px-3 py-3" aria-labelledby="folder-brief-needs">
      <h3 id="folder-brief-needs" className="text-muted-foreground text-xs font-medium">
        {t('brief.needsTitle')}
      </h3>
      {failed > 0 && (
        <AttentionRow
          tone="destructive"
          text={t('brief.failedLine', { count: failed })}
          showLabel={t('brief.showFailed', { count: failed })}
          onShow={() => onSelect({ kind: 'state', state: 'failed' })}
          testId="folder-brief-needs-failed"
        >
          {onReadAgain && (sendable > 0 || Boolean(readAgainProgress)) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5"
              onClick={onReadAgain}
              disabled={Boolean(readAgainProgress)}
              data-testid="folder-brief-read-again"
            >
              <RotateCcw className={cn('size-3.5', readAgainProgress && 'animate-spin motion-reduce:animate-none')} aria-hidden />
              {readAgainProgress
                ? t('brief.readAgainProgress', { done: readAgainProgress.done, count: readAgainProgress.total })
                : t('brief.readAgainAll', { count: sendable })}
            </Button>
          )}
        </AttentionRow>
      )}
      {held > 0 && (
        <AttentionRow
          tone="warning"
          text={t('brief.heldLine', { count: held })}
          showLabel={t('brief.showHeld', { count: held })}
          onShow={() => onSelect({ kind: 'state', state: 'held' })}
          testId="folder-brief-needs-held"
        />
      )}
      {unplaced > 0 && (
        <AttentionRow
          tone="muted"
          text={t('brief.unplacedLine', { count: unplaced })}
          hint={t('brief.unplacedHint')}
          showLabel={t('brief.showUnplaced', { count: unplaced })}
          onShow={() => onSelect({ kind: 'unplaced' })}
          testId="folder-brief-needs-unplaced"
        />
      )}
    </section>
  )
}

function AttentionRow({
  tone,
  text,
  hint,
  showLabel,
  onShow,
  testId,
  children,
}: {
  tone: MeterTone
  text: string
  hint?: string
  /** The button's accessible name: three „Anzeigen" in a row are three different things. */
  showLabel: string
  onShow: () => void
  testId: string
  children?: ReactNode
}) {
  const t = useTranslations('files')
  return (
    <div className="flex items-start gap-2" data-testid={testId}>
      <ToneSwatch tone={tone} className="mt-[7px]" />
      {/* The sentence and its own action (re-read) share a column, so on a
          phone the action wraps under the sentence. „Anzeigen" stays at the
          end of the first line rather than orphaned on a line of its own. */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="text-foreground min-w-0 flex-1 basis-48 py-[3px] text-[13px] leading-snug">{text}</p>
          {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
        </div>
        {hint && <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{hint}</p>}
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="-mr-2 h-7 shrink-0"
        onClick={onShow}
        aria-label={showLabel}
        title={showLabel}
      >
        {t('brief.show')}
      </Button>
    </div>
  )
}

/** The deepest folders below this one where something waits — the reader goes there, not to an ancestor. */
function HotspotSection({
  hotspots,
  onOpenFolder,
}: {
  hotspots: readonly FolderLocation[]
  onOpenFolder: (id: string) => void
}) {
  const t = useTranslations('files')
  if (hotspots.length === 0) return null
  return (
    <BriefDisclosure
      id="folder-brief-where"
      title={t('brief.whereTitle')}
      summary={hotspots.map(({ trail }) => trail.join(' / ')).join(' · ')}
    >
      <ul className="-mx-1.5 flex flex-col">
        {hotspots.map(({ folder, trail, tally }) => (
          <li key={folder.id}>
            <button
              type="button"
              onClick={() => onOpenFolder(folder.id)}
              className="hover:bg-accent focus-visible:ring-ring touch-target group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none"
              data-testid={`folder-brief-hotspot-${folder.id}`}
            >
              <CornerDownRight className="text-muted-foreground/60 size-3.5 shrink-0" aria-hidden />
              <span className="text-foreground min-w-0 flex-1 truncate text-[13px]" title={trail.join(' / ')}>
                {trail.join(' / ')}
              </span>
              <FolderReadState tally={tally} withUnplaced />
            </button>
          </li>
        ))}
      </ul>
    </BriefDisclosure>
  )
}

/** How many expected documents the brief names before it says how many more. */
const MAX_MISSING_SHOWN = 8

/**
 * „Was Piloti noch fehlt" — the documents the project's intake answers say it
 * should have, that no file has been named as.
 *
 * This is the list the agent reads as `documents_missing:` on every turn, and
 * it was invisible to the people it describes. It explains the complaint that
 * started this surface: an answer calling a document missing that had been
 * uploaded and read. Read is not the same as KNOWN AS — until a file is bound
 * to the role, Piloti cannot tell that this PDF is the Energieausweis.
 */
function MissingSection({ missing }: { missing: readonly MissingDocument[] }) {
  const t = useTranslations('files')
  const shown = missing.slice(0, MAX_MISSING_SHOWN)
  const more = missing.length - shown.length
  const name = (entry: MissingDocument) => (entry.bauwerkName ? `${entry.label} · ${entry.bauwerkName}` : entry.label)
  return (
    <BriefDisclosure id="folder-brief-missing" title={t('brief.missingTitle')} summary={missing.map(name).join(', ')}>
      <p className="text-foreground text-[13px] leading-snug">{t('brief.missingLead')}</p>
      <ul className="flex min-w-0 flex-wrap gap-1.5 pointer-coarse:gap-2">
        {shown.map((entry) => (
          <li key={`${entry.role}@${entry.bauwerkName ?? ''}`} className="min-w-0 max-w-full">
            <Chip variant="outline" size="sm" title={name(entry)}>
              <ToneSwatch tone="muted" />
              <ChipLabel>{name(entry)}</ChipLabel>
            </Chip>
          </li>
        ))}
        {more > 0 && (
          <li>
            <Chip variant="muted" size="sm">
              {t('brief.missingMore', { count: more })}
            </Chip>
          </li>
        )}
      </ul>
      <p className="text-muted-foreground text-xs leading-relaxed">{t('brief.missingHint')}</p>
    </BriefDisclosure>
  )
}

/** „12 Fotos vom 3.–20. Sept. 2026“ — the span the camera clocks say, not the upload dates. */
function photoLine(photos: PhotoSpan, locale: string, t: Translate): string {
  return t('brief.photos', { count: photos.count, span: formatDayRange(photos.from, photos.to, locale) })
}
