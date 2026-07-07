/**
 * LandingTopBar — the slim, sticky glass header for logged-out visitors.
 * Brand mark on the left, a single Sign in affordance on the right, separated
 * from the page by a hairline border.
 */

'use client'

import { type FC } from 'react'
import { Logo } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import { FadeIn } from '@/components/motion'
import { useTranslations } from '@/i18n'

interface LandingTopBarProps {
  onSignIn?: () => void
}

export const LandingTopBar: FC<LandingTopBarProps> = ({ onSignIn }) => {
  const t = useTranslations('landing')
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-xl">
      <FadeIn
        distance={4}
        className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6 md:px-8"
      >
        <Logo kind="horizontal" size="small" />
        <Button size="sm" onClick={onSignIn}>
          {t('topBar.signIn')}
        </Button>
      </FadeIn>
    </header>
  )
}
