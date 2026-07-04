/**
 * LandingHero — the flagship first impression. A confident headline about
 * building compliance grounded in the code, a one-paragraph subhead, the
 * primary Sign in CTA, and — as the hero visual — a static LegalBasisCard
 * mock so the citation quality is visible immediately.
 *
 * Entrance: a quiet staggered reveal (eyebrow → h1 → subhead → CTA) with the
 * hero visual settling in last on a gentle spring.
 */

'use client'

import { type FC } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Stagger, StaggerItem, motion, fadeRise, springGentle } from '@/components/motion'
import { LegalBasisCardMock } from './LegalBasisCardMock'

interface LandingHeroProps {
  onSignIn?: () => void
}

export const LandingHero: FC<LandingHeroProps> = ({ onSignIn }) => {
  return (
    <section
      aria-labelledby="hero-heading"
      className="mx-auto w-full max-w-5xl px-6 pb-24 pt-20 md:px-8 md:pb-32 md:pt-28"
    >
      <div className="grid items-center gap-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-20">
        {/* Copy column */}
        <Stagger className="flex flex-col items-start">
          <motion.p
            variants={fadeRise}
            transition={springGentle}
            className="text-xs font-medium uppercase tracking-widest text-muted-foreground"
          >
            OIB &amp; RIS compliance copilot for Austrian architects
          </motion.p>

          <motion.h1
            id="hero-heading"
            variants={fadeRise}
            transition={springGentle}
            className="mt-5 text-5xl font-semibold tracking-tight text-foreground text-balance md:text-6xl"
          >
            Every answer, grounded in the building code.
          </motion.h1>

          <motion.p
            variants={fadeRise}
            transition={springGentle}
            className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg"
          >
            Grid answers building-compliance questions for each of your projects — grounded in
            the OIB-Richtlinien and Austrian legal sources from RIS. Every answer is scoped to
            the project at hand and cited to the exact Richtlinie and paragraph, so you can
            verify it against the code itself.
          </motion.p>

          <StaggerItem className="mt-10 flex flex-wrap items-center gap-4">
            <Button size="lg" onClick={onSignIn}>
              Sign in
              <ArrowRight aria-hidden="true" />
            </Button>
            <span className="text-sm text-muted-foreground">
              Single sign-on for your practice
            </span>
          </StaggerItem>
        </Stagger>

        {/* Hero visual: static proof-of-work citation — settles in last */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...springGentle, delay: 0.3 }}
          whileHover={{ y: -4, rotate: -0.25, transition: springGentle }}
          className="lg:pl-4"
        >
          <LegalBasisCardMock />
        </motion.div>
      </div>
    </section>
  )
}
