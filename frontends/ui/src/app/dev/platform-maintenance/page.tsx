'use client'

/**
 * Dev preview for the platform maintenance surface (the orphaned-vector sweep).
 *
 * Renders the REAL `VectorMaintenance` card twice — once as an operator first
 * meets it (explainer + "no sweep run yet"), once seeded with a finished run so
 * the counts table and the per-collection failure table can be reviewed and
 * screenshotted without touching the shared vector store. A module-scope fetch
 * shim (browser + dev only) answers the reconcile POST, so clicking through the
 * confirm here is safe. Not linked from anywhere and 404s outside development.
 */

import { VectorMaintenance } from '@/app/app/(shell)/platform/vector-maintenance'

const RESULT = {
  collectionsScanned: 24,
  orphansFound: 6,
  orphansDeleted: 148,
  failures: [
    { collectionName: 'org-nordbau_proj-hafenspeicher', error: 'list returned 503' },
    { collectionName: 'org-lindner_proj-schulcampus-ost', error: 'delete returned 500' },
  ],
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformMaintenanceShim?: boolean }
  if (!w.__platformMaintenanceShim) {
    w.__platformMaintenanceShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/platform/maintenance/reconcile-vectors')) {
        return Response.json(RESULT)
      }
      return real(input, init)
    }
  }
}

export default function PlatformMaintenanceDevPage(): JSX.Element {
  return (
    <main
      data-testid="platform-maintenance-preview"
      className="mx-auto flex max-w-3xl flex-col gap-6 p-8"
    >
      <div>
        <h1 className="text-lg font-semibold">Platform — Vector maintenance</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The platform’s one cross-organization destructive action: explain it, gate it behind a confirm, and
          leave the run’s counts on screen as evidence.
        </p>
      </div>
      <VectorMaintenance />
      <VectorMaintenance initialResult={RESULT} />
    </main>
  )
}
