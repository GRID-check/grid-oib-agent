/**
 * One upload's summary, intercepted: the inbox's `upload.completed` row links
 * to `/app/uploads/<id>`, and a soft navigation renders the dialog here, above
 * the page the reader was on, with the summary's own URL. Closing goes back,
 * to the Postfach when that is where the click came from. A hard load takes
 * the real page instead (`../../../uploads/[id]`).
 */

import type { JSX } from 'react'
import { UploadSummaryDialog } from '@/features/uploads/components/upload-summary'

interface UploadSummaryOverlayPageProps {
  params: Promise<{ id: string }>
}

export default async function UploadSummaryOverlayPage({ params }: UploadSummaryOverlayPageProps): Promise<JSX.Element> {
  const { id } = await params
  return <UploadSummaryDialog batchId={id} standalone={false} />
}
