'use client'

import { useId, useState, type FC, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface TypeToConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  /** The exact string the user must type (e.g. the project name). */
  confirmName: string
  /** Label of the destructive button. */
  confirmLabel: string
  /**
   * The "type X to confirm" instruction. `{name}` is replaced with the
   * emphasized confirmName. Defaults to English for back-compat.
   */
  typeToConfirmLabel?: string
  /** Label of the cancel button. Defaults to English for back-compat. */
  cancelLabel?: string
  onConfirm: () => void | Promise<void>
  /** Disables all controls while the deletion request is in flight. */
  pending?: boolean
}

export const TypeToConfirmDialog: FC<TypeToConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  confirmName,
  confirmLabel,
  typeToConfirmLabel = 'Type {name} to confirm:',
  cancelLabel = 'Cancel',
  onConfirm,
  pending = false,
}) => {
  const [value, setValue] = useState('')
  const inputId = useId()
  const matches = value === confirmName
  // Split the instruction around the {name} placeholder so the confirm name
  // can be rendered emphasized in the middle, in any language's word order.
  const [labelBefore, labelAfter] = typeToConfirmLabel.split('{name}')

  const handleOpenChange = (next: boolean) => {
    if (pending) return
    if (!next) setValue('')
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            <span>{title}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="text-sm">{description}</div>
          <Field>
            <FieldLabel htmlFor={inputId} className="font-normal">
              {labelBefore}
              <span className="font-semibold">{confirmName}</span>
              {labelAfter}
            </FieldLabel>
            <Input
              id={inputId}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={confirmName}
              autoComplete="off"
              spellCheck={false}
              // The field asks for one exact string, character for character —
              // which is precisely what a phone's autocapitalize breaks. A
              // project named "hofgasse 12" comes back as "Hofgasse 12", the
              // comparison fails, and the reader is told they typed it wrong
              // while looking at what appears to be the right name.
              // `enterKeyHint="done"` because this is the confirmation step: the
              // action key finishes the dialog.
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="done"
              disabled={pending}
            />
          </Field>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={pending}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            // `disabled` is already true until the name matches, so `pending`
            // alone produced no visible change at all — the reader clicked and
            // the dialog just sat there. `loading` is what says "it went".
            disabled={!matches}
            loading={pending}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
