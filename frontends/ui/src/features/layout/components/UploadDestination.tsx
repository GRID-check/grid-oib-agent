/**
 * Where an attached file lands — said once, in one vocabulary.
 *
 * The chat has two attach affordances: the sources panel ({@link FileSourcesTab}),
 * which lets the user CHOOSE between the project corpus and the private session,
 * and the composer ({@link InputArea}), which has no choice at all — it always
 * uploads into the session. Only the panel ever said so, so the same
 * conversation offered two attach points with two different destinations and no
 * way for the user to tell them apart.
 *
 * Both surfaces now name the destination through this one primitive, over the
 * SAME `fileSourcesTab.target*` / `filesGoTo` copy, so the two statements cannot
 * drift into disagreeing about the same shelf.
 */

'use client'

import type { FC } from 'react'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * The shelf an upload is bound for. Deliberately the panel's existing
 * `uploadTarget` vocabulary rather than a new one — ADR-0047 Phase 2 unifies
 * these names, and inventing a third set here would be one more to unify.
 */
export type UploadDestination = 'project' | 'session'

export interface UploadDestinationCopy {
  /** Title-case name of the shelf — "Projekt-Korpus" / "Private Sitzung". */
  label: string
  /** The same name mid-sentence — "Projekt-Korpus" / "private Sitzung". */
  labelLower: string
  /** The full statement: "Hier hochgeladene Dateien gelangen in …". */
  sentence: string
}

/** The destination's copy, for callers that need the words without the markup. */
export function useUploadDestination(target: UploadDestination): UploadDestinationCopy {
  const t = useTranslations('research')
  const isProject = target === 'project'
  const label = t(isProject ? 'fileSourcesTab.targetProject' : 'fileSourcesTab.targetSession')
  const labelLower = t(
    isProject ? 'fileSourcesTab.targetProjectLower' : 'fileSourcesTab.targetSessionLower'
  )
  return {
    label,
    labelLower,
    sentence: t('fileSourcesTab.filesGoTo', { target: labelLower }),
  }
}

/**
 * One quiet line stating where files attached on this surface go. Carries a
 * stable test id so a surface can be asserted to state its destination at all —
 * the thing the composer used never to do.
 */
export const UploadDestinationNote: FC<{
  target: UploadDestination
  className?: string
}> = ({ target, className }) => {
  const { sentence } = useUploadDestination(target)
  return (
    <p data-testid="upload-destination" className={cn('text-muted-foreground text-xs', className)}>
      {sentence}
    </p>
  )
}
