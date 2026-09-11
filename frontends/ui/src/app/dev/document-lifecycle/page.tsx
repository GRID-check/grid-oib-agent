'use client'

/**
 * Dev preview for the document lifecycle — the CMS-like half of Dateien.
 *
 * Four blocks, in the order a document walks them:
 *
 *  1. The badge set: every state, in the two neutral registers. No chroma at
 *     all, on purpose — colour belongs to provenance, and an editorial state is
 *     not provenance.
 *  2. `Entwurf`: what Piloti's freshly filed report looks like, with the one
 *     control that state allows (Zur Freigabe einreichen).
 *  3. `In Prüfung` with the four decisions, and the reviewer's comment box
 *     opened — the state the screenshot exists for, because „Änderungen
 *     anfordern" without words is the flow that must not be possible.
 *  4. The same state with „Piloti überarbeiten lassen" pressed instead: the
 *     same box, the same comment requirement, plus the line saying what the
 *     third control does beyond sending the version back. It is here as its own
 *     block because the two boxes differ by exactly that one line, and a shot
 *     of only one of them cannot show it.
 *  5. `Veröffentlicht` with a version list: three versions, who submitted,
 *     approved and published each, and the comment that sent version 2 back.
 *
 * The panel takes its client as a PROP, so this page hands each block a
 * different fixture client and needs no backend and no fetch shim. Pinned to
 * German (`fixedLocale`) because the copy under review is the German copy.
 * 404s outside development.
 */

import { useEffect, useRef } from 'react'
import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { DocumentLifecyclePanel } from '@/features/documents/components/document-lifecycle-panel'
import { DocumentVersionStateBadge } from '@/features/documents/components/document-version-badge'
import type { DocumentLifecycleClient } from '@/lib/documents/lifecycle-client'
import type {
  DocumentVersionListResponse,
  DocumentVersionState,
  DocumentVersionView,
} from '@/lib/documents/lifecycle-types'
import { DOCUMENT_VERSION_STATES } from '@/lib/documents/lifecycle-types'

const REVIEWER = 'user_reviewer'
const AUTHOR = 'user_anna'

function version(
  versionNumber: number,
  state: DocumentVersionState,
  overrides: Partial<DocumentVersionView> = {},
): DocumentVersionView {
  return {
    id: `ver_${versionNumber}`,
    documentId: 'doc_1',
    versionNumber,
    state,
    contentType: 'text/markdown',
    fileSize: 18_400,
    contentHash: `sha256:${versionNumber}`,
    submittedBy: null,
    submittedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    approvedBy: null,
    approvedAt: null,
    publishedBy: null,
    publishedAt: null,
    reviewComment: null,
    createdBy: AUTHOR,
    createdAt: '2026-09-02T07:30:00.000Z',
    updatedAt: '2026-09-02T07:30:00.000Z',
    ...overrides,
  }
}

/** A client that answers from a fixture and refuses everything else. */
function fixtureClient(listing: DocumentVersionListResponse): DocumentLifecycleClient {
  const refuse = () => Promise.reject(new Error('preview'))
  return {
    listVersions: () => Promise.resolve(listing),
    getVersion: refuse,
    forkDraft: refuse,
    replaceContent: refuse,
    submit: refuse,
    approve: refuse,
    requestChanges: refuse,
    reject: refuse,
    publish: refuse,
    archive: refuse,
    diff: refuse,
  } as DocumentLifecycleClient
}

const DRAFT = fixtureClient({
  documentId: 'doc_1',
  lifecycle: 'active',
  publishedVersionId: null,
  versions: [version(1, 'draft')],
})

function inReviewFixture(documentId: string): DocumentLifecycleClient {
  return fixtureClient({
    documentId,
    lifecycle: 'active',
    publishedVersionId: null,
    versions: [
      version(1, 'in_review', {
        submittedBy: AUTHOR,
        submittedAt: '2026-09-03T10:15:00.000Z',
      }),
    ],
  })
}

const IN_REVIEW = inReviewFixture('doc_2')
const DELEGATED = inReviewFixture('doc_4')

