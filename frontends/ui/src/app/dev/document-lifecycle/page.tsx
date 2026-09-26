'use client'

/**
 * Dev preview for the document lifecycle — the CMS-like half of Dateien.
 *
 * Blocks, in the order a document walks them:
 *
 *  1. The badge set: every state, in the two neutral registers. No chroma at
 *     all, on purpose — colour belongs to provenance, and an editorial state is
 *     not provenance.
 *  2. AT REST. A person's upload, which is the great majority of every project:
 *     the section is SHUT, and what it says shut is the word, the track and one
 *     sentence. This block is the whole redesign in one shot — the same document
 *     used to draw an open heading, a version list and a single unexplained
 *     „Archivieren" at the top of the rail.
 *  3. `Entwurf`: what Piloti's freshly filed report looks like, with the one
 *     control that state allows (Zur Freigabe einreichen). It is OPEN without
 *     anybody having clicked, because a decision is outstanding for this reader
 *     — the auto-open rule is the half of „need to know" that the shut block
 *     above cannot show.
 *  4. `In Prüfung` with the decisions, and the reviewer's comment box
 *     opened — the state the screenshot exists for, because „Änderungen
 *     anfordern" without words is the flow that must not be possible.
 *  5. The same state with „Piloti überarbeiten lassen" pressed instead: the
 *     same box, the same comment requirement, plus the line saying what the
 *     third control does beyond sending the version back. It is here as its own
 *     block because the two boxes differ by exactly that one line, and a shot
 *     of only one of them cannot show it.
 *  6. `Veröffentlicht` OPENED: three versions, who submitted, approved and
 *     published each, the comment that sent version 2 back, and — last and set
 *     apart — the archive block with its own explanation.
 *
 * `?variant=archive` is a page of its own for the archive confirm, because a
 * dialog is a portal over the whole document and would cover every block above
 * it. It is the shot that answers the report this redesign came from: „no idea
 * what archiving does".
 *
 * The panel takes its client as a PROP, so this page hands each block a
 * different fixture client and needs no backend and no fetch shim. Pinned to
 * German (`fixedLocale`) because the copy under review is the German copy.
 * 404s outside development.
 */

import type { JSX } from 'react'
import { use, useEffect, useRef } from 'react'
import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { DocumentLifecyclePanel } from '@/features/documents/components/document-lifecycle-panel'
import { DocumentLifecycleStand } from '@/features/documents/components/document-lifecycle-stand'
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

/** The ordinary case: a person's upload, born published, nothing to decide. */
const UPLOADED = fixtureClient({
  documentId: 'doc_0',
  lifecycle: 'active',
  publishedVersionId: 'ver_1',
  versions: [version(1, 'published', { createdBy: REVIEWER })],
})

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

const NAMES: Record<string, string> = { [AUTHOR]: 'Anna Berger', [REVIEWER]: 'Markus Feld' }

/** Every state on the same track, so the two that HALT are visible as halts. */
const TRACK_STATES: readonly { state: DocumentVersionState; submittedBy?: string }[] = [
  { state: 'draft' },
  { state: 'in_review', submittedBy: AUTHOR },
  { state: 'changes_requested' },
  { state: 'approved' },
  { state: 'published' },
  { state: 'rejected' },
  { state: 'superseded' },
]

const REVIEWER_VIEWER = {
  permissions: ['project:view', 'project:edit', 'project:documents:write'] as const,
  userId: REVIEWER,
}

/**
 * `?variant=archive` gives the archive confirm a page to itself. A dialog is a
 * portal over the whole document, so photographing it beside the gallery would
 * photograph one grey sheet and the blocks dimmed behind it.
 *
 * Read off the `searchParams` prop like `/dev/file-preview` does, rather than
 * through `useSearchParams`: the hook bails the whole route out to client
 * rendering, and these pages are already the one place where that difference is
 * load-bearing for the screenshot harness.
 */
export default function DocumentLifecycleDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  const variant = use(searchParams).variant
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      {variant === 'archive' ? <ArchiveFixture /> : <DocumentLifecycleFixtures />}
    </I18nProvider>
  )
}

