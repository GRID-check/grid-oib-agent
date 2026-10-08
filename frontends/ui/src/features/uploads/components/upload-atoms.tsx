'use client'

/**
 * The upload surfaces' own atoms (ADR-0083): one count with its icon and word,
 * as a tile in the summary and as a pill in the history, and a term with how
 * many files it kept back. Both surfaces compose these, so a count reads the
 * same in the dialog and in the project's list.
 *
 * The words for the document outcomes are the status badge's own
 * (`files.status.*`): „Zitierbar" on a tile and „Zitierbar" on the badge of the
 * file under it are one fact, said once.
 */

import type { JSX } from 'react'
import {
  Archive,
  CircleCheck,
  CircleX,
  Clock3,
  Equal,
  FilePen,
  Folder,
  Lock,
  MonitorOff,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react'

import { Chip, ChipCount } from '@/components/ui/chip'
import { CountPill } from '@/components/ui/count-pill'
import { StatCardIcon } from '@/components/ui/stat-card'
import { useTranslations } from '@/i18n'
import type { CountKey } from '../lib/upload-summary'

type Tone = 'success' | 'info' | 'warning' | 'destructive' | 'muted'

/** Icon and tone per count. Colour never travels alone: every tile and pill also says its word. */
const TALLY_LOOK: Record<CountKey, { icon: LucideIcon; tone: Tone }> = {
  ready: { icon: CircleCheck, tone: 'success' },
  reading: { icon: Clock3, tone: 'info' },
  quarantined: { icon: ShieldAlert, tone: 'warning' },
  failed: { icon: CircleX, tone: 'destructive' },
  stored: { icon: Archive, tone: 'muted' },
  unchanged: { icon: Equal, tone: 'muted' },
  excluded: { icon: MonitorOff, tone: 'muted' },
  changed: { icon: FilePen, tone: 'info' },
  protected: { icon: Lock, tone: 'muted' },
}

/** The word for each count, from the dictionary that already says it. */
export function useTallyLabel(): (key: CountKey) => string {
  const tFiles = useTranslations('files')
  const t = useTranslations('uploadBatches')
  return (key) => {
    switch (key) {
      case 'ready':
        return tFiles('status.ready')
      case 'reading':
        return tFiles('status.processing')
      case 'quarantined':
        return tFiles('status.quarantined')
      case 'failed':
        return tFiles('status.failed')
      case 'stored':
        return tFiles('status.stored')
      case 'unchanged':
        return t('summary.counts.unchanged')
      case 'excluded':
        return t('summary.counts.excluded')
      case 'changed':
        return t('summary.counts.changed')
      case 'protected':
        return t('summary.counts.protected')
    }
  }
}

/** One headline count in the summary: a tinted well, the number, the word. */
export function TallyTile({ tally, count, label }: { tally: CountKey; count: number; label: string }): JSX.Element {
  const look = TALLY_LOOK[tally]
  return (
    <li
      className="bg-card shadow-2xs flex min-w-0 items-center gap-2.5 rounded-md border px-3 py-2"
      data-testid={`upload-tally-${tally}`}
    >
      <StatCardIcon icon={look.icon} tone={look.tone} size="sm" />
      <div className="min-w-0">
        <p className="text-foreground text-lg leading-tight font-semibold tracking-tight tabular-nums">{count}</p>
        <p className="text-muted-foreground text-xs leading-tight hyphens-auto">{label}</p>
      </div>
    </li>
  )
}

/** One count as a small pill, for a dense row (the project's upload history). */
export function TallyPill({ tally, count, label }: { tally: CountKey; count: number; label: string }): JSX.Element {
  const look = TALLY_LOOK[tally]
  const Icon = look.icon
  return (
    <Chip variant={look.tone} size="sm" data-testid={`upload-pill-${tally}`}>
      <Icon aria-hidden />
      {label}
      <ChipCount>{count}</ChipCount>
    </Chip>
  )
}

/**
 * What one file was besides how it ended, as a chip on its row: the tile's own
 * icon and word, so „Geschützt" on the tile and on the file are one fact. The
 * title says what it means.
 */
export function FacetChip({ facet, label, hint }: { facet: 'changed' | 'protected'; label: string; hint: string }): JSX.Element {
  const look = TALLY_LOOK[facet]
  const Icon = look.icon
  return (
    <Chip variant={look.tone} size="sm" title={hint} data-testid={`upload-facet-${facet}`}>
      <Icon aria-hidden />
      {label}
      <span className="sr-only">: {hint}</span>
    </Chip>
  )
}

/** A name and how many files carry it: a screening term, a document type. */
export function NamedCount({ name, count }: { name: string; count: number }): JSX.Element {
  return (
    <Chip variant="muted" className="max-w-full">
      <span className="truncate">{name}</span>
      <ChipCount>{count}</ChipCount>
    </Chip>
  )
}

/** A folder's heading over its files, with how many of them arrived there. Path segments keep their case. */
export function FolderHeading({ label, count }: { label: string; count: number }): JSX.Element {
  return (
    <h4 className="text-foreground flex min-w-0 items-center gap-1.5 text-xs font-medium">
      <Folder className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
      <CountPill>{count}</CountPill>
    </h4>
  )
}
