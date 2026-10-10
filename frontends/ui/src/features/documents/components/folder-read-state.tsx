'use client'

import type { JSX } from 'react'
import { ToneSwatch, type MeterTone } from '@/components/ui/segment-meter'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { readMarkOf, type KnowledgeTally, type ReadMark } from '../lib/folder-knowledge'

export const READ_MARK_TONE: Record<ReadMark['state'], MeterTone> = {
  failed: 'destructive',
  held: 'warning',
  reading: 'info',
  unplaced: 'muted',
  allRead: 'success',
}

/** The dictionary key a mark reads as; every one takes `{count}`. */
export const READ_MARK_KEY: Record<ReadMark['state'], string> = {
  failed: 'brief.states.failed',
  held: 'brief.states.held',
  reading: 'brief.states.reading',
  unplaced: 'brief.unplacedShort',
  allRead: 'brief.allRead',
}

/**
 * Where a folder's WHOLE subtree stands with Piloti, as one swatch and a word:
 * „2 fehlgeschlagen", „3 werden gelesen", „Alles gelesen".
 *
 * On every folder tile and row, so the read state of nested folders is visible
 * from the level above them without opening each one — the first thing feld72
 * asked for. Nothing is drawn for an empty folder.
 */
export function FolderReadState({
  tally,
  withUnplaced = false,
  className,
}: {
  tally: KnowledgeTally | undefined
  withUnplaced?: boolean
  className?: string
}): JSX.Element | null {
  const t = useTranslations('files')
  const mark = tally ? readMarkOf(tally, { withUnplaced }) : null
  if (!mark) return null
  return (
    <span
      className={cn('text-muted-foreground inline-flex shrink-0 items-center gap-1.5 text-xs', className)}
      data-testid="folder-read-state"
      data-state={mark.state}
    >
      <ToneSwatch tone={READ_MARK_TONE[mark.state]} />
      {t(READ_MARK_KEY[mark.state], { count: mark.count })}
    </span>
  )
}
