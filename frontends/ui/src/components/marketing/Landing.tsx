/**
 * Landing — the premium marketing page shown to genuine logged-out visitors.
 *
 * Understated, architect-grade, and token-driven (light/dark aware). It leads
 * with the product's proof-of-work (a cited LegalBasisCard), explains the flow,
 * makes the precision promise explicit, and repeats a single Sign in action.
 */

'use client'

import { type FC } from 'react'
import { LandingTopBar } from './LandingTopBar'
import { LandingHero } from './LandingHero'
import { HowItWorks } from './HowItWorks'
import { TrustSection } from './TrustSection'
import { ClosingCta } from './ClosingCta'
import { LandingFooter } from './LandingFooter'

interface LandingProps {
  /** Starts the single sign-on flow; wired to the primary CTAs. */
  onSignIn?: () => void
}

export const Landing: FC<LandingProps> = ({ onSignIn }) => {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <LandingTopBar onSignIn={onSignIn} />
      <main id="main-content" className="flex-1">
        <LandingHero onSignIn={onSignIn} />
        <HowItWorks />
        <TrustSection />
        <ClosingCta onSignIn={onSignIn} />
      </main>
      <LandingFooter />
    </div>
  )
}
