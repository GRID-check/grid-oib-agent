'use client'

/**
 * The zero-data-retention part of the model card: the switch, the
 * confirmation that guards turning it off, and every state the admin must see
 * without having to go looking.
 *
 * ZDR is on unless the organization opted out. Turning it ON is instant.
 * Turning it OFF lets model providers store (and, depending on the provider,
 * train on) the organization's prompts, documents and answers, so it needs a
 * destructive confirmation with an explicit "I understand", and while it is
 * off a banner says so for as long as it stays off, not just the switch.
 *
 * With ZDR on, a task whose effective model has no ZDR endpoint is refused by
 * the provider. The server reports those (`zdrCoverage`); this section
 * summarises them and `ZdrGroupNotice` marks each affected row. A ZDR list the
 * server could not read is reported as unknown, never as all clear.
 */

import { type FC, useState } from 'react'
import { ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import type { ZdrBlockedGroup, ZdrCoverage } from '@/lib/model-config/zdr-coverage'

export type { ZdrBlockedGroup, ZdrCoverage }

export const ZdrPolicySection: FC<{
  zdrOnly: boolean
  /** False for a BYOK key on a provider other than OpenRouter: Piloti cannot enforce ZDR there. */
  zdrApplicable: boolean
  /** The BYOK provider, for the not-applicable hint. */
  provider: string | null
  coverage: ZdrCoverage | null
  /** Re-read the configuration after a toggle, so coverage and the picker follow. */
  onChanged: () => Promise<void>
}> = ({ zdrOnly, zdrApplicable, provider, coverage, onChanged }) => {
  const t = useTranslations('organization')
  const tc = useTranslations('common')
  const [saving, setSaving] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const apply = async (enabled: boolean): Promise<void> => {
    setSaving(true)
    try {
      const res = await fetch('/api/organization/model-config/zdr', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (res.status === 403) {
        toast.error(t('models.zdrErrorForbidden'))
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as { zdrOnly: boolean }
      toast.success(body.zdrOnly ? t('models.zdrEnabled') : t('models.zdrDisabled'))
      await onChanged()
    } catch {
      toast.error(t('models.zdrError'))
    } finally {
      setSaving(false)
    }
  }

  const onToggle = (enabled: boolean): void => {
    // On is strictly safer: no friction. Off is the direction that exposes data.
    if (enabled) {
      void apply(true)
      return
    }
    setAcknowledged(false)
    setDisableOpen(true)
  }

  const enforced = zdrOnly && zdrApplicable
  const blockedCount = coverage ? new Set(coverage.blockedGroups.map((entry) => entry.group)).size : 0

  return (
    <div className="flex flex-col gap-3">
      <ConfirmDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title={t('models.zdrDisableTitle')}
        description={t('models.zdrDisableDescription')}
        confirmLabel={t('models.zdrDisableConfirm')}
        cancelLabel={tc('actions.cancel')}
        tone="destructive"
        icon={ShieldOff}
        confirmDisabled={!acknowledged}
        confirmTestId="zdr-disable-confirm"
        onConfirm={() => apply(false)}
      >
        <Field orientation="horizontal" className="mt-2 justify-start gap-2">
          <Checkbox
            id="zdr-disable-acknowledge"
            checked={acknowledged}
            onCheckedChange={(checked) => setAcknowledged(checked === true)}
          />
          <FieldLabel htmlFor="zdr-disable-acknowledge" className="font-normal text-foreground">
            {t('models.zdrDisableAcknowledge')}
          </FieldLabel>
        </Field>
      </ConfirmDialog>

      <Field orientation="horizontal" className="rounded-lg border p-4">
        <div className="flex min-w-0 gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <FieldLabel htmlFor="zdr-only-toggle">{t('models.zdrTitle')}</FieldLabel>
            <FieldDescription className="mt-0.5">
              {zdrApplicable
                ? t('models.zdrHint')
                : t('models.zdrNotApplicable', { provider: provider ?? 'BYOK' })}
            </FieldDescription>
          </div>
        </div>
        <Switch
          id="zdr-only-toggle"
          // Not applicable: shown off and disabled, because it is not in effect
          // for this org's traffic. The stored choice is kept for when it is.
          checked={enforced}
          disabled={saving || !zdrApplicable}
          onCheckedChange={onToggle}
          aria-label={t('models.zdrTitle')}
        />
      </Field>

      {zdrApplicable && !zdrOnly && (
        <Alert variant="destructive" data-testid="zdr-off-banner">
          <ShieldOff />
          <AlertTitle>{t('models.zdrOffTitle')}</AlertTitle>
          <AlertDescription>{t('models.zdrOffBody')}</AlertDescription>
        </Alert>
      )}
      {enforced && coverage?.status === 'unknown' && (
        <Alert variant="warning" data-testid="zdr-coverage-unknown">
          <ShieldAlert />
          <AlertDescription>{t('models.zdrCoverageUnknown')}</AlertDescription>
        </Alert>
      )}
      {enforced && blockedCount > 0 && (
        <Alert variant="warning" data-testid="zdr-blocked-summary">
          <ShieldAlert />
          <AlertDescription>{t('models.zdrBlockedSummary', { count: blockedCount })}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/** Under one task's row: why its requests are refused while ZDR is on, or that its status is unknown. */
export const ZdrGroupNotice: FC<{ groupId: string; coverage: ZdrCoverage | null }> = ({ groupId, coverage }) => {
  const t = useTranslations('organization')
  if (!coverage) return null
  const blocked = coverage.blockedGroups.filter((entry) => entry.group === groupId)
  const unresolved = coverage.unresolvedGroups.includes(groupId)
  if (blocked.length === 0 && !unresolved) return null
  return (
    <div className="mt-1 flex flex-col gap-1" data-testid={`zdr-notice-${groupId}`}>
      {blocked.map((entry) => (
        <p key={entry.modelId} className="flex items-start gap-1.5 text-xs text-warning">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t(entry.reason === 'not_zdr' ? 'models.zdrBlockedNotZdr' : 'models.zdrBlockedCapability', {
            model: entry.modelId,
            source: t(`models.zdrSource.${entry.source}`),
          })}
        </p>
      ))}
      {unresolved && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('models.zdrUnresolved')}
        </p>
      )}
    </div>
  )
}
