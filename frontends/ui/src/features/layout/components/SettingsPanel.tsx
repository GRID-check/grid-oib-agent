// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * SettingsPanel Component
 *
 * Right-side docked panel for application settings.
 * Currently only contains appearance/theme settings.
 */

'use client'

import { type FC, memo, useCallback } from 'react'
import { Settings } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useLayoutStore } from '../store'
import type { ThemeMode } from '../types'
import { DockedPanel } from './DockedPanel'

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System Theme (Auto)' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/**
 * Settings panel for application preferences.
 * Opens from the right side of the screen.
 */
export const SettingsPanel: FC = memo(function SettingsPanel() {
  const isOpen = useLayoutStore((s) => s.rightPanel === 'settings')
  const theme = useLayoutStore((s) => s.theme)
  const closeRightPanel = useLayoutStore((s) => s.closeRightPanel)
  const setTheme = useLayoutStore((s) => s.setTheme)

  const handleThemeChange = useCallback(
    (value: string) => {
      setTheme(value as ThemeMode)
    },
    [setTheme]
  )

  return (
    <DockedPanel
      open={isOpen}
      side="right"
      onClose={closeRightPanel}
      aria-label="Settings"
      heading={
        <>
          <Settings className="h-5 w-5" aria-hidden="true" />
          <span>Settings</span>
        </>
      }
      footer={<p className="text-xs text-muted-foreground">Settings are saved automatically.</p>}
    >
      {/* Appearance Section */}
      <div className="flex flex-col gap-3">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          UI Theme Options
        </span>

        <Select value={theme} onValueChange={handleThemeChange}>
          <SelectTrigger className="w-full" aria-label="UI theme">
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="bottom">
            {THEME_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </DockedPanel>
  )
})