function ArchiveFixture(): JSX.Element {
  useDrivenBlocks()
  return (
    <main
      className="mx-auto flex max-w-3xl flex-col gap-6 p-6"
      data-testid="document-lifecycle-archive-preview"
    >
      <div>
        <h1 className="text-lg font-semibold">Stilllegen</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Der einzige Akt in diesem Abschnitt, der sich im Haus nicht zurücknehmen lässt — und
          deshalb der einzige, der vorher sagt, was er tut.
        </p>
      </div>
      <div className="rounded-xl border p-4" data-preview-block="archive">
        <DocumentLifecyclePanel
          documentId="doc_0"
          filename="Aktenvermerk Fluchtwege.pdf"
          authoredBy="user"
          viewer={REVIEWER_VIEWER}
          names={NAMES}
          client={UPLOADED}
        />
      </div>
    </main>
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

/**
 * What each block presses, and the DOM it presses until.
 *
 * A step at a time: the panel is a disclosure now, so two of these have to open
 * the section before the control they want exists. Each step is „click this
 * until that appears", and a block is done when its last step has settled —
 * which is also what keeps this honest, because a step whose control never
 * renders stops the block instead of silently photographing it at rest.
 */
type DriveStep = {
  click: string
  settled: string
  /** The result is a portal (a dialog), so it lands outside the block. */
  portal?: true
}

const DRIVEN_BLOCKS: readonly (readonly [block: string, steps: readonly DriveStep[]])[] = [
  // Already open — the round wants something from this reader — so one step.
  [
    'in-review',
    [{ click: 'document-lifecycle-request_changes', settled: 'document-review-comment' }],
  ],
  [
    'delegate',
    [{ click: 'document-lifecycle-delegate_revision', settled: 'document-review-comment' }],
  ],
  // Nothing outstanding here, so the section is shut and the shot has to open
  // it. That IS the behaviour under review: the history is behind one click.
  ['published', [{ click: 'document-lifecycle-toggle', settled: 'document-version-row' }]],
  [
    'archive',
    [
      { click: 'document-lifecycle-toggle', settled: 'document-lifecycle-archive' },
      {
        click: 'document-lifecycle-archive',
        settled: 'document-archive-consequences',
        portal: true,
      },
    ],
  ],
]

function useDrivenBlocks(): void {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    timer.current = setInterval(() => {
      for (const [block, steps] of DRIVEN_BLOCKS) {
        if (opened.has(block)) continue
        const scope = document.querySelector(`[data-preview-block="${block}"]`)
        if (!scope) continue
        // The first step whose result is not on screen yet is the one to press.
        // Scoped to the BLOCK, because two panels on this page are in review
        // and a document-wide lookup would settle one block on the other's DOM.
        // A dialog is the exception: it is a portal, so it lands at body level.
        const pending = steps.find(
          (step) =>
            !(step.portal ? document : scope).querySelector(`[data-testid="${step.settled}"]`),
        )
        if (!pending) {
          opened.add(block)
          continue
        }
        scope.querySelector<HTMLButtonElement>(`[data-testid="${pending.click}"]`)?.click()
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
  useDrivenBlocks()

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
        <h2 className="text-muted-foreground text-sm font-medium">Strecke</h2>
        <p className="text-muted-foreground max-w-prose text-xs">
          Jeder Zustand auf derselben Strecke. Farbe bekommt sie erst, wenn etwas geschehen ist:
          Ein Entwurf und eine laufende Prüfung bleiben Tinte, ab „Freigegeben“ wird die Strecke
          grün, und die beiden, die anhalten — „Änderungen erbeten“ steht wieder beim Entwurf,
          „Abgelehnt“ nach der Prüfung —, sind rot und zusätzlich gestrichelt.
        </p>
        <div className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2">
          {TRACK_STATES.map(({ state, submittedBy }) => (
            <DocumentLifecycleStand
              key={state}
              version={{ state, submittedBy: submittedBy ?? null }}
              lifecycle="active"
              nameOf={(userId) => (userId ? (NAMES[userId] ?? 'Jemand') : 'Jemand')}
            />
          ))}
          {/* Item-level, so it is not a stage: the whole track reads as history. */}
          <DocumentLifecycleStand
            version={{ state: 'published', submittedBy: null }}
            lifecycle="archived"
            nameOf={() => 'Jemand'}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-muted-foreground text-sm font-medium">
          In Ruhe — eine hochgeladene Datei
        </h2>
        <p className="text-muted-foreground max-w-prose text-xs">
          Der Normalfall: Jemand hat die Datei hochgelegt, damit ist sie behauptet, und es steht
          nichts zur Entscheidung. Zugeklappt sagt der Abschnitt das Wort, die Strecke und einen
          Satz — Fassungen, Entscheidungen und das Stilllegen liegen dahinter.
        </p>
        <div className="rounded-xl border p-4">
          <DocumentLifecyclePanel
            documentId="doc_0"
            filename="Aktenvermerk Fluchtwege.pdf"
            authoredBy="user"
            viewer={REVIEWER_VIEWER}
            names={NAMES}
            client={UPLOADED}
          />
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
        <h2 className="text-muted-foreground text-sm font-medium">
          Veröffentlicht — aufgeklappt
        </h2>
        <div className="rounded-xl border p-4" data-preview-block="published">
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
