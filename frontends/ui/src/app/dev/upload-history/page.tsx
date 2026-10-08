'use client'

/**
 * Dev preview for a project's upload history (ADR-0083, ticket
 * „Verlauf/Protokoll"), the section in project Settings. Renders the REAL
 * component, loaded through the module-scope fetch shim below:
 *
 *  - a project with three uploads: two of the reader's own (they link to their
 *    summary) and a colleague's (no link, no name);
 *  - a project with none yet (the empty state);
 *  - a project whose history fails to load (the retry).
 *
 * Not linked from anywhere; `src/app/dev/layout.tsx` 404s it outside development.
 */

import type { JSX } from 'react'
import { UploadHistory } from '@/features/uploads/components/upload-history'
import { FIXTURE_PROJECT_ID, FIXTURE_USER_ID, HISTORY } from '../_fixtures/upload-batches'

const EMPTY_PROJECT_ID = 'proj-empty'
const BROKEN_PROJECT_ID = 'proj-broken'

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __uploadHistoryShim?: boolean }
  if (!w.__uploadHistoryShim) {
    w.__uploadHistoryShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === `/api/projects/${FIXTURE_PROJECT_ID}/uploads`) return Response.json({ uploads: HISTORY })
      if (url === `/api/projects/${EMPTY_PROJECT_ID}/uploads`) return Response.json({ uploads: [] })
      if (url === `/api/projects/${BROKEN_PROJECT_ID}/uploads`) {
        return Response.json({ error: { message: 'Internal error' } }, { status: 500 })
      }
      return real(input, init)
    }
  }
}

function Frame({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <p className="text-muted-foreground text-xs">{caption}</p>
      <div className="space-y-1">
        <h2 className="text-foreground text-sm font-semibold">Uploads</h2>
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
          Wer wann wie viele Dateien hochgeladen hat. Die Übersicht Datei für Datei sieht jede Person nur für ihre
          eigenen Uploads.
        </p>
      </div>
      {children}
    </section>
  )
}

export default function UploadHistoryDevPage(): JSX.Element {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-8 md:px-8" data-testid="upload-history-preview">
      <div>
        <h1 className="text-lg font-semibold">Projekt-Einstellungen — Uploads</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          The project&apos;s upload history (ADR-0083). Own uploads link to their summary.
        </p>
      </div>
      <Frame caption="Three uploads: two of yours, one of a colleague's">
        <UploadHistory projectId={FIXTURE_PROJECT_ID} currentUserId={FIXTURE_USER_ID} />
      </Frame>
      <Frame caption="No uploads yet">
        <UploadHistory projectId={EMPTY_PROJECT_ID} currentUserId={FIXTURE_USER_ID} />
      </Frame>
      <Frame caption="Could not load">
        <UploadHistory projectId={BROKEN_PROJECT_ID} currentUserId={FIXTURE_USER_ID} />
      </Frame>
    </main>
  )
}
