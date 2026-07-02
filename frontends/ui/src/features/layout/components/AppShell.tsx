// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ReactNode } from 'react'
import { GlobalTopNav } from './GlobalTopNav'

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps): JSX.Element {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-surface-sunken">
      <GlobalTopNav />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
