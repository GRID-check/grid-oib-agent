'use client'

/**
 * Renaming a document.
 *
 * ## What is being edited, and what is not
 *
 * The field holds the STEM. The extension sits beside it as text, because it is
 * a fact about the bytes rather than a part of the name a person chose — the
 * same reason Finder and Explorer preselect only the stem when you press F2.
 * Showing it (rather than hiding it, or letting it be edited into a lie) is
 * Nielsen's visibility heuristic applied to the one detail people get wrong:
 * nobody has to wonder whether they just turned a PDF into something else.
 *
 * The file itself does not move. `filename` addresses the stored object and
 * every chunk the retrieval index holds for the document, so a rename writes a
 * display name and leaves the identity alone — which is why it is instant, and
 * why it can be undone by renaming again. The description says so in one line,
 * where the person deciding can read it.
 *
 * ## Recovery, not just prevention
 *
 * A document that has been renamed offers "restore original name" in the same
 * dialog. Renaming is reversible by construction and the control makes that
 * visible, which is the difference between a system a person will try things in
 * and one they will not touch.
 *
 * Errors are refused BEFORE the request and explained in place, next to the
 * field, in the sentence that says which rule was broken — never as a toast
 * after a round trip. The rules come from `@/lib/documents/display-name`, the
 * same module the server validates with.
 */

import { useEffect, useState, type FormEvent } from 'react'
import { useTranslations } from '@/i18n'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  composeDocumentName,
  documentDisplayName,
  splitDocumentName,
  validateDocumentName,
  type DocumentNameError,
} from '@/lib/documents/display-name'
import type { ActionableDocument, DocumentScope } from './use-document-actions'

export interface RenameDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: ActionableDocument
  /** Which namespace holds the words ('files' or 'archiv'). */
  scope: DocumentScope
  /** `null` restores the file's own name. Resolves once the request settles. */
  onRename: (displayName: string | null) => Promise<boolean>
  /** In-flight flag from `useDocumentActions` — drives the pending state. */
  pending?: boolean
}

export function RenameDocumentDialog({
  open,
  onOpenChange,
  document,
  scope,
  onRename,
  pending = false,
}: RenameDocumentDialogProps) {
  const t = useTranslations(scope)
  const currentName = documentDisplayName(document)
  const { stem, extension } = splitDocumentName(currentName)
  const [value, setValue] = useState(stem)
  const [error, setError] = useState<DocumentNameError | null>(null)

  // Re-seed whenever the dialog opens, or the document under it changes. The
  // dialog is mounted by surfaces that reuse it across documents (the preview
  // pane switches files without unmounting), so a stale stem is a real state,
  // not a theoretical one.
  useEffect(() => {
    if (!open) return
    setValue(stem)
    setError(null)
    // `stem` is derived from the document's current name; re-seeding on it would
    // also fight a user's typing after an optimistic parent update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, document.id])

  const nextName = composeDocumentName(value, currentName)
  const unchanged = nextName === currentName
  const isRenamed = currentName !== document.filename

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    const validated = validateDocumentName(nextName)
    if (!validated.ok) {
      setError(validated.reason)
      return
    }
    if (unchanged) {
      onOpenChange(false)
      return
    }
    if (await onRename(validated.value)) onOpenChange(false)
  }

  const handleRestore = async () => {
    if (pending) return
    if (await onRename(null)) onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Never close mid-flight: the same rule the shared ConfirmDialog applies.
        if (pending) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="text-base leading-snug">{t('rename.title')}</DialogTitle>
            <DialogDescription>{t('rename.description')}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-1.5">
            <Label htmlFor="document-rename-input">{t('rename.label')}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="document-rename-input"
                value={value}
                onChange={(event) => {
                  setValue(event.target.value)
                  setError(null)
                }}
                // The stem, selected. Opening straight into "type the new name"
                // is the whole interaction; making someone clear the field first
                // is the part every renaming UI that gets this wrong shares.
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                disabled={pending}
                aria-invalid={error !== null}
                aria-describedby={error ? 'document-rename-error' : 'document-rename-hint'}
                className="flex-1"
              />
              {extension !== '' && (
                <span
                  className="shrink-0 rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground"
                  data-testid="rename-extension"
                >
                  {extension}
                </span>
              )}
            </div>
            <p
              id={error ? 'document-rename-error' : 'document-rename-hint'}
              className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
              role={error ? 'alert' : undefined}
            >
              {error ? t(`rename.errors.${error}`) : t('rename.hint')}
            </p>
          </div>

          <DialogFooter className="mt-5">
            {/* Recovery sits with the other controls rather than in a menu one
                level up: the person who wants the original name back is already
                looking at the field that took it away. */}
            {isRenamed && (
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                onClick={() => void handleRestore()}
                disabled={pending}
              >
                {t('rename.restore')}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('rename.cancel')}
            </Button>
            <Button type="submit" disabled={pending || value.trim() === ''} data-testid="rename-submit">
              {pending ? t('rename.saving') : t('rename.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
