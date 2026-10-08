/**
 * Platform → answer quality. One workspace with three views (ratings, citation
 * checks, runtime); see `QualityWorkspace` for why it is tabbed and why the URL
 * carries the view and the window.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`.
 */

import type { JSX } from 'react'
import { Suspense } from 'react'
import { QualityWorkspace } from '@/features/platform/components/quality-workspace'

export default function PlatformQualityPage(): JSX.Element {
  // `useSearchParams` in the workspace needs a Suspense boundary above it.
  return (
    <Suspense fallback={null}>
      <QualityWorkspace />
    </Suspense>
  )
}
