'use client'

import type { JSX } from 'react'
import { ChevronDown, CornerDownRight, RotateCcw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Chip, ChipCount } from '@/components/ui/chip'
import { SectionLabel } from '@/components/ui/section-label'
import { SegmentMeter, ToneSwatch, type MeterTone } from '@/components/ui/segment-meter'
import { useLocale, useTranslations } from '@/i18n'
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

/** The order the legend reads in: what Piloti has, then what is moving, then what needs a person. */
const LEGEND_ORDER: readonly ReadState[] = ['readable', 'reading', 'failed', 'held', 'unindexed']

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
}: FolderBriefProps): JSX.Element | null {
  const t = useTranslations('files')
  const { tally } = brief
  if (tally.total === 0) return null

  const scope = folderName
    ? t('brief.scopeFolder', { name: folderName })
    : t(shelfKind === 'office' ? 'brief.scopeOffice' : 'brief.scopeProject')
  const headline = briefHeadline(tally, t)
  const meterLabel = `${headline} ${scope}. ${legendSentence(tally, t)}`

  return (
    <Card
      className="gap-0 py-0"
      data-testid="folder-brief"
      aria-labelledby="folder-brief-title"
      role="region"
    >
      <div className="flex flex-col gap-2.5 px-4 py-3.5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <SectionLabel as="p" icon={Sparkles} className="font-semibold tracking-[0.05em]">
              {t('brief.eyebrow')}
            </SectionLabel>
            <p id="folder-brief-title" className="text-foreground mt-1.5 text-sm font-semibold leading-snug">
              {headline}{' '}
              <span className="text-muted-foreground font-normal">{scope}</span>
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mr-1.5 -mt-1 size-7 shrink-0 pointer-coarse:size-11"
            onClick={() => onCollapsedChange(!collapsed)}
            aria-expanded={!collapsed}
            aria-controls="folder-brief-body"
            aria-label={t(collapsed ? 'brief.expand' : 'brief.collapse')}
            title={t(collapsed ? 'brief.expand' : 'brief.collapse')}
            data-testid="folder-brief-toggle"
          >
            <ChevronDown
              className={cn('transition-transform duration-quick ease-out motion-reduce:transition-none', !collapsed && 'rotate-180')}
              aria-hidden
            />
          </Button>
        </div>

        <SegmentMeter
          label={meterLabel}
          segments={LEGEND_ORDER.map((state) => ({ key: state, value: tally[state], tone: READ_STATE_TONE[state] }))}
        />

        <ReadStateLegend tally={tally} onSelect={onSelect} />
      </div>

      {!collapsed && (
        <div id="folder-brief-body" className="flex flex-col divide-y border-t">
          <AboutSection brief={brief} onSelect={onSelect} />
          <NeedsYouSection
            brief={brief}
            onSelect={onSelect}
            onReadAgain={onReadAgain}
            readAgainProgress={readAgainProgress}
          />
          {folderName === null && missing && missing.length > 0 && <MissingSection missing={missing} />}
          <HotspotSection hotspots={brief.hotspots} onOpenFolder={onOpenFolder} />
        </div>
      )}
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
  return LEGEND_ORDER.filter((state) => tally[state] > 0)
    .map((state) => t(`brief.states.${state}`, { count: tally[state] }))
    .join(', ')
}

/** Each state with documents in it, as swatch + count + word — and a way into exactly those documents. */
function ReadStateLegend({ tally, onSelect }: { tally: KnowledgeTally; onSelect: (s: BriefSelection) => void }) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const states = LEGEND_ORDER.filter((state) => tally[state] > 0)
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {states.map((state) => (
        <button
          key={state}
          type="button"
          onClick={() => onSelect({ kind: 'state', state })}
          className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring touch-target inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none"
          title={t('brief.showState', { state: t(`brief.states.${state}`, { count: tally[state] }) })}
          data-testid={`folder-brief-state-${state}`}
        >
          <ToneSwatch tone={READ_STATE_TONE[state]} />
          <span>{t(`brief.states.${state}`, { count: tally[state] })}</span>
        </button>
      ))}
      {tally.pages > 0 && (
        <span className="text-muted-foreground/80 ml-auto px-1.5 text-xs tabular-nums">
          {t('brief.pages', { count: tally.pages, formatted: tally.pages.toLocaleString(locale) })}
        </span>
      )}
    </div>
  )
}

