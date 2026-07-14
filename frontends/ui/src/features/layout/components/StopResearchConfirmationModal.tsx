/**
 * StopResearchConfirmationModal Component
 *
 * Confirmation dialog displayed before cancelling a running deep-research job.
 * Mirrors the delete-confirmation dialogs (DeleteSessionConfirmationModal):
 * a cancelled run cannot be resumed, so stopping deserves the same explicit
 * confirmation as every other destructive action in the product.
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

export interface StopResearchConfirmationModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void
  /** Callback when stopping is confirmed */
  onConfirm: () => void
}

/**
 * Dialog for confirming that a running research should be stopped.
 * Explains that the run cannot be resumed once cancelled.
 */
export const StopResearchConfirmationModal: FC<StopResearchConfirmationModalProps> = ({
  open,
  onOpenChange,
  onConfirm,
}) => {
  const t = useTranslations('research')
  const tc = useTranslations('common')

  const handleConfirm = (): void => {
    onConfirm()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" aria-hidden="true" />
            <span>{t('researchPanel.stopConfirmTitle')}</span>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm">{t('researchPanel.stopConfirmBody')}</p>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">{tc('actions.cancel')}</Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            data-testid="stop-research-confirm"
          >
            {t('researchPanel.stopConfirmConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
