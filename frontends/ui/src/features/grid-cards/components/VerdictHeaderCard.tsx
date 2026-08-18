/**
 * VerdictHeaderCard — the answer's TL;DR made structural, meant to sit at the
 * TOP of an answer.
 *
 * The verdict is the lede rendered rather than written: the subject reads as a
 * quiet eyebrow, the verdict itself is the loud line (tabular-nums so a figure
 * like „1,10 m" aligns), an optional confidence chip qualifies it, and the norm
 * it rests on rides in the shared citation footer. Drawn as a card with a left
 * accent so it stands apart from the prose it heads.
 */

import { type FC } from 'react'
import { Gavel } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { SectionLabel } from '@/components/ui/section-label'
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

/** German label + subtle tone per confidence level. Colour never travels alone
 * — the word carries the signal, the tint only reinforces it. */
const CONFIDENCE: Record<Confidence, { label: string; className: string }> = {
  high: { label: 'hohe Sicherheit', className: 'bg-success-subtle text-success' },
  medium: { label: 'mittlere Sicherheit', className: 'bg-warning-subtle text-warning' },
  low: { label: 'geringe Sicherheit', className: 'bg-muted text-muted-foreground' },
}

export const VerdictHeaderCard: FC<VerdictHeaderCardProps> = ({
  verdict,
  subject,
  reference,
  confidence,
  confidence_reason,
}) => {
  const conf = confidence ? CONFIDENCE[confidence] : null

  return (
    <Card className="animate-in fade-in-0 slide-in-from-bottom-1 gap-2.5 border-l-2 border-l-primary/40 p-5 shadow-xs">
      <SectionLabel icon={Gavel}>{subject}</SectionLabel>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <p className="text-2xl font-semibold leading-tight tracking-tight tabular-nums text-foreground">
          {verdict}
        </p>
        {conf && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
              conf.className,
            )}
          >
            {conf.label}
          </span>
        )}
      </div>

      {confidence_reason && (
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{confidence_reason}</p>
      )}

      <NormRefFooter reference={reference} />
    </Card>
  )
}