/** What Piloti took the documents to be: type and discipline chips, and the kinds of content in them. */
function AboutSection({ brief, onSelect }: { brief: FolderBriefData; onSelect: (s: BriefSelection) => void }) {
  const t = useTranslations('files')
  const { documentTypes, disciplines, contents, tally } = brief
  if (tally.readable === 0) return null
  const contentNames = contents.map(({ label }) => t(`preview.contentTypeNames.${label}`))
  return (
    <section className="flex flex-col gap-2 px-4 py-3" aria-labelledby="folder-brief-about">
      <h3 id="folder-brief-about" className="text-muted-foreground text-xs font-medium">
        {t('brief.aboutTitle')}
      </h3>
      {documentTypes.length === 0 && disciplines.length === 0 ? (
        <p className="text-muted-foreground text-xs leading-relaxed">{t('brief.noTypes')}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5" data-testid="folder-brief-types">
          {documentTypes.map(({ label, count }) => (
            <TagChip key={label} label={label} count={count} onSelect={onSelect} />
          ))}
          {disciplines.map(({ label, count }) => (
            <TagChip key={label} label={label} count={count} onSelect={onSelect} variant="outline" />
          ))}
        </div>
      )}
      {contentNames.length > 0 && (
        <p className="text-muted-foreground text-xs">{t('brief.contains', { list: contentNames.join(' · ') })}</p>
      )}
    </section>
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
        {label}
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
  const { failed, held, unplaced } = brief.attention
  if (failed.length + held.length + unplaced.length === 0) return null
  return (
    <section className="flex flex-col gap-2.5 px-4 py-3" aria-labelledby="folder-brief-needs">
      <h3 id="folder-brief-needs" className="text-muted-foreground text-xs font-medium">
        {t('brief.needsTitle')}
      </h3>
      {failed.length > 0 && (
        <AttentionRow
          tone="destructive"
          text={t('brief.failedLine', { count: failed.length })}
          onShow={() => onSelect({ kind: 'state', state: 'failed' })}
          testId="folder-brief-needs-failed"
        >
          {onReadAgain && (
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
                : t('brief.readAgainAll', { count: failed.length })}
            </Button>
          )}
        </AttentionRow>
      )}
      {held.length > 0 && (
        <AttentionRow
          tone="warning"
          text={t('brief.heldLine', { count: held.length })}
          onShow={() => onSelect({ kind: 'state', state: 'held' })}
          testId="folder-brief-needs-held"
        />
      )}
      {unplaced.length > 0 && (
        <AttentionRow
          tone="muted"
          text={t('brief.unplacedLine', { count: unplaced.length })}
          hint={t('brief.unplacedHint')}
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
  onShow,
  testId,
  children,
}: {
  tone: MeterTone
  text: string
  hint?: string
  onShow: () => void
  testId: string
  children?: React.ReactNode
}) {
  const t = useTranslations('files')
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid={testId}>
      <div className="flex min-w-0 flex-1 basis-60 items-start gap-2">
        <ToneSwatch tone={tone} className="mt-[3px]" />
        <div className="min-w-0">
          <p className="text-foreground text-[13px] leading-snug">{text}</p>
          {hint && <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{hint}</p>}
        </div>
      </div>
      {/* Indented by the swatch and its gap, so a row that wraps on a phone
          puts its buttons under the sentence rather than under the swatch. */}
      <div className="ml-[18px] flex shrink-0 items-center gap-1.5">
        {children}
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onShow}>
          {t('brief.show')}
        </Button>
      </div>
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
    <section className="flex flex-col gap-1 px-4 py-3" aria-labelledby="folder-brief-where">
      <h3 id="folder-brief-where" className="text-muted-foreground mb-1 text-xs font-medium">
        {t('brief.whereTitle')}
      </h3>
      <ul className="flex flex-col">
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
    </section>
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
  return (
    <section className="flex flex-col gap-2 px-4 py-3" aria-labelledby="folder-brief-missing" data-testid="folder-brief-missing">
      <h3 id="folder-brief-missing" className="text-muted-foreground text-xs font-medium">
        {t('brief.missingTitle')}
      </h3>
      <p className="text-foreground text-[13px] leading-snug">{t('brief.missingLead')}</p>
      <ul className="flex flex-wrap gap-1.5">
        {shown.map((entry) => (
          <li key={`${entry.role}@${entry.bauwerkName ?? ''}`}>
            <Chip variant="outline" size="sm">
              <ToneSwatch tone="muted" />
              {entry.bauwerkName ? `${entry.label} · ${entry.bauwerkName}` : entry.label}
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
    </section>
  )
}
