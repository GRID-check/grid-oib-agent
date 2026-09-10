'use client'

/**
 * "N Notizen aus dem Gedächtnis im Blick" — one collapsed line under the
 * answer, naming what the turn READ out of memory (ADR-0055).
 *
 * ## What it is not
 *
 * Not a citation chip, not a member of the "Belegt durch" row, and it takes
 * none of the citation tokens. A note is not a passage: nothing about it can be
 * opened, quoted or verified, and rendering it in the provenance families —
 * even the quietest of them — would make an unverifiable claim wear the
 * product's strongest one (ADR-0026, ADR-0037). It paints in `--source-auto`
 * grey, the family that is not a corpus, and it sits under the sources row
 * rather than inside it.
 *
 * ## What it may say
 *
 * Only that these notes were IN CONTEXT. Not that they were used, not that they
 * shaped the answer, not that they were relevant — none of which the answer
 * frame knows and none of which the model could truthfully report about itself.
 * The German copy is written on that line and the spec asserts it.
 *
 * Absent when nothing was carried: a marker reading "0" under every answer in a
 * project whose memory is still empty is noise on the one surface the card
 * charter asks to keep quiet.
 */

import { useState, type FC } from 'react'
import Link from 'next/link'
import { Brain, ChevronDown } from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Item, ItemContent, ItemList } from '@/components/ui/item'
import { useTranslations } from '@/i18n'
import { sourceSignalStyle } from '@/features/layout/components/SourceSignalChip'
import { hasMemoryMarker } from '../lib/memory-context'
import type { MemoryContext } from '@/adapters/api/schemas'

export interface MemoryContextMarkerProps {
  /** What the turn read out of memory. Absent on a turn that read none. */
  memoryContext?: MemoryContext
  /**
   * The project whose memory panel each note links to. Absent in the Büro,
   * where the notes are organization-scoped and this control is not their
   * doorway — the line then states the same fact and links nowhere, which is
   * still strictly more than the reader had before.
   */
  projectId?: string | null
  /**
   * Start expanded. Collapsed is the product default — the answer footer is a
   * surface the card charter asks to keep quiet — and this exists so the dev
   * preview can photograph the list without driving a click, which is a shot
   * that fails on a timing change rather than on a design change.
   */
  defaultOpen?: boolean
}

/** The panel a note is read, corrected and removed in. */
const memoryPanelHref = (projectId: string): string =>
  `/app/projects/${encodeURIComponent(projectId)}/settings#project-memory`

export const MemoryContextMarker: FC<MemoryContextMarkerProps> = ({
  memoryContext,
  projectId,
  defaultOpen = false,
}) => {
  const t = useTranslations('chat')
  const [open, setOpen] = useState(defaultOpen)

  // The absence rule lives in the model, not here: three surfaces read one
  // field and each of them asking the question its own way is how they drift.
  if (!hasMemoryMarker(memoryContext)) return null
  const carried = memoryContext?.carried ?? []

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex w-full flex-col"
      data-testid="memory-context-marker"
    >
      <CollapsibleTrigger
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 touch-target flex items-center gap-1.5 self-start rounded-md text-xs leading-relaxed transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2"
        aria-label={t('memoryContext.triggerAria', { count: carried.length })}
        data-testid="memory-context-trigger"
      >
        {/* Grey, and the grey is a token: `--source-auto` is the family that
            states "no corpus behind this". */}
        <span
          className="flex size-4 shrink-0 items-center justify-center rounded-full"
          style={sourceSignalStyle('auto')}
        >
          <Brain className="size-2.5" aria-hidden="true" />
        </span>
        <span>{t('memoryContext.trigger', { count: carried.length })}</span>
        <ChevronDown
          className={`size-3 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none${open ? ' rotate-180' : ''}`}
          aria-hidden="true"
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-1.5">
        <div className="flex flex-col gap-1.5">
          {/* The sentence that keeps the marker honest. It is inside the
              disclosure and not on the trigger because the trigger is one line
              on a quiet surface — but a reader who opens the list is asking
              exactly the question this answers. */}
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t('memoryContext.readNotUsed')}
          </p>

          <ItemList as="ul">
            {carried.map((note) =>
              projectId ? (
                <Item key={note.id} as="li" asChild>
                  <Link href={memoryPanelHref(projectId)} data-testid="memory-context-note">
                    <ItemContent>
                      <p className="text-foreground text-sm leading-snug">{note.content}</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {t(`memory.kinds.${note.kind}`)}
                      </p>
                    </ItemContent>
                  </Link>
                </Item>
              ) : (
                <Item key={note.id} as="li" data-testid="memory-context-note">
                  <ItemContent>
                    <p className="text-foreground text-sm leading-snug">{note.content}</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t(`memory.kinds.${note.kind}`)}
                    </p>
                  </ItemContent>
                </Item>
              )
            )}
          </ItemList>

          {/* The number the DIGEST told the model, said to the reader too. Its
              divergence from what the model was told is the inversion ADR-0055
              is written against, so it renders wherever the marker does. */}
          {memoryContext && memoryContext.omitted > 0 && (
            <p className="text-muted-foreground text-xs leading-relaxed" data-testid="memory-context-omitted">
              {t('memoryContext.omitted', { omitted: memoryContext.omitted })}
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
