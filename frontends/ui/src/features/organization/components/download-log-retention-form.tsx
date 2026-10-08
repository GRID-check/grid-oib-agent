'use client'

/**
 * How long the download log keeps its entries, in the organization settings
 * (ADR-0088). Whole days from 30 to 365: 365 is the default and the ceiling, so
 * an organization can only shorten it. The server holds the same bounds; this
 * form only spares a round trip for a number it would refuse.
 */

import { type FC, useState } from 'react'
import { toast } from 'sonner'

import { saveDownloadLogRetention } from '@/adapters/api/download-log-client'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useTranslations } from '@/i18n'
import {
  DOWNLOAD_LOG_MAX_RETENTION_DAYS,
  DOWNLOAD_LOG_MIN_RETENTION_DAYS,
  isValidRetentionDays,
} from '@/lib/download-log/kinds'

interface DownloadLogRetentionFormProps {
  initialDays: number
}

export const DownloadLogRetentionForm: FC<DownloadLogRetentionFormProps> = ({ initialDays }) => {
  const t = useTranslations('organization')
  const [text, setText] = useState(String(initialDays))
  const [saved, setSaved] = useState(initialDays)
  const [saving, setSaving] = useState(false)

  const days = Number(text)
  const valid = text.trim() !== '' && isValidRetentionDays(days)
  const dirty = valid && days !== saved

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await saveDownloadLogRetention(days)
      setSaved(result.days)
      toast.success(t('downloadLog.retentionCard.saved'))
    } catch {
      toast.error(t('downloadLog.retentionCard.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3 sm:max-w-md"
      onSubmit={(event) => {
        event.preventDefault()
        if (dirty) void save()
      }}
    >
      <Field>
        <FieldLabel htmlFor="download-log-retention">{t('downloadLog.retentionCard.label')}</FieldLabel>
        <Input
          id="download-log-retention"
          type="number"
          inputMode="numeric"
          min={DOWNLOAD_LOG_MIN_RETENTION_DAYS}
          max={DOWNLOAD_LOG_MAX_RETENTION_DAYS}
          step={1}
          value={text}
          aria-invalid={!valid}
          onChange={(event) => setText(event.target.value)}
        />
        <FieldDescription>{t('downloadLog.retentionCard.hint')}</FieldDescription>
        {!valid && <FieldError>{t('downloadLog.retentionCard.invalid')}</FieldError>}
      </Field>
      <div>
        <Button type="submit" disabled={saving || !dirty}>
          {saving ? t('downloadLog.retentionCard.saving') : t('downloadLog.retentionCard.save')}
        </Button>
      </div>
    </form>
  )
}
