/**
 * HowItWorks — four borderless steps under hairline rules, each led by a
 * large muted mono numeral: create a project, add the plans and documents,
 * ask Piloti for cited answers, and run deep research for involved questions.
 */

'use client'

import { type FC } from 'react'
import { motion, fadeRise, staggerParent, springGentle } from '@/components/motion'
import { useTranslations } from '@/i18n'

const stepKeys = ['create', 'documents', 'answers', 'research'] as const

export const HowItWorks: FC = () => {
  const t = useTranslations('landing')
  const steps = stepKeys.map((key) => ({
    title: t(`howItWorks.steps.${key}.title`),
    body: t(`howItWorks.steps.${key}.body`),
  }))
  return (
    <section
      aria-labelledby="how-it-works-heading"
      className="mx-auto w-full max-w-5xl px-4 py-16 sm:px-6 sm:py-24 md:px-8 md:py-32"
    >
      <div className="max-w-2xl">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {t('howItWorks.eyebrow')}
        </p>
        <h2
          id="how-it-works-heading"
          className="mt-4 text-3xl font-semibold tracking-tight text-foreground text-balance md:text-4xl"
        >
          {t('howItWorks.title')}
        </h2>
      </div>

      <motion.ol
        variants={staggerParent}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: '-64px' }}
        className="mt-10 grid gap-x-8 gap-y-8 sm:mt-16 sm:grid-cols-2 sm:gap-y-12 lg:grid-cols-4"
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
