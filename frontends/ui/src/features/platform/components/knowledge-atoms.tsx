'use client'

/**
 * The base-knowledge vocabulary, drawn once: a document's type chip and its
 * lifecycle badge. The table row, the detail sheet and the upload progress
 * list all show these, so they compose the same atoms rather than three
 * lookalikes.
 */

import type { JSX } from 'react'
import { useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import { useTranslations } from '@/i18n'
import {
  docClassAuthority,
  docClassSignal,
  resolveDocClass,
  type DocClass,
} from '@/lib/knowledge/doc-class'
import type { KnowledgeFileState } from '@/lib/knowledge/service'

/**
 * The translated name of a Dokumentart.
 *
 * `DOC_CLASS_LABELS` in `lib/knowledge/doc-class.ts` is the backend's German
 * vocabulary, kept for the parity test against the Python file. The UI reads
 * `platform.knowledge.docClasses.*` instead, so an English session does not
 * get German type names; the German entries equal the backend labels (pinned
 * in `base-knowledge.spec.tsx`).
 */
export function useDocClassLabel(): (docClass: DocClass | string | null | undefined) => string {
  const t = useTranslations('platform')
  return useCallback((docClass) => t(`knowledge.docClasses.${resolveDocClass(docClass)}`), [t])
}

/** The Dokumentart as a provenance chip, with the authority tag only where the label lacks it. */
export function DocClassChip({ docClass }: { docClass: string | null }): JSX.Element {
  const label = useDocClassLabel()(docClass)
  const tag = docClassAuthority(docClass)
  const text = tag && !label.includes(tag) ? `${label} · ${tag}` : label
  return <SourceSignalChip signal={docClassSignal(docClass)}>{text}</SourceSignalChip>
}

export const STATE_VARIANT: Record<
  KnowledgeFileState,
  'success' | 'info' | 'warning' | 'destructive' | 'secondary'
> = {
  ingested: 'success',
  pending: 'info',
  failed: 'destructive',
  stale: 'warning',
  removed: 'secondary',
  inconsistent: 'destructive',
}

/**
 * A document's lifecycle as a badge. `hint="tooltip"` explains the state on
 * hover; the detail sheet prints the same hint as text, so
 * it is never only behind a hover.
 */
export function KnowledgeStateBadge({
  state,
  hint = 'none',
}: {
  state: KnowledgeFileState
  hint?: 'none' | 'tooltip'
}): JSX.Element {
  const tk = useTranslations('knowledge')
  const badge = <Badge variant={STATE_VARIANT[state]}>{tk(`states.${state}`)}</Badge>
  if (hint === 'none') return badge
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{tk(`stateHints.${state}`)}</TooltipContent>
    </Tooltip>
  )
}
