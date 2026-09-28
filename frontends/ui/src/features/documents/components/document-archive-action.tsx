'use client'

/**
 * „Stilllegen" — the one gesture in this panel that says what it does before it
 * does it.
 *
 * ## The word, first, because the word was half the bug
 *
 * It used to be called „Archivieren", and this product already has an Archiv:
 * the office archive (ADR-0024), where a document is placed so that it BECOMES
 * cross-project Bürowissen — „Hier abgelegte Dokumente werden zu Bürowissen und
 * stehen jedem Projekt Ihrer Organisation zur Verfügung", in the empty state's
 * own words. This act does the opposite: the file leaves the working set and
 * its ingested chunks are purged, so Piloti stops citing it. The same verb was
 * doing a thing and its inverse, which is not a near-miss a reader recovers
 * from by thinking harder.
 *
 * So the copy is „Stilllegen" / „Stillgelegt" (EN: retire / retired), and it
 * carries no archive-box icon either — that glyph is the Büroarchiv's own
 * provenance signal, and reusing it here would put the collision back in a
 * picture after taking it out of the words.
 *
 * The WIRE keeps `archive`: the route, the client method, the `lifecycle`
 * column and this file's own name. That is deliberate — the collision is in the
 * language, not in the data, and a migration to rename an enum value nobody
 * reads would be churn. Do not "fix" the mismatch by renaming the copy back.
 *
 * ## Why it was moved, and why it now asks
 *
 * It used to stand in the decision row beside „Freigeben" and „Ablehnen" as an
 * equal sibling, fired on one click, and explained nothing. On the ordinary
 * case — a person's upload, born `published`, with no review decision left to
 * take — it was the ONLY control the row had, so every file in the project
 * offered one unlabelled verb under a heading about approvals — and, per above,
 * the verb pointed at the wrong place. That is the report we got, in those
 * words: no idea what archiving does.
 *
 * Three things are true about the act and none of them were on screen
 * (`lib/documents/version-content.ts: archiveDocument`):
 *
 *   - the file leaves the Dateien listing, and comes back only through the one
 *     filter that WIDENS it („Stillgelegte auch zeigen");
 *   - the ingested chunks are PURGED, so Piloti stops citing it — that is the
 *     half nobody guesses from any single word, and it is the half that changes
 *     what the agent answers tomorrow;
 *   - nothing is deleted: the row, every version and every stored object stay.
 *
 * And a fourth that decides the ceremony: there is no route back. The
 * index would have to be rebuilt, and no surface offers it. A one-way door gets
 * a confirm that says it is one — the repo's rule, and `ConfirmDialog` is where
 * every "are you sure" in this product is designed.
 *
 * `warning` rather than `destructive`: the bytes survive, so the red reserved
 * for irreversible loss would overstate it. The copy carries the irreversibility
 * instead, which is the part a tone cannot say.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

export interface DocumentArchiveActionProps {
  /** The file's name, so the question names its subject. */
  filename?: string | null
  /** The archive request is in flight. */
  pending?: boolean
  onArchive: () => void
  className?: string
}

/** The consequences, in the order they matter to the reader. */
const CONSEQUENCES = ['listing', 'knowledge', 'kept', 'permanent'] as const

export function DocumentArchiveAction({
  filename,
  pending = false,
  onArchive,
  className,
}: DocumentArchiveActionProps): JSX.Element {
  const t = useTranslations('files')
  const [asking, setAsking] = useState(false)

  return (
    <div className={cn('space-y-1.5 border-t pt-3', className)} data-testid="document-archive-action">
      <p className="text-xs font-medium">{t('lifecycle.archiveSection.heading')}</p>
      <p className="text-muted-foreground text-xs">{t('lifecycle.archiveSection.blurb')}</p>
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          disabled={pending}
          aria-busy={pending}
          data-testid="document-lifecycle-archive"
          onClick={() => setAsking(true)}
        >
          {t('lifecycle.actions.archive')}
        </Button>
      </div>

      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        tone="warning"
        title={
          filename
            ? t('lifecycle.archiveSection.confirmTitleNamed', { filename })
            : t('lifecycle.archiveSection.confirmTitle')
        }
        description={
          /* The consequences as a LIST, not a sentence: four independent facts
             read as four, and the one that surprises people — Piloti stops
             citing it — cannot hide in the middle of a paragraph. */
          <ul className="mt-1 space-y-1.5" data-testid="document-archive-consequences">
            {CONSEQUENCES.map((key) => (
              <li key={key} className="flex gap-2">
                <span aria-hidden className="text-muted-foreground select-none">
                  ·
                </span>
                <span>{t(`lifecycle.archiveSection.consequences.${key}`)}</span>
              </li>
            ))}
          </ul>
        }
        confirmLabel={t('lifecycle.actions.archive')}
        cancelLabel={t('lifecycle.comment.cancel')}
        pending={pending}
        confirmTestId="document-archive-confirm"
        onConfirm={() => {
          setAsking(false)
          onArchive()
        }}
      />
    </div>
  )
}
