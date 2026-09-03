'use client'

/**
 * Dev preview for file references — the filenames an answer writes into its own
 * prose, rendered through the real `AgentResponse`.
 *
 * The three things this surface exists to show:
 *
 *   1. A FILENAME IS A CONTROL. „Beginnen Sie mit pd8280-2.pdf" names a
 *      document the reader owns; before this it was dead text and the way to
 *      act on it was Dateien, the search box and the name typed back in.
 *   2. A FILE REFERENCE IS NOT A CITATION, AND MUST NOT LOOK LIKE ONE. Both
 *      appear here in the same paragraph: the tinted numeric pill carries a
 *      claim about a passage, the quiet named chip carries none. The click
 *      verbs differ too — a citation previews first, a file reference opens.
 *   3. A NAME THAT RESOLVES TO NOTHING STAYS PROSE. `Konzept-Entwurf.pdf` is in
 *      this answer and in nobody's project, so it renders exactly as written.
 *
 * The reading-order table is deliberate rather than decorative: this is the
 * shape the agent actually writes for "which document first", and a filename in
 * a table cell is the case a raw-markdown rewrite would have missed.
 *
 * The three document lists are stubbed over `window.fetch` at MODULE SCOPE —
 * the resolution index fetches from a mount effect, so a shim installed in a
 * parent effect would race the first load. Fixtures cover all three shelves,
 * because which shelf a file sits on is one of the facts the peek exists to
 * state.
 *
 * Not linked anywhere; the `/dev` server layout 404s it outside development.
 */

import { useEffect, type FC, type ReactNode } from 'react'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
import { useChatStore } from '@/features/chat/store'
import { I18nProvider } from '@/i18n'
import type { CitationSource } from '@/features/chat/types'

const at = new Date('2026-09-03T09:15:00')
const OIB = 'oib-rl_2_ausgabe_mai_2023.pdf'

const doc = (id: string, filename: string, extra: Record<string, unknown> = {}) => ({
  id,
  filename,
  displayName: null,
  fileSize: 2_400_000,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-08-20T08:00:00Z',
  errorMessage: null,
  summary: null,
  pageCount: 12,
  chunkCount: 84,
  contentTypes: ['text'],
  tags: null,
  ...extra,
})

const PROJECT_DOCUMENTS = [
  doc('p1', 'pd8280-2.pdf', {
    summary: 'Flächenwidmungs- und Bebauungsplan für den Bereich Lacknergasse.',
    pageCount: 4,
    tags: ['Bebauungsplan'],
  }),
  doc('p2', 'Wien-Lacknergasse-Grundrisse-floorplans.pdf', {
    summary: 'Grundrisse EG bis DG mit Erschließung, Aufenthalts- und Nebenräumen.',
    pageCount: 9,
    fileSize: 14_200_000,
    tags: ['Grundriss'],
  }),
  doc('p3', 'Wien-Lacknergasse-Schnitt-section.pdf', {
    summary: 'Längs- und Querschnitt mit Geschoßaufbau und Geländeanschluss.',
    pageCount: 3,
    tags: ['Schnitt'],
  }),
  doc('p4', '250120_PerspektivischerSchnitt.pdf', {
    summary: 'Entwurfsdarstellung ohne erkennbaren Maßstab.',
    pageCount: 1,
    fileSize: 8_100_000,
    status: 'stored',
  }),
]

const ARCHIV_DOCUMENTS = [
  doc('a1', 'Wien-Lacknergasse-Ansichten-views.pdf', {
    summary: 'Ansichten aller vier Fassaden, Stand Vorentwurf 1.',
    pageCount: 4,
  }),
]

const SESSION_DOCUMENTS = [
  doc('s1', 'mach-tiefenrecherche-2026-09-03.docx', {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    summary: 'Brandschutztechnische Vorprüfung mit offenen Nachweisen.',
    pageCount: 18,
    fileSize: 640_000,
  }),
]

