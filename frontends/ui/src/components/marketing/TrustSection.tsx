/**
 * TrustSection — the precision statement. Grid's authority comes from
 * verifiable citations to the OIB-Richtlinien and RIS, not from confident
 * prose. This section makes that promise explicit.
 */

'use client'

import { type FC } from 'react'
import { Scale, FileCheck2, Search, type LucideIcon } from 'lucide-react'
import { Stagger, StaggerItem } from '@/components/motion'

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
    <section aria-labelledby="trust-heading" className="border-y border-border bg-muted/30">
      <div className="mx-auto w-full max-w-5xl px-6 py-24 md:px-8 md:py-32">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Precision you can verify
          </p>
          <h2
            id="trust-heading"
            className="mt-4 text-3xl font-semibold tracking-tight text-foreground text-balance md:text-4xl"
          >
            Built for work where the citation is the answer.
          </h2>
          <p className="mt-5 text-base leading-relaxed text-muted-foreground">
            Building compliance leaves no room for a confident guess. Grid is designed so every
            claim can be checked against its source — the way an architect signs off on a design.
          </p>
        </div>

        <Stagger inView className="mt-16 grid gap-6 md:grid-cols-3">
          {points.map(({ icon: Icon, title, body }) => (
            <StaggerItem
              key={title}
              className="flex flex-col rounded-2xl border border-border bg-card p-8 shadow-sm"
            >
              <span
                aria-hidden="true"
                className="flex size-9 items-center justify-center rounded-full border border-border bg-background text-primary"
              >
                <Icon className="size-4" />
              </span>
              <h3 className="mt-6 text-sm font-semibold text-foreground">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  )
}
