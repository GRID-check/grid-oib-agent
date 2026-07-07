/**
 * DeleteSessionConfirmationModal Component
 *
 * Confirmation dialog displayed before deleting a session.
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
            <span>{t('deleteModals.session.title')}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {t('deleteModals.aboutToDelete')}{' '}
            {trimmedTitle ? (
              <span className="font-semibold">&ldquo;{trimmedTitle}&rdquo;</span>
            ) : (
              t('deleteModals.session.thisSession')
            )}
            {t('deleteModals.lossSuffix')}
          </p>
          <p className="text-sm">{t('deleteModals.cannotReverse')}</p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">{tc('actions.cancel')}</Button>
          </DialogClose>
          <Button variant="destructive" onClick={handleConfirm}>
            {t('deleteModals.session.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
