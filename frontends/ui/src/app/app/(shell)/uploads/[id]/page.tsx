/**
 * One upload's summary, the hard-load arrival (ADR-0086). An inbox row's
 * soft navigation never reaches this page: `(shell)/@overlay/(.)uploads/[id]`
 * opens the same dialog above whatever page the reader was on. This page
 * serves a pasted or reloaded link, where the dialog stands alone and closing
 * it lands where the upload went.
 *
 * The session is required here so a signed-out reader is sent to sign in
 * rather than shown a summary that answers 401. Whose summary it is, the
 * endpoint decides (`getUploadSummary`, the uploader only).
 */

import type { JSX } from 'react'
import { type Metadata } from 'next'
import { withPageSession } from '@/lib/auth/require-auth'
import { getTranslations } from '@/i18n/server'
import { UploadSummaryDialog } from '@/features/uploads/components/upload-summary'

interface UploadSummaryPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('uploadBatches')
  return { title: t('summary.title') }
}

export default async function UploadSummaryPage({ params }: UploadSummaryPageProps): Promise<JSX.Element> {
  return withPageSession(async () => {
    const { id } = await params
    return <UploadSummaryDialog batchId={id} standalone />
  })
}
