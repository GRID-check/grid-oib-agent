'use client'

/**
 * Editable Grid-side organization settings (admin only): a display-name
 * override, the default interface language for new members, and the
 * org-level web-search toggle (ADR-0022). Persists to
 * `/api/organization/settings` (PUT), which enforces the admin check server-side.
 */

import { type FC, useState, useCallback } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useTranslations, locales, localeNames, type Locale } from '@/i18n'

interface OrgSettingsFormProps {
  initialDisplayName: string | null
  initialDefaultLocale: Locale
  initialWebSearchEnabled: boolean
}

export const OrgSettingsForm: FC<OrgSettingsFormProps> = ({
  initialDisplayName,
  initialDefaultLocale,
  initialWebSearchEnabled,
}) => {
  const t = useTranslations('organization')

  const [displayName, setDisplayName] = useState(initialDisplayName ?? '')
  const [defaultLocaleValue, setDefaultLocaleValue] = useState<Locale>(initialDefaultLocale)
  const [webSearchEnabled, setWebSearchEnabled] = useState(initialWebSearchEnabled)
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/organization/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: displayName.trim() === '' ? null : displayName.trim(),
          defaultLocale: defaultLocaleValue,
          settings: { webSearchEnabled },
        }),
      })
      if (!res.ok) throw new Error(`Save failed (${res.status})`)
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveError'))
    } finally {
      setSaving(false)
    }
  }, [displayName, defaultLocaleValue, webSearchEnabled, t])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="org-display-name">{t('settings.displayName')}</Label>
        <Input
          id="org-display-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t('settings.displayNamePlaceholder')}
          className="w-full sm:max-w-md"
        />
        <p className="text-xs text-muted-foreground">{t('settings.displayNameHint')}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t('settings.defaultLocale')}</Label>
        <Select value={defaultLocaleValue} onValueChange={(v) => setDefaultLocaleValue(v as Locale)}>
          <SelectTrigger className="w-full sm:max-w-md" aria-label={t('settings.defaultLocale')}>
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
        <p className="text-xs text-muted-foreground">{t('settings.defaultLocaleHint')}</p>
      </div>

      <div className="flex items-start justify-between gap-4 sm:max-w-md">
        <div className="flex flex-col gap-1">
          <Label htmlFor="org-web-search">{t('settings.webSearch')}</Label>
          <p className="text-xs text-muted-foreground">{t('settings.webSearchHint')}</p>
        </div>
        <Switch
          id="org-web-search"
          checked={webSearchEnabled}
          onCheckedChange={setWebSearchEnabled}
          aria-label={t('settings.webSearch')}
        />
      </div>

      <div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? t('settings.saving') : t('settings.save')}
        </Button>
      </div>
    </div>
  )
}
