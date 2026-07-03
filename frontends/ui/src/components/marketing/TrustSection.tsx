// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * TrustSection — the precision statement. Grid's authority comes from
 * verifiable citations to the OIB-Richtlinien and RIS, not from confident
 * prose. This section makes that promise explicit.
 */

import { type FC } from 'react'
import { Scale, FileCheck2, Search, type LucideIcon } from 'lucide-react'

interface Point {
  icon: LucideIcon
  title: string
  body: string
}

const points: Point[] = [
  {
    icon: Scale,
    title: 'Grounded in the OIB-Richtlinien',
    body: 'Answers are drawn from the Austrian building guidelines — the same regulations you are held to — never from unsourced generalities.',
  },
  {
    icon: Search,
    title: 'Traceable to RIS',
    body: 'Gesetze and Verordnungen are linked back to the federal legal information system, so every legal basis leads to its primary source.',
  },
  {
    icon: FileCheck2,
    title: 'Cited to the exact paragraph',
    body: 'Each answer names the Richtlinie and § it relies on, with the cited excerpt shown, so you review the code — not the model.',
  },
]

export const TrustSection: FC = () => {
  return (
    <section className="border-y bg-muted/30">
      <div className="mx-auto w-full max-w-5xl px-4 py-16 md:px-8 md:py-20">
        <div className="max-w-2xl">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Precision you can verify
          </h2>
          <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground text-balance">
            Built for work where the citation is the answer.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Building compliance leaves no room for a confident guess. Grid is designed so every
            claim can be checked against its source — the way an architect signs off on a design.
          </p>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {points.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex flex-col rounded-lg border bg-card p-6">
              <span className="flex size-9 items-center justify-center rounded-md border bg-background text-primary">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-sm font-semibold text-foreground">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
