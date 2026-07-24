/**
 * DeleteAllSessionsConfirmationModal Component
 *
 * Confirmation dialog displayed before deleting all sessions. A thin wrapper
 * over the shared ConfirmDialog primitive — the confirm anatomy lives in one
 * place.
 */

'use client'

import { type FC } from 'react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranslations } from '@/i18n'

export interface DeleteAllSessionsConfirmationModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void
  /** Callback when delete is confirmed */
  onConfirm: () => void
  /** Number of sessions that will be deleted, shown in the dialog copy */
  count?: number
}

/**
 * Dialog for confirming deletion of all sessions.
 * Displays a warning message with Cancel and Delete Sessions actions.
 */
export const DeleteAllSessionsConfirmationModal: FC<DeleteAllSessionsConfirmationModalProps> = ({
  open,
  onOpenChange,
  onConfirm,
  count,
}) => {
  const t = useTranslations('research')
  const tc = useTranslations('common')

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="warning"
      title={t('deleteModals.all.title')}
      description={
        <>
          {t('deleteModals.aboutToDelete')}{' '}
          <span className="font-semibold text-foreground">
            {count && count > 0
              ? t('deleteModals.all.countSessions', { count })
              : t('deleteModals.all.allSessions')}
          </span>
          {t('deleteModals.lossSuffix')}
        </>
      }
      confirmLabel={t('deleteModals.all.confirm')}
      cancelLabel={tc('actions.cancel')}
      onConfirm={onConfirm}
    >
      {/* Scope reassurance: delete-all is project-local (UX-8). */}
      <p className="text-sm">{t('deleteModals.all.scopeNote')}</p>
      <p className="text-sm">{t('deleteModals.cannotReverse')}</p>
    </ConfirmDialog>
  )
}
