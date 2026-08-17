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
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
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
  // The saved baseline — Save stays disabled until a field actually differs, and
  // resets here after a successful save so the button re-disables (no needless
  // PUT + false "saved" toast when nothing changed).
  const [baseline, setBaseline] = useState({
    displayName: (initialDisplayName ?? '').trim(),
    defaultLocale: initialDefaultLocale,
    webSearchEnabled: initialWebSearchEnabled,
  })

  const isDirty =
    displayName.trim() !== baseline.displayName ||
    defaultLocaleValue !== baseline.defaultLocale ||
    webSearchEnabled !== baseline.webSearchEnabled

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
      setBaseline({ displayName: displayName.trim(), defaultLocale: defaultLocaleValue, webSearchEnabled })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveError'))
    } finally {
      setSaving(false)
    }
  }, [displayName, defaultLocaleValue, webSearchEnabled, t])

  return (
    <FieldGroup>
      <Field className="sm:max-w-md">
        <FieldLabel htmlFor="org-display-name">{t('settings.displayName')}</FieldLabel>
        <Input
          id="org-display-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t('settings.displayNamePlaceholder')}
        />
        <FieldDescription>{t('settings.displayNameHint')}</FieldDescription>
      </Field>

      <Field className="sm:max-w-md">
        <FieldLabel>{t('settings.defaultLocale')}</FieldLabel>
        <Select value={defaultLocaleValue} onValueChange={(v) => setDefaultLocaleValue(v as Locale)}>
          <SelectTrigger className="w-full" aria-label={t('settings.defaultLocale')}>
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
        <FieldDescription>{t('settings.defaultLocaleHint')}</FieldDescription>
      </Field>

      <Field orientation="horizontal" className="sm:max-w-md">
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor="org-web-search">{t('settings.webSearch')}</FieldLabel>
          <FieldDescription>{t('settings.webSearchHint')}</FieldDescription>
        </div>
        <Switch
          id="org-web-search"
          checked={webSearchEnabled}
          onCheckedChange={setWebSearchEnabled}
          aria-label={t('settings.webSearch')}
        />
      </Field>

      <div>
        <Button onClick={handleSave} disabled={saving || !isDirty}>
          {saving ? t('settings.saving') : t('settings.save')}
        </Button>
      </div>
    </FieldGroup>
  )
}
