/**
 * ClosingCta — a calm, unboxed closing statement that restates the value and
 * repeats the primary Sign in action. Whitespace, not a card, carries it.
 */

'use client'

import { type FC } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Stagger, StaggerItem, motion, fadeRise, springGentle } from '@/components/motion'

interface ClosingCtaProps {
  onSignIn?: () => void
}

export const ClosingCta: FC<ClosingCtaProps> = ({ onSignIn }) => {
  return (
    <section
      aria-labelledby="closing-cta-heading"
      className="mx-auto w-full max-w-5xl px-6 py-24 md:px-8 md:py-32"
    >
      <Stagger inView className="mx-auto flex max-w-2xl flex-col items-center text-center">
        <motion.h2
          id="closing-cta-heading"
          variants={fadeRise}
          transition={springGentle}
          className="text-3xl font-semibold tracking-tight text-foreground text-balance md:text-4xl"
        >
          Answer your next building-code question with confidence.
        </motion.h2>
        <motion.p
          variants={fadeRise}
          transition={springGentle}
          className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground"
        >
          Sign in to create a project, add your documents, and get answers cited to the exact
          OIB-Richtlinie.
        </motion.p>
        <StaggerItem className="mt-10">
          <Button size="lg" onClick={onSignIn}>
            Sign in
            <ArrowRight aria-hidden="true" />
          </Button>
        </StaggerItem>
      </Stagger>
    </section>
  )
}
