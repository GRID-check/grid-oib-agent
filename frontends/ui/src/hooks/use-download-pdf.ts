/**
 * The report on screen, as a file on disk.
 *
 * The failure path is half of this hook's job. It used to set
 * `response.statusText` as the error the export footer prints, so a reader who
 * had waited twelve minutes for a Deep-Research-Bericht pressed „PDF" and was
 * shown „Bad Request" (#624): not German, not an explanation, and not
 * something anyone can act on. The route now names its refusals
 * (`REPORT_TOO_LONG`), and every other outcome falls back to one translated
 * sentence rather than to whatever HTTP happened to say.
 */

import { useCallback, useState } from 'react'
import { useTranslations } from '@/i18n'
import { sanitizeFilename } from '@/utils/sanitize-filename'

export const useDownloadPdfRoute = () => {
  const t = useTranslations('answerExport')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const downloadPdf = async (markdown: string, filename?: string) => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/generate-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown }),
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { code?: string } | null
        setError(
          t(body?.code === 'REPORT_TOO_LONG' ? 'pdfTooLong' : 'pdfFailed')
        )
        return
      }

      const blob = await response.blob()

      const baseName = filename
        ? sanitizeFilename(filename)
        : `report-${new Date().toISOString().slice(0, 10)}`

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${baseName}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)

      URL.revokeObjectURL(url)
    } catch (err) {
      setError(t('pdfFailed'))
      console.error('PDF download error:', err)
    } finally {
      setIsLoading(false)
    }
  }

  return {
    downloadPdf,
    isLoading,
    error,
    clearError,
  }
}
