'use client'

/**
 * Dev preview for the document-role surfaces — the real `DocumentRoleField` and
 * `ProjektgrundlagenStep` with a module-scope fetch shim and no backend, so the
 * design can be reviewed and screenshotted (`docs/ux/visual-screenshots.md`).
 * Not linked from anywhere; 404s outside development.
 *
 * Unlike `/dev/access-overview` these components DO read from the server, so the
 * shim is installed at module scope — before React mounts anything — rather than
 * in an effect. An effect runs after the first fetch has already gone out, which
 * is the difference between a deterministic screenshot and a flake.
 *
 * The fixtures exercise the states that are easy to get wrong:
 *   - a single-holder role that is already filled (the Bebauungsplan), which is
 *     what "replace, do not reject" looks like before the replacement;
 *   - a many-holder role mid-set (two Bestandsplan sheets on one building);
 *   - an unconfirmed binding, which must read as a suggestion and not a fact;
 *   - an empty slot, which is the state most of the checklist is in on day one;
 *   - the checklist itself with two buildings, where the per-building slots are
 *     the thing a single box could not express.
 *
 * Pinned to German for the same reason the other previews are: the committed
 * evidence has to carry the copy users actually see.
 */

import { notFound } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { DocumentRoleField } from '@/features/projects/components/document-role-field'
import { ProjektgrundlagenStep } from '@/features/projects/components/projektgrundlagen-step'

const PROJECT_ID = 'preview-project'

const BINDINGS = [
  {
    id: 'b1',
    documentId: 'd1',
    role: 'bebauungsplan',
    scopeInstanceId: null,
    confidence: 'declared',
    filename: 'bebauungsplan-1042.pdf',
    displayName: 'B-Plan 1042 · Plandokument',
  },
  {
    id: 'b2',
    documentId: 'd2',
    role: 'bestandsplan',
    scopeInstanceId: 'bw1',
    confidence: 'declared',
    filename: 'bestand-eg.pdf',
    displayName: 'Bestand Erdgeschoß',
  },
  {
    id: 'b3',
    documentId: 'd3',
    role: 'bestandsplan',
    scopeInstanceId: 'bw1',
    confidence: 'suggested',
    filename: 'schnitt-a-a.pdf',
    displayName: null,
  },
]

const DOCUMENTS = [
  { id: 'd1', filename: 'bebauungsplan-1042.pdf', displayName: 'B-Plan 1042 · Plandokument' },
  { id: 'd2', filename: 'bestand-eg.pdf', displayName: 'Bestand Erdgeschoß' },
  { id: 'd3', filename: 'schnitt-a-a.pdf', displayName: null },
  { id: 'd4', filename: 'lageplan-vermessung.pdf', displayName: 'Lageplan (Vermessung)' },
  { id: 'd5', filename: 'gutachten-baugrund.pdf', displayName: null },
]

// Module scope on purpose: see the note above.
if (typeof window !== 'undefined') {
  const real = window.fetch.bind(window)
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/document-roles')) {
      return new Response(JSON.stringify({ roles: BINDINGS }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/api/documents?')) {
      return new Response(JSON.stringify({ documents: DOCUMENTS }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return real(input, init)
  }) as typeof window.fetch
}

const ANSWERS = {
  B2: 'ja',
  A5: ['Neubau', 'Abbruch'],
  'C2@bw1': 'bestand',
  'C2@bw2': 'neubau',
}

const BAUWERKE = [
  { id: 'bw1', name: 'Bestandsgebäude Hoftrakt' },
  { id: 'bw2', name: 'Neubau Straßentrakt' },
]

export default function DocumentRolesPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto flex max-w-3xl flex-col gap-10 p-8">
        <section className="flex flex-col gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Im Assistenten: Bebauungsplan</h1>
          <div className="rounded-xl border bg-card p-4">
            <DocumentRoleField
              projectId={PROJECT_ID}
              role="bebauungsplan"
              label="Bebauungsplan ablegen"
            />
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Mehrere Blätter, ein Bauwerk</h2>
          <div className="rounded-xl border bg-card p-4">
            <DocumentRoleField
              projectId={PROJECT_ID}
              role="bestandsplan"
              scopeInstanceId="bw1"
              label="Bestandspläne — Bestandsgebäude Hoftrakt"
            />
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Modul I · Projektgrundlagen</h2>
          <ProjektgrundlagenStep projectId={PROJECT_ID} answers={ANSWERS} bauwerke={BAUWERKE} />
        </section>
      </main>
    </I18nProvider>
  )
}
