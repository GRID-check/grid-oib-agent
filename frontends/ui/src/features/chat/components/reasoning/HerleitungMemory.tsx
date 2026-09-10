'use client'

/**
 * The memory band of the Herleitung — what the turn read out of the store,
 * AFTER the knowledge levels and visibly apart from them (ADR-0055).
 *
 * ## Why it is not a seventh level
 *
 * `HerleitungLevels` answers "which knowledge level was read", and every band
 * in it is a shelf whose hits can be opened, quoted and checked. A note is none
 * of those things: nobody wrote it down as a passage, no page holds it, and the
 * product's whole proposition is that a claim resolves to something a person
 * can open. Putting memory in that list — even last, even grey — would extend
 * the band's promise over a claim nothing can verify, which is exactly the
 * conflation ADR-0026 and ADR-0037 keep out of the citation model.
 *
 * So it renders under its own heading, separated by a hairline, and the first
 * thing it says is that it is not evidence.
 *
 * ## What it may state
 *
 * That the notes were IN CONTEXT, how many exist, how many were left out, and
 * whether the turn reached past the digest with `search_memory`. Never that a
 * note was used.
 */

import { type FC } from 'react'
import { Brain, CircleSlash } from 'lucide-react'

import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import type { MemoryBand } from '../../lib/herleitung-levels'

export interface HerleitungMemoryProps {
  /** `null` on a turn that read no memory at all — the band does not render. */
  band: MemoryBand | null
}

export const HerleitungMemory: FC<HerleitungMemoryProps> = ({ band }) => {
  const t = useTranslations('chat')
  if (!band) return null

  const carried = band.entries.length
  const empty = carried === 0

  return (
    <section
      className="border-base flex flex-col gap-1.5 border-t pt-2"
      data-testid="herleitung-memory"
    >
      <SectionLabel as="h3">{t('workspace.herleitung.memory.title')}</SectionLabel>

      {/* Said before the numbers, not after them. A reader who stops at the
          first line must still have been told what this band is. */}
      <p className="text-muted-foreground text-xs leading-snug">
        {t('workspace.herleitung.memory.notEvidence')}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {/* Grey AND saying it in words: on this surface colour is never the
            only carrier of a state. */}
        <SourceSignalChip signal="auto" icon={empty ? CircleSlash : Brain}>
          {empty
            ? t('workspace.herleitung.memory.none')
            : t('workspace.herleitung.memory.carried', { carried })}
        </SourceSignalChip>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t('workspace.herleitung.memory.of', { total: band.total })}
        </span>
        {band.omitted > 0 && (
          <span
            className="text-muted-foreground text-xs tabular-nums"
            data-testid="herleitung-memory-omitted"
          >
            {t('workspace.herleitung.memory.omitted', { omitted: band.omitted })}
          </span>
        )}
      </div>

      {/* Reaching past the digest is a DECISION the agent made, not a default,
          so it gets its own sentence rather than a number folded into the row
          above. */}
      {band.searchedMemory && (
        <p className="text-muted-foreground text-xs leading-snug" data-testid="herleitung-memory-searched">
          {t('workspace.herleitung.memory.searched', { searched: band.searched })}
        </p>
      )}
    </section>
  )
}
