'use client'

/**
 * One base-corpus document, in a side sheet: what it is, where it stands, and
 * (for a platform admin) the edits that used to sit on every table row.
 *
 * The sheet is a detail view, so it holds the file the caller resolves from
 * the live list on every render: an optimistic edit or a poll shows up here
 * instead of freezing a stale copy. Only the rename draft is local, and it
 * resets when a different document opens.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { Eye, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SectionLabel } from '@/components/ui/section-label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  DocClassChip,
  KnowledgeStateBadge,
  useDocClassLabel,
} from '@/features/platform/components/knowledge-atoms'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'
import {
  DOC_CLASSES,
  isOibBinding,
  resolveDocClass,
  suggestedDocClass,
  type DocClass,
} from '@/lib/knowledge/doc-class'
import type { KnowledgeFile } from '@/lib/knowledge/service'

export interface KnowledgeDocumentSheetProps {
  file: KnowledgeFile | null
  onClose: () => void
  /** Rename, reclassify and remove render only when true. */
  canManage: boolean
  onRename: (file: KnowledgeFile, title: string) => void
  onReclassify: (file: KnowledgeFile, next: DocClass) => void
  onView: (file: KnowledgeFile) => void
  onDelete: (file: KnowledgeFile) => void
}

export function KnowledgeDocumentSheet({
  file,
  onClose,
  ...rest
}: KnowledgeDocumentSheetProps): JSX.Element {
  const t = useTranslations('platform')
  return (
    <Sheet open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        closeLabel={t('knowledgeAdmin.detailClose')}
        data-testid="knowledge-detail"
        className="sm:max-w-md"
      >
        {/* Keyed so the rename draft starts from the opened document's name. */}
        {file ? <SheetBody key={file.fileName} file={file} {...rest} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function SheetBody({
  file,
  canManage,
  onRename,
  onReclassify,
  onView,
  onDelete,
}: Omit<KnowledgeDocumentSheetProps, 'file' | 'onClose'> & { file: KnowledgeFile }): JSX.Element {
  const t = useTranslations('platform')
  const tk = useTranslations('knowledge')
  const { locale } = useLocale()
  const label = useDocClassLabel()
  const [titleDraft, setTitleDraft] = useState(file.displayTitle ?? '')
  const suggestion = suggestedDocClass(file)
  const current = resolveDocClass(file.docClass)

  return (
    <>
      <SheetHeader>
        <SheetTitle className="text-balance leading-snug">
          {file.displayTitle ?? file.fileName}
        </SheetTitle>
        <SheetDescription className="break-all font-mono text-xs">{file.fileName}</SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <KnowledgeStateBadge state={file.state} />
          <DocClassChip docClass={file.docClass} />
          {isOibBinding(file.docClass) ? (
            <Badge variant="outline">{t('knowledgeAdmin.binding')}</Badge>
          ) : null}
        </div>
        {/* The state hint, visible: in the table it is only a hover. */}
        <p
          className="text-muted-foreground text-pretty text-sm"
          data-testid="knowledge-detail-state-hint"
        >
          {tk(`stateHints.${file.state}`)}
        </p>
      </div>

      {canManage ? (
        <>
          <Separator />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="knowledge-display-title">
                {t('knowledgeAdmin.detailDisplayTitle')}
              </FieldLabel>
              <div className="flex items-center gap-1.5">
                <Input
                  id="knowledge-display-title"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onRename(file, titleDraft)
                  }}
                  aria-label={t('knowledge.displayTitleFor', { name: file.fileName })}
                  placeholder={t('knowledge.displayTitlePlaceholder')}
                />
                <Button variant="outline" onClick={() => onRename(file, titleDraft)}>
                  {t('knowledge.displayTitleSave')}
                </Button>
              </div>
            </Field>

            <Field>
              <FieldLabel htmlFor="knowledge-doc-class">{t('knowledge.docClassLabel')}</FieldLabel>
              <Select
                value={current}
                onValueChange={(value) => onReclassify(file, value as DocClass)}
              >
                <SelectTrigger
                  id="knowledge-doc-class"
                  className="w-full"
                  aria-label={t('knowledge.docClassFor', { name: file.fileName })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_CLASSES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {label(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Read from the text, offered, never applied without a click. */}
              {suggestion ? (
                <FieldDescription className="flex items-center justify-between gap-2">
                  <span>{t('knowledge.docClassSuggestion', { label: label(suggestion) })}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onReclassify(file, suggestion)}
                  >
                    {t('knowledge.docClassSuggestionAccept')}
                  </Button>
                </FieldDescription>
              ) : null}
            </Field>
          </FieldGroup>
        </>
      ) : null}

      <Separator />

      <section className="flex flex-col gap-2" aria-label={t('knowledgeAdmin.detailFacts')}>
        <SectionLabel as="h3">{t('knowledgeAdmin.detailFacts')}</SectionLabel>
        <dl className="flex flex-col gap-2 text-sm">
          <DetailRow
            label={t('knowledgeAdmin.detailChunks')}
            value={file.chunkCount > 0 ? file.chunkCount.toLocaleString(locale) : '–'}
          />
          <DetailRow
            label={t('knowledgeAdmin.detailSize')}
            value={file.sizeBytes !== null ? formatBytes(file.sizeBytes, locale) : '–'}
          />
          {file.ingestedAt ? (
            <DetailRow
              label={t('knowledgeAdmin.detailIngestedAt')}
              value={new Date(file.ingestedAt).toLocaleDateString(locale)}
            />
          ) : null}
        </dl>
      </section>

      {file.summary ? (
        <section className="flex flex-col gap-2" aria-label={t('knowledgeAdmin.detailSummary')}>
          <SectionLabel as="h3">{t('knowledgeAdmin.detailSummary')}</SectionLabel>
          <p className="text-muted-foreground text-pretty text-sm leading-relaxed">
            {file.summary}
          </p>
        </section>
      ) : null}

      <SheetFooter className="pt-2">
        {canManage ? (
          <Button
            variant="ghost"
            className="text-destructive sm:mr-auto"
            onClick={() => onDelete(file)}
          >
            <Trash2 className="size-3.5" aria-hidden />
            {t('knowledge.delete')}
          </Button>
        ) : null}
        {/* A file the corpus no longer lists has no PDF left to open. */}
        {file.state !== 'removed' ? (
          <Button variant="outline" onClick={() => onView(file)}>
            <Eye className="size-3.5" aria-hidden />
            {t('knowledge.viewPdf')}
          </Button>
        ) : null}
      </SheetFooter>
    </>
  )
}

function DetailRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground truncate tabular-nums">{value}</dd>
    </div>
  )
}
