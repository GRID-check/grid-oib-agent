'use client'

/**
 * Keyboard-shortcuts preference card (profile page).
 *
 * The per-user (inner) gate of the shortcuts feature: a device-local toggle,
 * default ON, persisted in localStorage via {@link useShortcutsPreference}.
 * The card itself is only rendered when the organization-level
 * `keyboard-shortcuts` feature flag allows the feature (outer gate, enforced
 * by the server component that mounts this island).
 */

import { Keyboard } from 'lucide-react'

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useShortcutsPreference } from '@/hooks/use-shortcuts-preference'
import { useTranslations } from '@/i18n'

export function ShortcutSettings() {
  const t = useTranslations('shortcuts.preference')
  const { enabled, setEnabled } = useShortcutsPreference()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Keyboard className="size-4 text-muted-foreground" aria-hidden />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Field orientation="horizontal">
          <div className="flex min-w-0 flex-col gap-1">
            <FieldLabel htmlFor="keyboard-shortcuts-toggle">{t('label')}</FieldLabel>
            <FieldDescription>{t('hint')}</FieldDescription>
          </div>
          <Switch
            id="keyboard-shortcuts-toggle"
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t('label')}
          />
        </Field>
      </CardContent>
    </Card>
  )
}
