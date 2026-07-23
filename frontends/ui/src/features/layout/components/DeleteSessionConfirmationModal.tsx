/**
 * DeleteSessionConfirmationModal Component
 *
 * Confirmation dialog displayed before deleting a session. A thin wrapper over
 * the shared ConfirmDialog primitive — the confirm anatomy lives in one place.
 */

'use client'

import { type FC } from 'react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranslations } from '@/i18n'

export interface DeleteSessionConfirmationModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void
  /** Callback when delete is confirmed */
  onConfirm: () => void
  /** Title of the session being deleted, shown in the dialog copy */
  sessionTitle?: string
}

/**
 * Dialog for confirming session deletion.
 * Displays a warning message with Cancel and Delete Session actions.
 */
export const DeleteSessionConfirmationModal: FC<DeleteSessionConfirmationModalProps> = ({
  open,
  onOpenChange,
  onConfirm,
  sessionTitle,
}) => {
  const t = useTranslations('research')
  const tc = useTranslations('common')
  const trimmedTitle = sessionTitle?.trim()

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="warning"
      title={t('deleteModals.session.title')}
      description={
        <>
          {t('deleteModals.aboutToDelete')}{' '}
          {trimmedTitle ? (
            <span className="font-semibold text-foreground">&ldquo;{trimmedTitle}&rdquo;</span>
          ) : (
            t('deleteModals.session.thisSession')
          )}
          {t('deleteModals.lossSuffix')}
        </>
      }
      confirmLabel={t('deleteModals.session.confirm')}
      cancelLabel={tc('actions.cancel')}
      onConfirm={onConfirm}
    >
      <p className="text-sm">{t('deleteModals.cannotReverse')}</p>
    </ConfirmDialog>
  )
}
