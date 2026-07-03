// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * HowItWorks — a quiet, hairline-bordered feature grid describing the flow:
 * create a project, add the plans and documents, ask Grid for cited answers,
 * and run deep research for involved questions.
 */

import { type FC } from 'react'
import { FolderOpen, Upload, MessageSquareText, Telescope, type LucideIcon } from 'lucide-react'

interface Step {
  icon: LucideIcon
  title: string
  body: string
}

const steps: Step[] = [
  {
    icon: FolderOpen,
    title: 'Create a project',
    body: 'Set up a workspace for each building. Grid keeps every question, source, and answer scoped to that project.',
  },
  {
    icon: Upload,
    title: 'Add plans & documents',
    body: 'Upload your plans, permits, and specifications. Grid reads them alongside the OIB-Richtlinien and RIS legal sources.',
  },
  {
    icon: MessageSquareText,
    title: 'Ask Grid, get cited answers',
    body: 'Ask any building-code question in plain language. Every answer is cited to the exact Richtlinie and paragraph you can verify.',
  },
  {
    icon: Telescope,
    title: 'Run deep research',
    body: 'For involved questions, let Grid work through the sources step by step and return a structured, fully referenced brief.',
  },
]

export const HowItWorks: FC = () => {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-16 md:px-8 md:py-20">
      <div className="max-w-2xl">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          How it works
        </h2>
        <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground text-balance">
          From plans to a cited answer, without leaving the code.
        </p>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map(({ icon: Icon, title, body }, index) => (
          <div
            key={title}
            className="animate-in fade-in-0 flex flex-col rounded-lg border bg-card p-6 duration-500"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {String(index + 1).padStart(2, '0')}
              </span>
            </div>
            <h3 className="mt-4 text-sm font-semibold text-foreground">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
