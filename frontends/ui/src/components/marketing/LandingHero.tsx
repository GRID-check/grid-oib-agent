// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * LandingHero — the flagship first impression. A confident headline about
 * building compliance grounded in the code, a one-paragraph subhead, the
 * primary Sign in CTA, and — as the hero visual — a static LegalBasisCard
 * mock so the citation quality is visible immediately.
 */

import { type FC } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LegalBasisCardMock } from './LegalBasisCardMock'

interface LandingHeroProps {
  onSignIn?: () => void
}

export const LandingHero: FC<LandingHeroProps> = ({ onSignIn }) => {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-16 pt-16 md:px-8 md:pb-24 md:pt-24">
      <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
        {/* Copy column */}
        <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex flex-col items-start duration-500">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            OIB &amp; RIS compliance copilot for Austrian architects
          </p>

          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-foreground text-balance md:text-5xl">
            Every answer, grounded in the building code.
          </h1>

          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground">
            Grid answers building-compliance questions for each of your projects — grounded in
            the OIB-Richtlinien and Austrian legal sources from RIS. Every answer is scoped to
            the project at hand and cited to the exact Richtlinie and paragraph, so you can
            verify it against the code itself.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={onSignIn}>
              Sign in
              <ArrowRight />
            </Button>
            <span className="text-sm text-muted-foreground">
              Single sign-on for your practice
            </span>
          </div>
        </div>

        {/* Hero visual: static proof-of-work citation */}
        <div className="lg:pl-4">
          <LegalBasisCardMock />
        </div>
      </div>
    </section>
  )
}
