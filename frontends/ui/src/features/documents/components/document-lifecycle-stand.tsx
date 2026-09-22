'use client'

/**
 * Where a document stands, in one glance: the word, the track it is on, and
 * what it is waiting for.
 *
 * ## Why a track and not just the badge
 *
 * „In Prüfung" is only informative to somebody who already knows that Prüfung
 * comes after Entwurf and before Freigegeben. Four words in a fixed order is a
 * model the reader had to be taught somewhere else, and nowhere in the product
 * taught it. The track IS the teaching: four segments, the ones behind the
 * document filled, the ones ahead empty, so the badge reads as a position
 * rather than as a label.
 *
 * ## The one place chroma was let in, and the two it was not
 *
 * The design language spends colour on provenance
 * (`docs/design/grid-design-language.md`), and everything else in this feature
 * holds that line: the badge word is ink, and the diff marks a changed line with
 * a rule, a gutter glyph and ink weight. The track is the exception, asked for
 * and granted deliberately, because a bar that is ink from end to end says
 * „four segments" and not „you are through three of them".
 *
 * It is let in on two conditions.
 *
 * **Only where the state earns it, which is not most of the time.** A version
 * in flight — Entwurf, In Prüfung — is ink: nothing has been asserted yet, and
 * a colour there would be decoration. The bar turns when something has actually
 * happened to the document: {@link TRACK_TINT}.
 *
 * **Never the Büroarchiv gold.** `--text-color-feedback-warning` is an alias of
 * `--source-office`, the Büroarchiv's own provenance signal (`styles/tokens.css`
 * says so on the line), and this feature has just finished untangling one
 * archive collision in its words — putting the same collision back as a colour
 * would be a poor trade. „Änderungen erbeten" therefore shares the stopped
 * tint with „Abgelehnt" rather than taking amber, and the dashed segment plus
 * the sentence below carry the difference between them.
 *
 * Colour never travels alone here: the sentence naming the state sits directly
 * under the bar, the bar is `aria-hidden`, and the stop is a dashed outline as
 * well as a tint — so the track is still legible in a monochrome print and to
 * somebody who cannot tell the two tints apart.
 */

import { StageTrack } from '@/components/ui/stage-track'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'
import {
  LIFECYCLE_STAGES,
  lifecycleProgress,
  lifecycleWaiting,
} from '../lib/document-lifecycle'

export interface DocumentLifecycleStandProps {
  version: Pick<DocumentVersionView, 'state' | 'submittedBy'> | null
  lifecycle: 'active' | 'archived'
  /** Resolves a user id to a name — the panel's own, so „Sie" survives. */
  nameOf: (userId: string | null) => string
  className?: string
}

export function DocumentLifecycleStand({
  version,
  lifecycle,
  nameOf,
  className,
}: DocumentLifecycleStandProps): JSX.Element {
  const t = useTranslations('files')
  const progress = lifecycleProgress(version, lifecycle)
  const waiting = lifecycleWaiting(version, lifecycle)

  return (
    <div className={cn('space-y-1.5', className)} data-testid="document-lifecycle-stand">
      <StageTrack
        stages={LIFECYCLE_STAGES}
        reached={progress.reached}
        halted={progress.halted}
        tone={progress.tone}
        data-testid="document-lifecycle-track"
      />
      <p className="text-muted-foreground text-xs" data-testid="document-review-waiting">
        {waiting.submitterUserId
          ? t(`lifecycle.waiting.${waiting.key}`, { name: nameOf(waiting.submitterUserId) })
          : t(`lifecycle.waiting.${waiting.key}`)}
      </p>
    </div>
  )
}
