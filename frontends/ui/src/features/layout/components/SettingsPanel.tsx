/**
 * SettingsPanel Component
 *
 * Right-side docked panel for application settings: appearance (theme) and
 * interface language. Both preferences persist against the signed-in user.
 */

'use client'

import { type FC, memo, useCallback } from 'react'
import Link from 'next/link'
import { Settings } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslations, useLocale, locales, type Locale } from '@/i18n'
import { useLayoutStore } from '../store'
import type { ThemeMode } from '../types'
import { DockedPanel } from './DockedPanel'

const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark']

/**
 * Settings panel for application preferences.
 * Opens from the right side of the screen.
 */
export const SettingsPanel: FC = memo(function SettingsPanel() {
  const isOpen = useLayoutStore((s) => s.rightPanel === 'settings')
  const theme = useLayoutStore((s) => s.theme)
  const closeRightPanel = useLayoutStore((s) => s.closeRightPanel)
  const setTheme = useLayoutStore((s) => s.setTheme)
  const t = useTranslations('settings')
  const tc = useTranslations('common')
  const { locale, setLocale, localeNames } = useLocale()

  const handleThemeChange = useCallback(
    (value: string) => {
      setTheme(value as ThemeMode)
    },
    [setTheme]
  )

  const handleLocaleChange = useCallback(
    (value: string) => {
      setLocale(value as Locale)
    },
    [setLocale]
  )

  return (
    <DockedPanel
      open={isOpen}
      side="right"
      onClose={closeRightPanel}
      aria-label={t('ariaLabel')}
      heading={
        <>
          <Settings className="h-5 w-5" aria-hidden="true" />
          <span>{t('title')}</span>
        </>
      }
      footer={<p className="text-xs text-muted-foreground">{t('savedAutomatically')}</p>}
    >
      {/* Appearance Section */}
      <div className="flex flex-col gap-3">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          {t('appearance.uiTheme')}
        </span>

        <Select value={theme} onValueChange={handleThemeChange}>
          <SelectTrigger className="w-full" aria-label={t('appearance.uiThemeAria')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="bottom">
            {THEME_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {tc(`theme.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Language Section */}
      <div className="mt-6 flex flex-col gap-3">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          {t('language.heading')}
        </span>

        <Select value={locale} onValueChange={handleLocaleChange}>
          <SelectTrigger className="w-full" aria-label={t('language.ariaLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="bottom">
            {locales.map((code) => (
              <SelectItem key={code} value={code}>
                {localeNames[code]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Link to full profile */}
      <div className="mt-6">
        <Link
          href="/app/profile"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          {t('openProfile')}
        </Link>
      </div>
    </DockedPanel>
  )
})
