'use client'

import type { DocumentAuthor } from '@/lib/db/schema'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * „Von Piloti erstellt" — one quiet line saying who wrote the bytes.
 *
 * It is PROVENANCE, and the file-native design is explicit that provenance is
 * never rendered as responsibility. That rules out the shapes it could
 * plausibly have taken: not a chip (a chip beside the faces reads as another
 * party on the hook), not an avatar (a face is assignment, and Piloti has no
 * face here on purpose), not a badge (the badge slot answers "can Piloti quote
 * this", which for a generated report is a different and colder answer).
 *
 * So it is a byline: a line of muted text under the document's name, on the
 * surfaces that show a name — the card and the preview header — and separated
 * from the assignment row by the type · status line. A generated report is an
 * ordinary unassigned file, and its footer still says `Unvergeben`; that is
 * the design working, not a gap this line is here to fill.
 *
 * Renders nothing for a file a person uploaded, which is almost all of them:
 * "a human uploaded this" is the default and stating it would be noise.
 */
export function AuthorshipLine({
  authoredBy,
  className,
}: {
  authoredBy: DocumentAuthor | null | undefined
  className?: string
}) {
  const t = useTranslations('files')
  if (authoredBy !== 'agent') return null
  return (
    <p className={cn('truncate text-[11px] leading-[1.45] text-muted-foreground/85', className)}>
      {t('authorship.byPiloti')}
    </p>
  )
}
