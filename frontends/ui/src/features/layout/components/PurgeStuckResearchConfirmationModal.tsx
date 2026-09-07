/**
 * PurgeStuckResearchConfirmationModal Component
 *
 * Confirmation dialog displayed before stopping every stuck deep-research run.
 * The bulk purge is the one history action that cancels server-side work
 * across chats (and projects) in a single press, so it gets the same explicit
 * confirmation as every other consequential action — a thin wrapper over the
 * shared ConfirmDialog primitive. Single stops reuse StopResearchConfirmationModal.
 */

'use client'

import { type FC } from 'react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranslations } from '@/i18n'

export interface PurgeStuckResearchConfirmationModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void
  /** Callback when the purge is confirmed */
  onConfirm: () => void
}

/**
 * Dialog for confirming the stuck-research purge.
 * Chats are kept — only the runs stop — and the copy says exactly that, so
 * the confirm does not read as a second delete-all.
 */
export const PurgeStuckResearchConfirmationModal: FC<PurgeStuckResearchConfirmationModalProps> = ({
  open,
  onOpenChange,
  onConfirm,
}) => {
  const t = useTranslations('research')
  const tc = useTranslations('common')

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="warning"
      title={t('sessionsPanel.purgeConfirmTitle')}
      description={t('sessionsPanel.purgeConfirmBody')}
      confirmLabel={t('sessionsPanel.purgeConfirmConfirm')}
      cancelLabel={tc('actions.cancel')}
      confirmTestId="purge-stuck-research-confirm"
      onConfirm={onConfirm}
    />
  )
}
