// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * LegalBasisCardMock — a static, presentational replica of the product's
 * proof-of-work card, used as the landing hero visual.
 *
 * It intentionally mirrors the domain treatment of the real LegalBasisCard
 * (quiet card, thin left accent, § references in mono, a real blockquote for
 * the cited excerpt, a plain-language summary) so logged-out visitors see the
 * citation quality before they ever sign in. No interactivity, no live data.
 */

import { type FC } from 'react'
import { Scale, ExternalLink } from 'lucide-react'

export const LegalBasisCardMock: FC = () => {
  return (
    <div
      aria-hidden="true"
      className="animate-in fade-in-0 slide-in-from-bottom-1 flex flex-col gap-3 rounded-lg border border-l-2 border-l-primary/40 bg-card p-5 shadow-sm duration-500"
    >
      {/* Eyebrow — marks this as a citation, not a message */}
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Scale className="size-3.5" />
        <span>Legal basis</span>
      </div>

      {/* Header: Richtlinie + § reference */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-foreground">OIB-Richtlinie 2 — Brandschutz</p>
        <span className="inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs text-muted-foreground">
          § 2.1
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
        fire resistance for the required period, and the layout must limit the spread of fire
        and smoke between compartments.
      </p>

      {/* Verifiable primary source (static, non-interactive in the mock) */}
      <span className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary">
        <ExternalLink className="size-3.5" />
        View OIB-Richtlinie
      </span>
    </div>
  )
}
