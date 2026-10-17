'use client'

import { useState, type JSX } from 'react'
import { FileDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslations } from '@/i18n'
import { startBrowserDownload } from '@/lib/browser-download'
import {
  ANNOTATION_EXPORT_FASSUNGEN,
  ANNOTATION_EXPORT_FORMATS,
  ANNOTATION_EXPORT_SCOPES,
  annotationExportHref,
  fileNameFromDisposition,
  type AnnotationExportFassung,
  type AnnotationExportFormat,
  type AnnotationExportScope,
} from '@/lib/annotations/export-request'

/** Choosing an option keeps the menu open: the choice is made before the download, not instead of it. */
const keepOpen = (event: Event) => event.preventDefault()

/**
 * „Protokoll exportieren": the Anmerkungen as a file for the Jour fixe, the
 * client or a consultant. Which marks (open, or all), which Fassung's record
 * when closed ones are wanted and the document has more than one, Piloti's
 * unreviewed proposals when there are any, then the format, which downloads.
 * What is still open is in it from every Fassung, each entry naming the one it
 * was set on: a new Index before the Jour fixe does not close the points on
 * the one before.
 *
 * Fetched rather than navigated to, as the answer export is: a refusal (a PDF
 * too long to lay out, access lost meanwhile) is a toast, not a JSON file in
 * the downloads folder.
 */
export function ReviewExportMenu({
  documentId,
  hasFassungen,
  hasProposals,
}: {
  documentId: string
  /** The document has earlier Fassungen, whose marks the export may carry too. */
  hasFassungen: boolean
  /** Piloti proposed marks nobody took over; they can be appended under their own heading. */
  hasProposals: boolean
}): JSX.Element {
  const t = useTranslations('files')
  const [scope, setScope] = useState<AnnotationExportScope>('open')
  const [fassung, setFassung] = useState<AnnotationExportFassung>('current')
  const [includeProposals, setIncludeProposals] = useState(false)
  const [busy, setBusy] = useState(false)

  const download = async (format: AnnotationExportFormat): Promise<void> => {
    setBusy(true)
    try {
      const options = {
        format,
        scope,
        fassung: hasFassungen && scope === 'all' ? fassung : 'current',
        includeProposals: hasProposals && includeProposals,
      } as const
      const response = await fetch(annotationExportHref(documentId, options))
      if (!response.ok) {
        toast.error(response.status === 422 && format === 'pdf' ? t('review.export.tooLongForPdf') : t('review.export.failed'))
        return
      }
      const url = URL.createObjectURL(await response.blob())
      try {
        startBrowserDownload(url, fileNameFromDisposition(response.headers.get('content-disposition'), `protokoll.${format}`))
      } finally {
        // The download holds the blob by reference; the URL can go on the next tick.
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch {
      toast.error(t('review.export.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" disabled={busy} data-testid="review-export">
          <FileDown className="size-3.5" aria-hidden />
          {t('review.export.button')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60" data-testid="review-export-menu">
        <DropdownMenuLabel>{t('review.export.scopeLabel')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={scope} onValueChange={(value) => setScope(value as AnnotationExportScope)}>
          {ANNOTATION_EXPORT_SCOPES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} onSelect={keepOpen} data-testid={`review-export-scope-${option}`}>
              {t(`review.export.scopes.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {/* Only for the record: open marks come from every Fassung whatever is
            chosen here (`selectMarks`), so with „Nur offene" the choice
            would change nothing and is not offered. */}
        {hasFassungen && scope === 'all' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('review.export.fassungLabel')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={fassung} onValueChange={(value) => setFassung(value as AnnotationExportFassung)}>
              {ANNOTATION_EXPORT_FASSUNGEN.map((option) => (
                <DropdownMenuRadioItem
                  key={option}
                  value={option}
                  onSelect={keepOpen}
                  data-testid={`review-export-fassung-${option}`}
                >
                  {t(`review.export.fassungen.${option}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {hasProposals && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={includeProposals}
              onCheckedChange={(checked) => setIncludeProposals(checked === true)}
              onSelect={keepOpen}
              data-testid="review-export-proposals"
            >
              {t('review.export.includeProposals')}
            </DropdownMenuCheckboxItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('review.export.formatLabel')}</DropdownMenuLabel>
        {ANNOTATION_EXPORT_FORMATS.map((format) => (
          // Inset to the radio items' text: one column of words down the menu.
          <DropdownMenuItem key={format} inset onSelect={() => void download(format)} data-testid={`review-export-${format}`}>
            {t(`review.export.formats.${format}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
