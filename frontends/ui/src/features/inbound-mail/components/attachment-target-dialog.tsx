'use client'

/**
 * „Ändern“ on an attachment: its name, its Dokumentart and whether it comes
 * in as the next Fassung of a document the project already has. An edit is a
 * question, so it is a `Dialog` (a bottom sheet on a phone), and Escape or
 * the scrim discard only what was typed here; nothing reaches the draft until
 * „Übernehmen“.
 *
 * The folder is not here. It has its own place to choose from, the folder
 * picker the filing chip opens, so there is never a dialog on a dialog.
 */

import type { JSX } from 'react'
import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTranslations } from '@/i18n'
import { DOCUMENT_TYPE_TAGS, tagLabel, type DocumentTypeTag } from '@/lib/documents/tag-vocabulary'
import { INBOUND_MAIL_FILE_NAME_MAX, type InboundMailPartView } from '@/lib/inbound-mail/inbound-mail-wire'
import type { AttachmentDraft } from '../lib/draft'

const NO_TYPE = 'none'

export interface AttachmentTargetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  part: InboundMailPartView
  draft: AttachmentDraft
  onApply: (change: Pick<AttachmentDraft, 'name' | 'documentType' | 'revisionOf'>) => void
}

export function AttachmentTargetDialog({ open, onOpenChange, part, draft, onApply }: AttachmentTargetDialogProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const tFiles = useTranslations('files')
  const nameId = useId()
  const [name, setName] = useState(draft.name)
  const [documentType, setDocumentType] = useState<DocumentTypeTag | null>(draft.documentType)
  const [revisionOf, setRevisionOf] = useState<string | null>(draft.revisionOf)

  // Each opening starts from the draft as it is now.
  useEffect(() => {
    if (!open) return
    setName(draft.name)
    setDocumentType(draft.documentType)
    setRevisionOf(draft.revisionOf)
  }, [open, draft.name, draft.documentType, draft.revisionOf])

  const candidate = part.revisionCandidate
  const trimmed = name.trim()
  const changed = trimmed !== draft.name || documentType !== draft.documentType || revisionOf !== draft.revisionOf

  const apply = (): void => {
    if (trimmed === '') return
    onApply({ name: trimmed, documentType, revisionOf })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" closeLabel={t('target.cancel')} data-testid="attachment-target-dialog">
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{t('target.title', { name: part.filename ?? draft.name })}</DialogTitle>
          <DialogDescription className="sr-only">{t('target.title', { name: part.filename ?? draft.name })}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            apply()
          }}
        >
          <Field>
            <FieldLabel htmlFor={nameId}>{t('target.name')}</FieldLabel>
            <Input
              id={nameId}
              value={name}
              maxLength={INBOUND_MAIL_FILE_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              className="pointer-coarse:text-base"
              aria-invalid={trimmed === '' || undefined}
            />
          </Field>
          <Field>
            <FieldLabel>{t('target.documentType')}</FieldLabel>
            <Select
              value={documentType ?? NO_TYPE}
              onValueChange={(value) => setDocumentType(value === NO_TYPE ? null : (value as DocumentTypeTag))}
            >
              <SelectTrigger aria-label={t('target.documentType')} className="pointer-coarse:text-base">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TYPE}>{t('target.noDocumentType')}</SelectItem>
                {DOCUMENT_TYPE_TAGS.map((tag) => (
                  <SelectItem key={tag} value={tag}>
                    {tagLabel(tag, tFiles)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {candidate && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{t('target.revision')}</legend>
              <RadioGroup value={revisionOf ?? NO_TYPE} onValueChange={(value) => setRevisionOf(value === NO_TYPE ? null : value)}>
                <div className="flex items-center gap-2 pointer-coarse:min-h-11">
                  <RadioGroupItem id={`${nameId}-new`} value={NO_TYPE} />
                  <Label htmlFor={`${nameId}-new`} className="font-normal">
                    {t('target.newDocument')}
                  </Label>
                </div>
                <div className="flex items-center gap-2 pointer-coarse:min-h-11">
                  <RadioGroupItem id={`${nameId}-revision`} value={candidate.documentId} />
                  <Label htmlFor={`${nameId}-revision`} className="font-normal [overflow-wrap:anywhere]">
                    {t('target.revisionOf', { version: candidate.nextVersion, name: candidate.name })}
                  </Label>
                </div>
              </RadioGroup>
            </fieldset>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('target.cancel')}
            </Button>
            <Button type="submit" disabled={trimmed === '' || !changed} data-testid="attachment-target-apply">
              {t('target.apply')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
