'use client'

/**
 * „E-Mail-Eingang" (English: "Project email address"): the project's own mail
 * address, on the Settings page.
 *
 * A project member mails files to it and the attachments are filed into the
 * project's „E-Mail-Eingang" folder, one subfolder per mail, as if that member
 * had uploaded them. This section is where the address is found, copied and,
 * by a project manager, replaced.
 *
 * Rendered only for callers who can write documents (the page decides), and
 * draws nothing when the deployment has no inbound mail domain or the
 * organization has not switched the inbox on: an address nobody can use, or a
 * notice about infrastructure the reader cannot change, is noise on a page
 * people come to for something else.
 *
 * The rules are the ones the receiving side enforces, stated here so a
 * rejected mail is not the first place a sender learns them. The full account,
 * with the DKIM steps and every reason a mail bounces, is the public help page
 * it links to; the Worker's bounce text links the same page.
 *
 * Reading order is the task order: the address and its copy button, what
 * applies, where to read more, and last the rotation, which only a manager
 * sees and nobody needs on the way to the address.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { AtSign, FileText, Paperclip, RefreshCw, ShieldCheck, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyField } from '@/components/ui/copy-field'
import { ExternalLink } from '@/components/ui/external-link'
import { IconList, IconListItem } from '@/components/ui/icon-list'
import { SectionCard } from '@/features/platform/components/section-card'
import { useLocale, useTranslations } from '@/i18n'
import { mailInboxHelpUrl } from '@/lib/brand'
import { useInboundAddress } from '../lib/use-inbound-address'

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

  const canRotate = state.status === 'ready' && state.canRotate

  return (
    <SectionCard
      variant="raised"
      title={t('project.sections.inboundMail')}
      description={t('project.inboundMail.description')}
      loading={state.status === 'loading'}
      skeletonRows={2}
      error={state.status === 'error'}
      errorMessage={t('project.inboundMail.loadFailed')}
      onRetry={reload}
      footer={
        <>
          <ExternalLink
            href={mailInboxHelpUrl(locale)}
            newTabLabel={tCommon('links.opensInNewTab')}
          >
            {t('project.inboundMail.helpLink')}
          </ExternalLink>
          {canRotate && (
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              <RefreshCw aria-hidden="true" />
              {t('project.inboundMail.rotate')}
            </Button>
          )}
        </>
      }
    >
      {state.status === 'ready' && (
        <CopyField
          value={state.address}
          label={t('project.inboundMail.addressLabel')}
          copyLabel={tCommon('actions.copy')}
          copiedLabel={tCommon('states.copied')}
          onCopyError={() => toast.error(tCommon('states.copyFailed'))}
        />
      )}

      <IconList label={t('project.inboundMail.rulesLabel')}>
        <IconListItem icon={Users}>{t('project.inboundMail.rules.members')}</IconListItem>
        <IconListItem icon={ShieldCheck}>{t('project.inboundMail.rules.verified')}</IconListItem>
        <IconListItem icon={AtSign}>{t('project.inboundMail.rules.addressing')}</IconListItem>
        <IconListItem icon={Paperclip}>{t('project.inboundMail.rules.size')}</IconListItem>
        <IconListItem icon={FileText}>{t('project.inboundMail.rules.attachmentsOnly')}</IconListItem>
      </IconList>

      {canRotate && (
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
      )}
    </SectionCard>
  )
}
