/**
 * DeleteFileConfirmationModal Component
 *
 * Confirmation dialog displayed before deleting a file. A thin wrapper over the
 * shared ConfirmDialog primitive — the confirm anatomy lives in one place.
 */

'use client'

import { type FC } from 'react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranslations } from '@/i18n'

export interface DeleteFileConfirmationModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void
  /** Callback when delete is confirmed */
  onConfirm: () => void
  /** Name of the file being deleted, shown in the dialog copy */
  fileName?: string
}

/**
 * Dialog for confirming file deletion.
 * Displays a warning message with Cancel and Delete actions.
 */
export const DeleteFileConfirmationModal: FC<DeleteFileConfirmationModalProps> = ({
  open,
  onOpenChange,
  onConfirm,
  fileName,
}) => {
  const t = useTranslations('research')
  const tc = useTranslations('common')
  const trimmedName = fileName?.trim()

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="warning"
      title={t('deleteModals.file.title')}
      description={
        <>
          {t('deleteModals.aboutToDelete')}{' '}
          {trimmedName ? (
            <span className="font-semibold text-foreground">&ldquo;{trimmedName}&rdquo;</span>
          ) : (
            t('deleteModals.file.thisFile')
          )}
          {t('deleteModals.file.suffix')}
        </>
      }
      confirmLabel={t('deleteModals.file.confirm')}
      cancelLabel={tc('actions.cancel')}
      onConfirm={onConfirm}
    >
      <p className="text-sm">{t('deleteModals.cannotReverse')}</p>
    </ConfirmDialog>
  )
}
