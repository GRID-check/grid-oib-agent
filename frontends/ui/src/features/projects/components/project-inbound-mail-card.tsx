'use client'

/**
 * „E-Mail-Eingang": the project's own mail address, on the Settings page.
 *
 * A project member mails files to it and the attachments are filed into the
 * project's „E-Mail-Eingang" folder as if that member had uploaded them. This
 * section is where the address is found, copied and, by a project manager,
 * replaced.
 *
 * Rendered only for callers who can write documents (the page decides), and
 * draws nothing when the deployment has no inbound mail domain: an address
 * nobody can use, or a notice about infrastructure the reader cannot change,
 * is noise on a page people come to for something else.
 *
 * The rules are the ones the receiving side enforces (members with write
 * access only, a verifiable sender domain, 25 MB, the body not kept), stated
 * here so a rejected mail is not the first place a sender learns them. The
 * full account, with the DKIM steps and every reason a mail bounces, is the
 * public help page it links to, the same page the bounce text names.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import {
  AlertCircle,
  ExternalLink,
  FileText,
  Paperclip,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyField, CopyFieldSkeleton } from '@/components/ui/copy-field'
import { useLocale, useTranslations } from '@/i18n'
import { mailInboxHelpUrl } from '@/lib/brand'
import { useInboundAddress } from '../lib/use-inbound-address'
import {
  SettingsRule,
  SettingsRuleList,
  SettingsSectionCard,
  SettingsSectionHeader,
} from './settings-section-atoms'

export interface ProjectInboundMailCardProps {
  projectId: string
}

export function ProjectInboundMailCard({
  projectId,
}: ProjectInboundMailCardProps): JSX.Element | null {
  const t = useTranslations('settings')
  const tCommon = useTranslations('common')
  const { locale } = useLocale()
  const { state, reload, rotate } = useInboundAddress(projectId)
  const [confirming, setConfirming] = useState(false)

  if (state.status === 'hidden') return null

  const handleRotate = async (): Promise<void> => {
    try {
      await rotate()
    } catch (error) {
      toast.error(t('project.inboundMail.rotateFailed'))
      // Rethrown so ConfirmDialog stays open: the old address still works and
      // the reader should see that nothing changed.
      throw error
    }
    toast.success(t('project.inboundMail.rotated'))
  }

  const rotateAction =
    state.status === 'ready' && state.canRotate ? (
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        <RefreshCw aria-hidden="true" />
        {t('project.inboundMail.rotate')}
      </Button>
    ) : null

  const retryAction =
    state.status === 'error' ? (
      <Button variant="outline" size="sm" onClick={reload}>
        {tCommon('actions.retry')}
      </Button>
    ) : null

  return (
    <SettingsSectionCard label={t('project.sections.inboundMail')}>
      <SettingsSectionHeader
        title={t('project.sections.inboundMail')}
        description={t('project.inboundMail.description')}
        action={rotateAction ?? retryAction}
      />

      {state.status === 'loading' && <CopyFieldSkeleton />}

      {state.status === 'error' && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t('project.inboundMail.loadFailedTitle')}</AlertTitle>
          <AlertDescription>{t('project.inboundMail.loadFailed')}</AlertDescription>
        </Alert>
      )}

      {state.status === 'ready' && (
        <CopyField
          value={state.address}
          label={t('project.inboundMail.addressLabel')}
          copyLabel={tCommon('actions.copy')}
          copiedLabel={tCommon('states.copied')}
          onCopyError={() => toast.error(tCommon('states.copyFailed'))}
        />
      )}

      <SettingsRuleList label={t('project.inboundMail.rulesLabel')}>
        <SettingsRule icon={Users}>{t('project.inboundMail.rules.members')}</SettingsRule>
        <SettingsRule icon={ShieldCheck}>{t('project.inboundMail.rules.verified')}</SettingsRule>
        <SettingsRule icon={Paperclip}>{t('project.inboundMail.rules.size')}</SettingsRule>
        <SettingsRule icon={FileText}>{t('project.inboundMail.rules.body')}</SettingsRule>
      </SettingsRuleList>

      <a
        href={mailInboxHelpUrl(locale)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground duration-quick hover:text-foreground touch-target inline-flex items-center gap-1.5 text-sm transition-colors ease-out motion-reduce:transition-none"
      >
        {t('project.inboundMail.helpLink')}
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </a>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="warning"
        title={t('project.inboundMail.confirmTitle')}
        description={t('project.inboundMail.confirmDescription')}
        confirmLabel={t('project.inboundMail.confirmAction')}
        cancelLabel={tCommon('actions.cancel')}
        onConfirm={handleRotate}
      />
    </SettingsSectionCard>
  )
}
