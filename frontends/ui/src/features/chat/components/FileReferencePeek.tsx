'use client'

/**
 * What a file reference IS, before the reader commits to opening it.
 *
 * The chip's click already opens the document, so this panel is not the way in
 * — it is the answer to the question that decides whether to bother. An answer
 * recommending five documents in reading order is asking the reader to choose
 * one, and the facts that choice turns on are not in the filename: how big it
 * is, how many pages, whether Piloti has actually read it, and which shelf it
 * came from — a plan in the Büroarchiv is somebody else's project, a private
 * attachment is one this conversation alone can see.
 *
 * Every fact here is read off the document row the chip already resolved.
 * Nothing is fetched, so hovering six names in a paragraph costs six renders
 * and no requests.
 */

import type { FC } from 'react'
import { ArrowUpRight, FileWarning } from 'lucide-react'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'
import { documentDisplayName } from '@/lib/documents/display-name'
import { SectionLabel } from '@/components/ui/section-label'
import { extChipTint, fileExtensionLabel } from '@/features/documents/document-kind'
import { isCitable, isFailedStatus, isNeverIndexed } from '@/features/documents/components/document-status'
import type { StoredFile } from '@/features/documents/hooks/use-surfaced-documents'

export const FileReferencePeek: FC<{
  stored: StoredFile
  /** The name as the answer wrote it — shown only when it differs from the file's own. */
  writtenAs?: string
  onOpen: () => void
}> = ({ stored, writtenAs, onOpen }) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const { file } = stored
  const name = documentDisplayName(file)
  const ext = fileExtensionLabel(file.filename)
  const tint = extChipTint(ext)

  // The row is the truth about whether this document can answer anything. A
  // never-indexed file is still worth opening (the reader can read it); it just
  // cannot be cited, and saying so here is cheaper than the reader discovering
  // it after asking a question about it.
  const notIndexed = isNeverIndexed(file)
  const failed = isFailedStatus(file.status)

  const facts = [
    ext || null,
    file.fileSize != null ? formatBytes(file.fileSize, locale) : null,
    file.pageCount != null ? t('fileReference.pages', { count: file.pageCount }) : null,
  ].filter((fact): fact is string => Boolean(fact))

  return (
    <div className="flex flex-col gap-2" data-testid="file-reference-peek">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-px rounded px-1.5 py-0.5 text-[0.65rem] font-semibold leading-none"
          style={{ backgroundColor: tint.background, color: tint.color }}
        >
          {ext || '—'}
        </span>
        <SectionLabel className="leading-tight">{t(`fileReference.shelf.${stored.corpus}`)}</SectionLabel>
      </div>

      <div>
        <p className="text-sm font-medium leading-snug text-foreground">{name}</p>
        {/* Only when the answer spelled it differently from the file's own name
            — a rename, or a different case. Printing the filename under a name
            that IS the filename would be the same string twice. */}
        {name !== file.filename && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={file.filename}>
            {file.filename}
          </p>
        )}
        {writtenAs && writtenAs !== file.filename && writtenAs !== name && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground/80">
            {t('fileReference.writtenAs', { name: writtenAs })}
          </p>
        )}
      </div>

      {facts.length > 0 && (
        <p className="text-xs tabular-nums text-muted-foreground">{facts.join(' · ')}</p>
      )}

      {file.summary && (
        <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{file.summary}</p>
      )}

      {(failed || notIndexed) && (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <FileWarning className="mt-px size-3.5 shrink-0" aria-hidden />
          {failed ? t('fileReference.failed') : t('fileReference.notIndexed')}
        </p>
      )}

      {/* The chip's own click already opens the document; this is the control
          for a reader who reached the panel by keyboard or by pinning it, and
          it does exactly the same thing rather than a lesser version of it —
          including the half of it the label has to carry: opening a document
          the agent can read also points the next question at it, and a document
          it cannot read only opens. The line above has just said which of the
          two this file is, so the button agrees with it rather than restating
          it. */}
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1 self-start text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {t(isCitable(file) ? 'fileReference.openAsk' : 'fileReference.open')}
        <ArrowUpRight className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}
