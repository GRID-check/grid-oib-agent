'use client'

/**
 * One file of an upload, as its summary shows it: the name (a link into the
 * project's Files view, opened on it), the status badge the Files view shows,
 * the detected document type and the other tags, the summary Piloti wrote, and
 * whatever the reader has to know about how it ended: the screening's note when
 * the content was only partly checked, the reasons a file waits in quarantine
 * (and the sentence the Files view says for it), or why its reading failed.
 *
 * Every one of those sentences is the shared one: reasons through
 * `describeQuarantineReason`, failures through `IngestFailureNotice`
 * (`classifyIngestFailure` + `ingestFailureSentence`), the screening notes
 * from `files.screening.*`. A file reads the same here as in the quarantine
 * queue and the Files preview.
 */

import { useState, type JSX } from 'react'
import Link from 'next/link'
import { ShieldQuestion } from 'lucide-react'
import { toast } from 'sonner'

import type { UploadSummary, UploadSummaryDocument } from '@/adapters/api/upload-batches-client'
import { requestQuarantineRelease } from '@/adapters/api/upload-screening-client'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { ClampedText } from '@/components/ui/clamped-text'
import { Item, ItemContent, ItemDescription, ItemMedia } from '@/components/ui/item'
import { DocumentStatusBadge, fileTypeIcon } from '@/features/documents/components/document-status'
import { IngestFailureNotice } from '@/features/documents/components/ingest-failure-notice'
import { useTranslations } from '@/i18n'
import { documentTypeOf } from '@/lib/documents/tag-vocabulary'
import { describeQuarantineReason } from '@/lib/upload-screening/quarantine'
import { displayNameOf, otherTags } from '../lib/upload-summary'
import { FacetChip, useTallyLabel } from './upload-atoms'

/** Lines of a file's summary shown before it asks for the space. */
const SUMMARY_LINES = 2

/**
 * „Freigabe anfragen" (ADR-0083): the uploader asks the people who may release
 * a quarantined file to look at it. Only the uploader opens an upload summary,
 * so whoever sees the button may press it. Once sent, it says so and rests: a
 * second press would only fold into the same inbox row.
 */
function RequestReleaseButton({ documentId, name }: { documentId: string; name: string }): JSX.Element {
  const t = useTranslations('uploadBatches')
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')

  const ask = async (): Promise<void> => {
    setState('sending')
    try {
      const { notified } = await requestQuarantineRelease(documentId)
      setState('sent')
      if (notified > 0) toast.success(t('summary.files.releaseRequestedToast', { name }))
      else toast.info(t('summary.files.releaseRequestNobody', { name }))
    } catch {
      setState('idle')
      toast.error(t('summary.files.releaseRequestError'))
    }
  }

  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        disabled={state !== 'idle'}
        loading={state === 'sending'}
        onClick={() => void ask()}
        data-testid={`upload-file-request-release-${documentId}`}
      >
        <ShieldQuestion className="size-4" aria-hidden />
        {state === 'sent' ? t('summary.files.releaseRequested') : t('summary.files.requestRelease')}
      </Button>
    </div>
  )
}

export function UploadedFileRow({
  document,
  href,
  shelf,
}: {
  document: UploadSummaryDocument
  /** Where the name links; `null` renders it as text. */
  href: string | null
  /** The shelf the link opens, which its title names. */
  shelf: UploadSummary['scope']
}): JSX.Element {
  const t = useTranslations('uploadBatches')
  const tFiles = useTranslations('files')
  const tallyLabel = useTallyLabel()
  const name = displayNameOf(document)
  const Icon = fileTypeIcon(null, document.filename)
  const type = documentTypeOf(document.tags)
  const tags = otherTags(document.tags)
  const reasons = (document.quarantine?.reasons ?? []).map((reason) => describeQuarantineReason(reason, tFiles))
  const partlyChecked = document.screening === 'partial' || document.quarantine?.checked === 'partial'

  return (
    <Item as="li" className="items-start hover:bg-transparent" data-testid={`upload-file-${document.id}`}>
      <ItemMedia className="text-muted-foreground size-5 pt-0.5">
        <Icon className="size-4" aria-hidden />
      </ItemMedia>
      <ItemContent className="flex flex-col gap-1.5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          {href ? (
            <Link
              href={href}
              title={t(shelf === 'archiv' ? 'summary.files.openInArchiv' : 'summary.files.openInFiles')}
              className="text-foreground focus-visible:ring-ring/50 min-w-0 line-clamp-2 rounded-sm text-sm font-medium break-words underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
            >
              {name}
            </Link>
          ) : (
            <p className="text-foreground line-clamp-2 min-w-0 text-sm font-medium break-words" title={name}>
              {name}
            </p>
          )}
          <DocumentStatusBadge status={document.status} />
        </div>

        {(document.replaced || document.restricted || type || tags.length > 0 || document.pageCount) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {document.replaced && (
              <FacetChip facet="changed" label={tallyLabel('changed')} hint={t('summary.files.changedHint')} />
            )}
            {document.restricted && (
              <FacetChip facet="protected" label={tallyLabel('protected')} hint={t('summary.files.protectedHint')} />
            )}
            {type && (
              <Chip variant="outline" size="sm" title={tFiles('preview.indexed.documentType')}>
                {type}
              </Chip>
            )}
            {tags.length > 0 && (
              <ul className="contents" aria-label={tFiles('preview.tags')}>
                {tags.map((tag) => (
                  <li key={tag} className="contents">
                    <Chip variant="muted" size="sm">
                      {tag}
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
            {document.pageCount ? (
              <ItemDescription className="tabular-nums">
                {t('summary.files.pages', { count: document.pageCount })}
              </ItemDescription>
            ) : null}
          </div>
        )}

        {document.summary && (
          <div>
            <ClampedText
              lines={SUMMARY_LINES}
              moreLabel={tFiles('preview.summaryMore')}
              lessLabel={tFiles('preview.summaryLess')}
              className="text-muted-foreground text-sm leading-relaxed"
              testId={`upload-file-summary-${document.id}`}
            >
              {document.summary}
            </ClampedText>
          </div>
        )}

        {document.outcome === 'quarantined' && (
          <div className="flex flex-col gap-1.5" data-testid={`upload-file-quarantine-${document.id}`}>
            {reasons.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label={t('summary.files.reasonsLabel')}>
                {reasons.map((reason, index) => (
                  <li key={`${index}-${reason}`} className="max-w-full">
                    <Chip variant="warning" className="max-w-full">
                      <span className="truncate">{reason}</span>
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
            <ItemDescription className="whitespace-normal">{tFiles('ingestFailure.quarantined')}</ItemDescription>
            <RequestReleaseButton documentId={document.id} name={name} />
          </div>
        )}

        {document.outcome === 'failed' && (
          <IngestFailureNotice
            errorMessage={document.errorMessage}
            sentenceClassName="text-error"
            testId={`upload-file-failure-${document.id}`}
          />
        )}

        {partlyChecked && (
          // A sentence, not a label: it wraps instead of truncating on a phone.
          <ItemDescription className="whitespace-normal" data-testid={`upload-file-screening-${document.id}`}>
            {tFiles('screening.partial')}
          </ItemDescription>
        )}
        {document.screening === 'unchecked' && (
          <ItemDescription className="whitespace-normal" data-testid={`upload-file-screening-${document.id}`}>
            {tFiles('screening.unchecked')}
          </ItemDescription>
        )}
      </ItemContent>
    </Item>
  )
}
