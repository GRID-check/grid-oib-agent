/**
 * LegalBasisCardMock — a static, presentational replica of the product's
 * proof-of-work card, used as the landing hero visual.
 *
 * A floating elevated artifact: the primary citation card sits on shadow-lg
 * with a second, quieter card peeking out behind it for depth. It mirrors the
 * domain treatment of the real LegalBasisCard (hairline border, thin left
 * accent, § references in mono, a real blockquote for the cited excerpt, a
 * plain-language summary). No interactivity, no live data.
 */

import { type FC } from 'react'
import { Scale, ExternalLink } from 'lucide-react'

export const LegalBasisCardMock: FC = () => {
  return (
    <div aria-hidden="true" className="relative">
      {/* Secondary card peeking behind — depth without gradients */}
      <div className="absolute -right-3 -top-3 hidden h-full w-full rounded-2xl border border-border bg-card shadow-sm sm:block">
        <div className="flex items-center gap-1.5 p-5 text-xs font-medium uppercase tracking-widest text-muted-foreground/60">
          <Scale className="size-3.5" />
          <span>Legal basis</span>
          <span className="ml-auto rounded-md border border-border px-2 py-0.5 font-mono normal-case tracking-normal">
            § 3.2
          </span>
        </div>
      </div>

      {/* Primary citation card */}
      <div className="relative flex flex-col gap-4 rounded-2xl border border-border border-l-2 border-l-primary/40 bg-card p-6 shadow-lg md:p-7">
        {/* Eyebrow — marks this as a citation, not a message */}
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          <Scale className="size-3.5" />
          <span>Legal basis</span>
        </div>

        {/* Header: Richtlinie + § reference */}
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-foreground">
            OIB-Richtlinie 2 — Brandschutz
          </p>
          <span className="inline-flex items-center rounded-md border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
            § 2.1
          </span>
          <span className="inline-flex items-center rounded-md border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
            Ausgabe 2023
          </span>
        </div>

        {/* Cited excerpt — a real blockquote at a readable measure */}
        <blockquote className="max-w-prose border-l-2 border-border pl-4 text-sm italic leading-relaxed text-muted-foreground">
          „Bauwerke müssen derart geplant und ausgeführt sein, dass bei einem Brand die
          Tragfähigkeit des Bauwerks für einen bestimmten Zeitraum erhalten bleibt und die
          Ausbreitung von Feuer und Rauch innerhalb des Bauwerks begrenzt wird.“
        </blockquote>

        {/* Plain-language summary */}
        <p className="max-w-prose text-sm leading-relaxed text-foreground">
          For this project&rsquo;s building class, load-bearing elements must maintain their
          fire resistance for the required period, and the layout must limit the spread of
          fire and smoke between compartments.
        </p>

        {/* Verifiable primary source (static, non-interactive in the mock) */}
        <div className="flex items-center justify-between border-t border-border pt-4">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
            <ExternalLink className="size-3.5" />
            View OIB-Richtlinie 2
          </span>
          <span className="font-mono text-xs text-muted-foreground/60">Verified source</span>
        </div>
      </div>
    </div>
  )
}
