/**
 * HowItWorks — four borderless steps under hairline rules, each led by a
 * large muted mono numeral: create a project, add the plans and documents,
 * ask Grid for cited answers, and run deep research for involved questions.
 */

'use client'

import { type FC } from 'react'
import { motion, fadeRise, staggerParent, springGentle } from '@/components/motion'

interface Step {
  title: string
  body: string
}

const steps: Step[] = [
  {
    title: 'Create a project',
    body: 'Set up a workspace for each building. Grid keeps every question, source, and answer scoped to that project.',
  },
  {
    title: 'Add plans & documents',
    body: 'Upload your plans, permits, and specifications. Grid reads them alongside the OIB-Richtlinien and RIS legal sources.',
  },
  {
    title: 'Ask Grid, get cited answers',
    body: 'Ask any building-code question in plain language. Every answer is cited to the exact Richtlinie and paragraph you can verify.',
  },
  {
    title: 'Run deep research',
    body: 'For involved questions, let Grid work through the sources step by step and return a structured, fully referenced brief.',
  },
]

export const HowItWorks: FC = () => {
  return (
    <section
      aria-labelledby="how-it-works-heading"
      className="mx-auto w-full max-w-5xl px-6 py-24 md:px-8 md:py-32"
    >
      <div className="max-w-2xl">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          How it works
        </p>
        <h2
          id="how-it-works-heading"
          className="mt-4 text-3xl font-semibold tracking-tight text-foreground text-balance md:text-4xl"
        >
          From plans to a cited answer, without leaving the code.
        </h2>
      </div>

      <motion.ol
        variants={staggerParent}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: '-64px' }}
        className="mt-16 grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-4"
      >
        {steps.map(({ title, body }, index) => (
          <motion.li
            key={title}
            variants={fadeRise}
            transition={springGentle}
            className="border-t border-border pt-6"
          >
            <span
              aria-hidden="true"
              className="font-mono text-4xl font-light text-muted-foreground/40 tabular-nums"
            >
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3 className="mt-6 text-sm font-semibold text-foreground">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
          </motion.li>
        ))}
      </motion.ol>
    </section>
  )
}
