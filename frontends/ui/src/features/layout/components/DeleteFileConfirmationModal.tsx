/**
 * DeleteFileConfirmationModal Component
 *
 * Confirmation dialog displayed before deleting files.
 * Shows a warning message and requires explicit confirmation.
 */

'use client'

import { type FC } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

  const handleConfirm = () => {
    onConfirm()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" aria-hidden="true" />
            <span>{t('deleteModals.file.title')}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {t('deleteModals.aboutToDelete')}{' '}
            {trimmedName ? (
              <span className="font-semibold">&ldquo;{trimmedName}&rdquo;</span>
            ) : (
              t('deleteModals.file.thisFile')
            )}
            {t('deleteModals.file.suffix')}
          </p>
          <p className="text-sm">{t('deleteModals.cannotReverse')}</p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">{tc('actions.cancel')}</Button>
          </DialogClose>
          <Button variant="destructive" onClick={handleConfirm}>
            {t('deleteModals.file.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
