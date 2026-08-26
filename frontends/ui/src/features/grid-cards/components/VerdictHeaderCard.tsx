/**
 * VerdictHeaderCard — the answer's TL;DR made structural, meant to sit at the
 * TOP of an answer.
 *
 * THE CARD IS THE FIGURE (`docs/design/grid-card-charter.md` §B1). The subject
 * reads as a quiet eyebrow, the verdict is the one large thing — 30px, the
 * biggest type anywhere in the card set — and there is no body list at all.
 * The card lands at roughly 100px tall and that height is its signature: it is
 * the only card in the system under 120px, so an answer that opens with one is
 * recognisable before it is read. Accented register (§A1): a 2px left edge in
 * INK, because this card makes a claim you may act on and ink is the action
 * colour here (chroma belongs to provenance).
 *
 * CONFIDENCE IS A GAUGE, NOT A PILL. A pill („mittlere Sicherheit" on a tint)
 * is legible but not comparable: two answers side by side give the reader two
 * words and no sense of which one the product is surer of. Three segments
 * filled to level are comparable at a glance, and three is exact rather than a
 * rounding — the enum has exactly three values, so the gauge encodes the field
 * and interpolates nothing (§D.1).
 *
 * The gauge is INK, not the old success/warning tints. Confidence is not a
 * verdict, and „mittel" rendered in the same amber as „knapp am Grenzwert"
 * spent a colour role on a second axis, which §A3 exists to stop. The German
 * word is still written out beside it and is still what carries the meaning —
 * the gauge is `aria-hidden` reinforcement, never a signal travelling alone.
 */

import { type FC } from 'react'
import { Gavel } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations, type Translator } from '@/i18n'
import { cn } from '@/lib/utils'
import { NormRefFooter } from '../schematics/kit'
import type { NormReferenceData } from '../schematics/types'

type Confidence = 'low' | 'medium' | 'high'

interface VerdictHeaderCardProps {
  verdict: string
  subject: string
  reference?: NormReferenceData | null
  confidence?: Confidence | null
  confidence_reason?: string | null
}

/**
 * German label + how many of the three segments are lit. Colour never travels
 * alone, and here it does not travel at all: the word IS the signal and the
 * gauge only makes two answers comparable.
 */
const CONFIDENCE: Record<Confidence, { label: (t: Translator) => string; level: 1 | 2 | 3 }> = {
  high: { label: (t) => t('cards.verdictHeader.confidenceHigh'), level: 3 },
  medium: { label: (t) => t('cards.verdictHeader.confidenceMedium'), level: 2 },
  low: { label: (t) => t('cards.verdictHeader.confidenceLow'), level: 1 },
}

const SEGMENTS = [1, 2, 3] as const

/**
 * Above this many characters the verdict steps down from the Figure step to
 * the Value step (20px → 15px).
 *
 * Branching on the STRING, not on the viewport: „Brandabschnittsbildende
 * Bauteile REI 90" is too long for one line in the 636px desktop column and in
 * the 314px phone one alike, and it is the string that is the problem. 20px
 * itself survives 314px comfortably.
 *
 * The compound case is a real shape rather than an overflow guard —
 * `verdict_header_long` in the design canvas is a whole sentence („Bebauung
 * bis an die Grundgrenze ist nur zulässig, wenn …"), and a sentence set at the
 * Figure step is a banner, not an answer.
 */
const LONG_VERDICT = 24

export const VerdictHeaderCard: FC<VerdictHeaderCardProps> = ({
  verdict,
  subject,
  reference,
  confidence,
  confidence_reason,
}) => {
  const t = useTranslations('chat')
  const conf = confidence ? CONFIDENCE[confidence] : null
  const text = verdict ?? ''

  return (
    <Card className="gap-2.5 border-l-2 border-l-primary/40 p-5 shadow-xs">
      <SectionLabel icon={Gavel}>{subject}</SectionLabel>

      {/* `hyphens-auto break-words` is not belt-and-braces, it is the phone.
          „Hauptgeschoßfußbodenoberkante" is one 29-character token and at 24px
          it is wider than the whole 314px column, so with only `text-balance`
          it ran straight out of the card. Hyphenation breaks it properly where
          the browser knows German (the document carries `lang`), and the hard
          break is the guarantee that nothing ever overflows the card. */}
      <p
        className={cn(
          'hyphens-auto break-words text-balance tracking-tight text-foreground',
          text.length > LONG_VERDICT ? 'card-value' : 'card-figure-20',
        )}
      >
        {text}
      </p>

      {conf && (
        <div className="flex items-center gap-2">
          {/* Three cells, filled to level. `aria-hidden` because the word
              beside it says the same thing to a screen reader, and two readings
              of one field is one too many.

              The cells are SQUARE, not the charter's 12×3px bars. Drawn as
              bars they were correct at „gering" and „mittel" — one lit, two
              grey, obviously a level — and wrong at „hohe Sicherheit", where
              all three light up, there is no unlit portion left to see, and
              three short strokes in a row read as an em-dash rule leading into
              the label rather than as three of three. A full meter and a rule
              are the same picture; that is a property of filling to level, not
              a tuning problem, and tightening the gaps did not fix it. A square
              is a token rather than a stroke, so ▪▪▪ still counts. */}
          <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
            {SEGMENTS.map((segment) => (
              <span
                key={segment}
                className={cn(
                  'size-[5px] rounded-[1px]',
                  segment <= conf.level ? 'bg-foreground' : 'bg-foreground/20',
                )}
              />
            ))}
          </span>
          <span className="card-meta text-muted-foreground">{conf.label(t)}</span>
        </div>
      )}

      {confidence_reason && (
        <p className="card-meta max-w-prose text-muted-foreground">{confidence_reason}</p>
      )}

      <NormRefFooter reference={reference} />
    </Card>
  )
}
