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

import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'
import {
  LIFECYCLE_STAGES,
  lifecycleProgress,
  lifecycleWaiting,
  type LifecycleProgress,
  type LifecycleTone,
} from '../lib/document-lifecycle'

/**
 * The walked segments' fill, by what has happened to the version.
 *
 * Three values, and the neutral one is the common case. `signal-error` rather
 * than a second hue for `stopped`: the palette has exactly one chroma family
 * that is not a provenance source (`--signal-error`), and „zurückgewiesen" is
 * the one editorial fact it fits.
 */
const TRACK_TINT: Record<LifecycleTone, string> = {
  moving: 'bg-foreground',
  settled: 'bg-[var(--text-color-feedback-success)]',
  stopped: 'bg-[var(--signal-error)]',
  retired: 'bg-muted-foreground/50',
}

/** The stop's outline, matched to the tint so the halt reads as one mark. */
const STOP_OUTLINE: Record<LifecycleTone, string> = {
  moving: 'border-muted-foreground/70',
  settled: 'border-muted-foreground/70',
  stopped: 'border-[var(--signal-error)]',
  retired: 'border-muted-foreground/50',
}

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
      <LifecycleTrack progress={progress} />
      <p className="text-muted-foreground text-xs" data-testid="document-review-waiting">
        {waiting.submitterUserId
          ? t(`lifecycle.waiting.${waiting.key}`, { name: nameOf(waiting.submitterUserId) })
          : t(`lifecycle.waiting.${waiting.key}`)}
      </p>
    </div>
  )
}

/**
 * Four segments. Filled ones are behind the document; the first empty one is
 * where it goes next, and it is dashed when the document is not going there —
 * a refusal or a request for changes stopped the walk, and a plain empty
 * segment would read as „still on its way".
 *
 * An archived document's whole track is quiet: it has left the working set, and
 * which segment it reached on the way out is not the question a reader who
 * found it anyway is asking.
 */
function LifecycleTrack({ progress }: { progress: LifecycleProgress }): JSX.Element {
  const { reached, halted, tone } = progress
  return (
    <div
      aria-hidden
      className="flex items-center gap-1"
      data-testid="document-lifecycle-track"
      data-reached={reached}
      data-halted={halted || undefined}
      data-tone={tone}
    >
      {LIFECYCLE_STAGES.map((stage, index) => {
        const done = index < reached
        const next = index === reached
        return (
          <span
            key={stage}
            data-stage={stage}
            data-done={done || undefined}
            className={cn(
              'h-1 flex-1 rounded-full',
              done && TRACK_TINT[tone],
              !done && 'bg-border',
              // The stop: the segment the version is NOT walking into is drawn
              // as an outline rather than as a fill, so „angehalten" is visible
              // without depending on the tint and survives a monochrome print.
              !done && next && halted && cn('border border-dashed bg-transparent', STOP_OUTLINE[tone]),
            )}
          />
        )
      })}
    </div>
  )
}
