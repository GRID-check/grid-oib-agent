'use client'

import { type FC, type ReactNode, useState } from 'react'
import { AlertTriangle, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Shared confirmation dialog. Every "are you sure?" — destructive or
 * consequential — routes through this so the confirm anatomy (tone icon, copy,
 * button order, pending handling, focus/Escape) is designed once and identical
 * everywhere, instead of being hand-rolled per feature (and drifting) or, worse,
 * falling back to the un-tokenized native `window.confirm`.
 *
 * For the higher-friction "type the name to confirm" case, use
 * `TypeToConfirmDialog` instead.
 *
 * @example
 * <ConfirmDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   title="Delete session?"
 *   description="This can't be undone."
 *   confirmLabel="Delete"
 *   cancelLabel="Cancel"
 *   onConfirm={() => deleteSession(id)}
 * />
 */
export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  confirmLabel: string
  cancelLabel: string
  /**
   * Visual + semantic tone. `destructive` (default) = red alert icon +
   * destructive button (irreversible loss); `warning` = gold alert icon +
   * destructive button (consequential but recoverable); `default` = no icon +
   * ink primary button (plain confirm).
   */
  tone?: 'destructive' | 'warning' | 'default'
  /** Override the header icon; pass `null` to force no icon. */
  icon?: LucideIcon | null
  onConfirm: () => void | Promise<void>
  /**
   * External in-flight flag. When provided it drives the disabled/pending state;
   * when omitted, an internal pending state wraps an async `onConfirm`.
   */
  pending?: boolean
  /** Extra content between the description and the footer (e.g. a warning Alert). */
  children?: ReactNode
  /** Optional test id forwarded to the confirm button. */
  confirmTestId?: string
}

export const ConfirmDialog: FC<ConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'destructive',
  icon,
  onConfirm,
  pending: pendingProp,
  children,
  confirmTestId,
}) => {
  const [internalPending, setInternalPending] = useState(false)
  const pending = pendingProp ?? internalPending

  // destructive tone uses the destructive (red) button; warning is consequential
  // but recoverable so it keeps the destructive button with a gold header icon;
  // default is a neutral ink confirm.
  const confirmVariant = tone === 'default' ? 'default' : 'destructive'
  const Icon = icon === null ? null : (icon ?? (tone === 'default' ? null : AlertTriangle))
  // The icon sits in a soft tinted disc (Linear/Apple confirm pattern) so the
  // dialog reads as a considered object, not a bare glyph + text.
  const tintClass =
    tone === 'warning'
      ? 'bg-warning-subtle text-warning'
      : 'bg-danger-subtle text-destructive'

  const handleOpenChange = (next: boolean) => {
    if (pending) return // never close mid-flight
    onOpenChange(next)
  }

  const handleConfirm = async () => {
    if (pendingProp === undefined) {
      // Manage our own pending state around an async confirm, then close on
      // success. A throwing onConfirm keeps the dialog open so the error shows.
      try {
        setInternalPending(true)
        await onConfirm()
        onOpenChange(false)
      } catch {
        // A throwing `onConfirm` means the action did not land, so the dialog
        // stays open and the caller's own error surface is what explains it.
        // Caught here rather than left to propagate: the click handler calls
        // this with `void`, so a rejection would be an unhandled one.
      } finally {
        setInternalPending(false)
      }
    } else {
      // Caller owns pending + closing (e.g. closes after a mutation settles).
      await onConfirm()
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-start gap-3.5">
            {Icon && (
              <span
                className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full', tintClass)}
                aria-hidden="true"
              >
                <Icon className="size-[18px]" />
              </span>
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
              <DialogTitle className="text-base leading-snug">{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
              {children && <div className="text-sm text-muted-foreground">{children}</div>}
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={pending}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            variant={confirmVariant}
            onClick={() => void handleConfirm()}
            disabled={pending}
            data-testid={confirmTestId}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