const PUBLISHED = fixtureClient({
  documentId: 'doc_3',
  lifecycle: 'active',
  publishedVersionId: 'ver_3',
  versions: [
    version(1, 'superseded', {
      submittedBy: AUTHOR,
      submittedAt: '2026-08-11T08:00:00.000Z',
      approvedBy: REVIEWER,
      approvedAt: '2026-08-11T14:20:00.000Z',
      publishedBy: REVIEWER,
      publishedAt: '2026-08-12T07:05:00.000Z',
    }),
    version(2, 'superseded', {
      submittedBy: AUTHOR,
      submittedAt: '2026-08-24T09:40:00.000Z',
      reviewComment:
        'Die Fluchtweglänge im 2. Obergeschoss fehlt, und Tabelle 3 nennt noch die alte Gebäudeklasse.',
      approvedBy: REVIEWER,
      approvedAt: '2026-08-25T11:00:00.000Z',
      publishedBy: REVIEWER,
      publishedAt: '2026-08-25T11:30:00.000Z',
    }),
    version(3, 'published', {
      submittedBy: AUTHOR,
      submittedAt: '2026-09-01T16:10:00.000Z',
      approvedBy: REVIEWER,
      approvedAt: '2026-09-02T08:25:00.000Z',
      publishedBy: REVIEWER,
      publishedAt: '2026-09-02T08:40:00.000Z',
    }),
  ],
})

const NAMES = { [AUTHOR]: 'Anna Berger', [REVIEWER]: 'Markus Feld' }

const REVIEWER_VIEWER = {
  permissions: ['project:view', 'project:edit', 'project:documents:write'] as const,
  userId: REVIEWER,
}

export default function DocumentLifecycleDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <DocumentLifecycleFixtures />
    </I18nProvider>
  )
}

/**
 * Press one control per block, and keep pressing until that block's textarea is
 * really there.
 *
 * The harness captures a page at rest, so a state a reader has to click for is
 * driven by the preview itself — and `reactStrictMode` mounts every effect
 * twice, so a plain click would open the box and close it again. Module-scope
 * SET (a flag could not tell the two blocks apart) plus a poll that stops when
 * each block's own DOM REPORTS the state, exactly as `/dev/citation-interaction`
 * does.
 *
 * Scoped per block rather than per testid: two panels on this page are in
 * review, so `document.querySelector` alone would press the same button twice
 * and leave the second block at rest.
 */
const opened = new Set<string>()

/** Which control each block presses, by the block's own `data-preview-block`. */
const DRIVEN_BLOCKS: readonly (readonly [block: string, testId: string])[] = [
  ['in-review', 'document-lifecycle-request_changes'],
  ['delegate', 'document-lifecycle-delegate_revision'],
]

function useOpenCommentBoxes(): void {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    timer.current = setInterval(() => {
      for (const [block, testId] of DRIVEN_BLOCKS) {
        if (opened.has(block)) continue
        const scope = document.querySelector(`[data-preview-block="${block}"]`)
        if (!scope) continue
        if (scope.querySelector('[data-testid="document-review-comment"]')) {
          opened.add(block)
          continue
        }
        scope.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click()
      }
      if (opened.size === DRIVEN_BLOCKS.length && timer.current) {
        clearInterval(timer.current)
      }
    }, 120)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [])
}

function DocumentLifecycleFixtures(): JSX.Element {
  useOpenCommentBoxes()

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 p-6" data-testid="document-lifecycle-preview">
      <div>
        <h1 className="text-lg font-semibold">Freigabe und Fassungen</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Der Stand einer Datei, die Entscheidungen, die dieser Stand zulässt, und die
          Fassungsgeschichte darunter.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-muted-foreground text-sm font-medium">Zustände</h2>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border p-4">
          {DOCUMENT_VERSION_STATES.map((state) => (
            <DocumentVersionStateBadge key={state} versionState={state} always />
          ))}
          <DocumentVersionStateBadge lifecycle="archived" versionState="published" always />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-muted-foreground text-sm font-medium">Entwurf</h2>
        <div className="rounded-xl border p-4">
          <DocumentLifecyclePanel
            documentId="doc_1"
            authoredBy="agent"
            viewer={REVIEWER_VIEWER}
            names={NAMES}
            client={DRAFT}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-muted-foreground text-sm font-medium">In Prüfung</h2>
        <div className="rounded-xl border p-4" data-preview-block="in-review">
          <DocumentLifecyclePanel
            documentId="doc_2"
            authoredBy="agent"
            viewer={REVIEWER_VIEWER}
            names={NAMES}
            client={IN_REVIEW}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-muted-foreground text-sm font-medium">
          Zurückgeben — und Piloti überarbeiten lassen
        </h2>
        <div className="rounded-xl border p-4" data-preview-block="delegate">
          <DocumentLifecyclePanel
            documentId="doc_4"
            authoredBy="agent"
            viewer={REVIEWER_VIEWER}
            names={NAMES}
            client={DELEGATED}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-muted-foreground text-sm font-medium">Veröffentlicht</h2>
        <div className="rounded-xl border p-4">
          <DocumentLifecyclePanel
            documentId="doc_3"
            authoredBy="user"
            viewer={REVIEWER_VIEWER}
            names={NAMES}
            client={PUBLISHED}
          />
        </div>
      </section>
    </main>
  )
}