if (typeof window !== 'undefined') {
  const real = window.fetch.bind(window)
  const json = (documents: unknown[]): Response =>
    new Response(JSON.stringify({ documents }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/session/documents')) return json(SESSION_DOCUMENTS)
    if (url.includes('/api/archiv/documents')) return json(ARCHIV_DOCUMENTS)
    if (url.includes('/api/documents')) return json(PROJECT_DOCUMENTS)
    return real(input as RequestInfo, init)
  }
}

/** One cited passage, so a citation pill sits beside the file chips. */
const citations: CitationSource[] = [
  {
    id: 'oib-1',
    content: `[KB] ${OIB}, p.14\nGebäudeklasse 5 umfasst Gebäude mit nicht mehr als sechs oberirdischen Geschoßen.`,
    citationKey: `${OIB}, p.14`,
    documentId: `doc:oib_knowledge:${OIB}`,
    fileName: OIB,
    collection: 'oib_knowledge',
    title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
    origin: 'kb',
    kind: 'baurecht',
    lane: 'baurecht_oib',
    laneLabel: 'OIB-Richtlinie',
    sourceType: 'knowledge_layer',
    page: 14,
    number: 1,
    isCited: true,
    timestamp: at,
  },
]

/**
 * An answer in the shape the agent actually writes one: a reading order in
 * prose, the same order as a comparison table, and a list of what is still
 * missing. Nine filenames, on three different shelves, one of them owned by
 * nobody.
 */
const answer = [
  'Das Projekt ist ein Wiener GK-5-Wohnbau-Zubau in Holzbauweise mit 12 m Fluchtniveau [1].',
  'Die beste Lesereihenfolge ist der Bebauungsplan pd8280-2.pdf, danach die',
  'Brandschutzvorprüfung mach-tiefenrecherche-2026-09-03.docx und anschließend',
  'Wien-Lacknergasse-Grundrisse-floorplans.pdf.',
  '',
  '| Kriterium | Projektgrundlagen | Brandschutz | Entwurf und Bestand |',
  '| --- | --- | --- | --- |',
  '| Wofür entscheidend | Widmung, Bauklassen, Fluchtlinien | GK 5, Fluchtwege, Brandabschnitte | Grundrisse, Schnitte, Bestand |',
  '| Wichtigste Datei | pd8280-2.pdf | mach-tiefenrecherche-2026-09-03.docx | Wien-Lacknergasse-Grundrisse-floorplans.pdf |',
  '| Status | Grundlage vorhanden | Vorprüfung ohne Konformitätsfeststellung | Vorentwurf, Bestand fehlt |',
  '',
  'Ergänzend zeigen Wien-Lacknergasse-Schnitt-section.pdf und',
  'Wien-Lacknergasse-Ansichten-views.pdf den Geschoßaufbau und die Fassaden;',
  '250120_PerspektivischerSchnitt.pdf ist eine Entwurfsdarstellung ohne',
  'erkennbaren Maßstab und daher keine Nachweisgrundlage.',
  '',
  'Noch nicht vorgelegt wurde Konzept-Entwurf.pdf.',
  '',
  '## Quellen',
  `- [1] [KB] ${OIB}, p.14`,
].join('\n')

const Block: FC<{ title: string; note: string; children: ReactNode }> = ({
  title,
  note,
  children,
}) => (
  <section className="flex flex-col gap-2">
    <div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="max-w-3xl text-xs text-muted-foreground">{note}</p>
    </div>
    {children}
  </section>
)

/**
 * The chat context the resolution index is scoped to.
 *
 * The peek that a hover opens is captured by the harness's own `hover` target
 * (`file-reference-peek`), with a real cursor — so there is nothing here to
 * simulate it with, and nothing that could go stale pretending to.
 */
const Stage: FC = () => {
  useEffect(() => {
    useChatStore.setState({ projectId: 'proj-lacknergasse' })
  }, [])
  return null
}

export default function FileReferencePreview() {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="file-reference-preview"
        className="mx-auto flex w-full max-w-4xl flex-col gap-8 p-8"
      >
        <Stage />
        <Block
          title="Filenames the answer names are openable"
          note="Nine names across three shelves — project files, the Büroarchiv and a document attached to this chat — each a chip that opens the document in the pane beside the answer. Konzept-Entwurf.pdf resolves to nothing and stays prose, which is the rule: a control that opens nothing is worse than plain text. The tinted [1] beside them is a citation and deliberately does not look the same: it carries a claim about a passage, a file reference carries none."
        >
          <AgentResponse
            content={answer}
            messageId="file-ref-1"
            conversationId="conv-lacknergasse"
            citations={citations}
            routingDecision="deep"
            answerConfidence="high"
          />
        </Block>

        <Block
          title="The same answer, inline variant"
          note="The compact bubble used inside a running thread. Same chips, same behaviour — which document a name opens must not depend on which shell rendered the sentence."
        >
          <AgentResponse
            content={answer}
            messageId="file-ref-2"
            conversationId="conv-lacknergasse"
            citations={citations}
            routingDecision="deep"
            variant="inline"
          />
        </Block>
      </div>
    </I18nProvider>
  )
}
