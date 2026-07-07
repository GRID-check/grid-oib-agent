'use client'

/**
 * Interactive profile controls: appearance (theme), interface language, and
 * session/security actions. The surrounding account card is server-rendered;
 * these controls need client state (the layout store, the i18n context, and
 * the auth adapter), so they live in their own client island.
 */

import { type FC, useCallback } from 'react'
import { Monitor, Moon, Sun, Globe, Palette, ShieldCheck, LogOut } from 'lucide-react'

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAuth } from '@/adapters/auth/use-auth'
import { useLayoutStore } from '@/features/layout/store'
import type { ThemeMode } from '@/features/layout/types'
import { useTranslations, useLocale, locales, type Locale } from '@/i18n'
import { AccountWidgets } from './account-widgets'

const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark']
const THEME_ICONS: Record<ThemeMode, FC<{ className?: string }>> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

interface ProfileControlsProps {
  authRequired: boolean
  email?: string | null
}

export const ProfileControls: FC<ProfileControlsProps> = ({ authRequired, email }) => {
  const t = useTranslations('profile')
  const tc = useTranslations('common')
  const theme = useLayoutStore((s) => s.theme)
  const setTheme = useLayoutStore((s) => s.setTheme)
  const { locale, setLocale, localeNames } = useLocale()
  const { signOut } = useAuth()

  const handleTheme = useCallback((value: string) => setTheme(value as ThemeMode), [setTheme])
  const handleLocale = useCallback((value: string) => setLocale(value as Locale), [setLocale])

  return (
    <>
      {/* Appearance */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette className="size-4 text-muted-foreground" aria-hidden />
            {t('appearance.title')}
          </CardTitle>
          <CardDescription>{t('appearance.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <label className="mb-2 block text-sm font-medium">{t('appearance.theme')}</label>
          <Select value={theme} onValueChange={handleTheme}>
            <SelectTrigger className="w-full sm:w-72" aria-label={t('appearance.theme')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_MODES.map((mode) => {
                const Icon = THEME_ICONS[mode]
                return (
                  <SelectItem key={mode} value={mode}>
                    <span className="flex items-center gap-2">
                      <Icon className="size-4 text-muted-foreground" aria-hidden />
                      {tc(`theme.${mode}`)}
                    </span>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Language */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" aria-hidden />
            {t('language.title')}
          </CardTitle>
          <CardDescription>{t('language.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <label className="mb-2 block text-sm font-medium">{t('language.label')}</label>
          <Select value={locale} onValueChange={handleLocale}>
            <SelectTrigger className="w-full sm:w-72" aria-label={t('language.label')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {locales.map((code) => (
                <SelectItem key={code} value={code}>
                  {localeNames[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Security & sessions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
            {t('security.title')}
          </CardTitle>
          <CardDescription>{t('security.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {authRequired ? (
            <>
              <div className="flex items-center justify-between rounded-lg border border-border bg-surface-sunken px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t('security.currentSession')}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {email ? t('security.signedInAs', { email }) : t('security.thisDevice')}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  {t('security.thisDevice')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{t('security.managedByWorkos')}</p>
              <div>
                <Button variant="outline" onClick={() => signOut()} className="gap-2">
                  <LogOut className="size-4" aria-hidden />
                  {t('security.signOutEverywhere')}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('security.unavailable')}</p>
          )}
        </CardContent>
      </Card>

      {/* Live WorkOS session + security widgets */}
      {authRequired && <AccountWidgets />}
    </>
  )
}
