'use client'

/**
 * Dev preview for the upload summary (ADR-0079): what an inbox row's
 * `upload.completed` opens. Renders the REAL components with fixtures:
 *
 *  - the mixed batch, still reading one file, laid out inline so a full-page
 *    capture shows all of it: every count, the document types, the excluded
 *    terms, three folder groups, and a file per outcome and screening note;
 *  - the same batch once settled;
 *  - the loading, not-found and error states;
 *  - `?dialog=1` opens the real route dialog over the page, fed by the
 *    module-scope fetch shim below (the summary and the project's name).
 *
 * Not linked from anywhere; `src/app/dev/layout.tsx` 404s it outside development.
 */

import type { JSX } from 'react'
import { Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

import { Button } from '@/components/ui/button'
import {
  UploadSummaryBody,
  UploadSummaryDialog,
  UploadSummaryMeta,
} from '@/features/uploads/components/upload-summary'
import { FIXTURE_PROJECT_ID, FIXTURE_PROJECT_NAME, MIXED_SUMMARY, SETTLED_SUMMARY } from '../_fixtures/upload-batches'

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __uploadSummaryShim?: boolean }
  if (!w.__uploadSummaryShim) {
    w.__uploadSummaryShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/upload-batches/')) {
        const id = decodeURIComponent(url.slice('/api/upload-batches/'.length))
        if (id === 'mixed') return Response.json(MIXED_SUMMARY)
        if (id === 'settled') return Response.json(SETTLED_SUMMARY)
        return Response.json({ error: { message: 'Upload not found' } }, { status: 404 })
      }
      if (url === `/api/projects/${FIXTURE_PROJECT_ID}`) {
        return Response.json({ id: FIXTURE_PROJECT_ID, name: FIXTURE_PROJECT_NAME })
      }
      return real(input, init)
    }
  }
}

/** The dialog's header and body, drawn in place so the capture is not clipped to the viewport. */
function InlineDialogFrame({ caption, meta, children }: { caption: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <figure className="space-y-2">
      <figcaption className="text-muted-foreground text-xs">{caption}</figcaption>
      <div className="bg-popover text-popover-foreground overflow-hidden rounded-xl border shadow-lg">
        <div className="border-b px-5 pt-5 pb-4 sm:px-6">
          <h2 className="text-lg font-semibold tracking-tight">Was angekommen ist</h2>
          {meta}
        </div>
        <div className="px-5 py-5 sm:px-6">{children}</div>
      </div>
    </figure>
  )
}

function Preview(): JSX.Element {
  const params = useSearchParams()
  const dialog = params?.get('dialog')
  const noop = () => undefined

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-8" data-testid="upload-summary-preview">
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">Upload-Übersicht</h1>
        <p className="text-muted-foreground text-sm">
          Opened from the inbox row „Ihr Upload ist gelesen“ (ADR-0079). Inline below; the real route dialog with{' '}
          <code>?dialog=1</code>.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/dev/upload-summary?dialog=1">Als Dialog öffnen</Link>
        </Button>
      </div>

      <InlineDialogFrame
        caption="Mixed batch, one file still being read (polls every 10 s)"
        meta={<UploadSummaryMeta summary={MIXED_SUMMARY} projectName={FIXTURE_PROJECT_NAME} />}
      >
        <UploadSummaryBody state={{ status: 'ready', summary: MIXED_SUMMARY }} retry={noop} />
      </InlineDialogFrame>

      <InlineDialogFrame
        caption="Settled"
        meta={<UploadSummaryMeta summary={SETTLED_SUMMARY} projectName={FIXTURE_PROJECT_NAME} />}
      >
        <UploadSummaryBody state={{ status: 'ready', summary: SETTLED_SUMMARY }} retry={noop} />
      </InlineDialogFrame>

      <InlineDialogFrame caption="Loading">
        <UploadSummaryBody state={{ status: 'loading' }} retry={noop} />
      </InlineDialogFrame>

      <InlineDialogFrame caption="Gone, or someone else's (404)">
        <UploadSummaryBody state={{ status: 'not-found' }} retry={noop} />
      </InlineDialogFrame>

      <InlineDialogFrame caption="Could not load">
        <UploadSummaryBody state={{ status: 'error' }} retry={noop} />
      </InlineDialogFrame>

      {dialog && <UploadSummaryDialog batchId={dialog === 'settled' ? 'settled' : 'mixed'} standalone />}
    </main>
  )
}

export default function UploadSummaryDevPage(): JSX.Element {
  return (
    <Suspense>
      <Preview />
    </Suspense>
  )
}
