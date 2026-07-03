// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * LandingTopBar — the slim, sticky marketing header for logged-out visitors.
 * Brand mark on the left, a single Sign in affordance on the right.
 */

import { type FC } from 'react'
import { Logo } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'

interface LandingTopBarProps {
  onSignIn?: () => void
}

export const LandingTopBar: FC<LandingTopBarProps> = ({ onSignIn }) => {
  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 md:px-8">
        <Logo kind="horizontal" size="small" />
        <Button size="sm" onClick={onSignIn}>
          Sign in
        </Button>
      </div>
    </header>
  )
}
