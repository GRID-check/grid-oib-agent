// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ClosingCta — a calm closing band that restates the value and repeats the
 * primary Sign in action.
 */

import { type FC } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ClosingCtaProps {
  onSignIn?: () => void
}

export const ClosingCta: FC<ClosingCtaProps> = ({ onSignIn }) => {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-20 md:px-8 md:py-28">
      <div className="flex flex-col items-center rounded-lg border bg-card px-6 py-14 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground text-balance md:text-3xl">
          Answer your next building-code question with confidence.
        </h2>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Sign in to create a project, add your documents, and get answers cited to the exact
          OIB-Richtlinie.
        </p>
        <Button size="lg" onClick={onSignIn} className="mt-8">
          Sign in
          <ArrowRight />
        </Button>
      </div>
    </section>
  )
}
