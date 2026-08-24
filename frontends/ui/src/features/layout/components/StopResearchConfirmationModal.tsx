/**
 * StopResearchConfirmationModal Component
 *
 * Confirmation dialog displayed before cancelling a running deep-research job.
 * A cancelled run cannot be resumed, so stopping deserves the same explicit
 * confirmation as every other destructive action in the product — a thin
 * wrapper over the shared ConfirmDialog primitive.
 */

'use client'

import { type FC } from 'react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
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

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="warning"
      title={t('researchPanel.stopConfirmTitle')}
      description={t('researchPanel.stopConfirmBody')}
      confirmLabel={t('researchPanel.stopConfirmConfirm')}
      cancelLabel={tc('actions.cancel')}
      confirmTestId="stop-research-confirm"
      onConfirm={onConfirm}
    />
  )
}
