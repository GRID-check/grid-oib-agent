'use client'

/**
 * Dev preview — the `document_draft` card, in the states it actually has.
 *
 *  1. **A draft that has been worked on, still only in the chat.** The state the
 *     reader meets first: the tool wrote the path, the reader asked for a
 *     change, `edit_file` wrote it again — so the version is not 1. Everything
 *     on the card is a fact the working directory holds (name, path, size, how
 *     often it was written), and the byline is the Files feature's own component
 *     and words, because a file should say who wrote it the same way everywhere.
 *     The one action, „Ins Projekt übernehmen", writes NOTHING: it puts the
 *     request in the composer, because the bytes are in the agent's working
 *     directory and the browser has neither them nor a route to file them (the
 *     component's header argues this).
 *  2. **Filed, and still the reader's to send.** After `file_draft`: the card
 *     names a project document, says so, and offers the two things that are now
 *     real — opening it beside the conversation, and sending it for approval.
 *     „Zur Freigabe einreichen" is the interactive half and calls the same route
 *     the Files pane calls.
 *  3. **Already with a reviewer.** After `submit_draft`, or after the reader
 *     pressed the control in 2: the card reports the state and draws no control,
 *     because the version can no longer be replaced and the next move belongs to
 *     a person.
 *  4. **The first write, and an empty one.** A stub the tool created with
 *     nothing in it yet: `v1`, `0 B`. It is here because a card that only looks
 *     right on rich values is a card that looks broken on the day the model
 *     writes a placeholder — and `bytes: 0` is inside the schema (`ge=0`).
 *
 * What the screenshot is FOR is the line between 1 and 2. Judge in both themes
 * that the unfiled card never reads as though the document is already in the
 * project, that the filed one says plainly that it is a DRAFT and not a
 * Freigabe, and that the controls stay quieter than the draft's own name two
 * lines above them.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): the copy
 * under review is the German copy. 404s outside development.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { useChatStore } from '@/features/chat/store'
import { DocumentDraftCard } from '@/features/grid-cards/components/DocumentDraftCard'

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex w-[680px] max-w-full flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
      {children}
    </section>
  )
}

export default function DocumentDraftCardPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()
  // „Im Projekt öffnen" links into the Files pane, which is project-scoped, so
  // without a project in the store a filed card correctly draws no link — and
  // the filed card's two controls are what this page exists to judge. A chat
  // that filed anything always has one.
  useChatStore.setState({ projectId: 'proj-demo' })

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="document-draft-card-preview"
        className="flex min-h-screen flex-col items-center gap-10 bg-background p-10"
      >
        <Panel
          title="Überarbeiteter Entwurf, noch nicht abgelegt"
          note="Dreimal geschrieben: einmal angelegt, zweimal auf Zuruf geändert. Titel ist die erste Überschrift im Dokument, darunter der Pfad im Arbeitsordner — bewusst als Pfad und nicht als Dateiname, denn der Entwurf liegt nicht in den Projektdateien. „Ins Projekt übernehmen“ schreibt die Bitte in die Eingabezeile; abgelegt wird von Piloti."
        >
          <DocumentDraftCard
            title="Aktenvermerk – Abweichung Fluchtweglänge"
            path="/entwuerfe/aktenvermerk-fluchtweg.md"
            bytes={4820}
            version={3}
            cardKey="document_draft-0"
          />
        </Panel>

        <Panel
          title="Im Projekt abgelegt, noch nicht eingereicht"
          note="Nach `file_draft`: Das Dokument liegt als Entwurf im Projekt. Zwei Aktionen sind jetzt echt — öffnen (neben der Unterhaltung, nicht statt ihr) und zur Freigabe einreichen. Die Zeile sagt „Entwurf“, nie „freigegeben“."
        >
          <DocumentDraftCard
            title="Aktenvermerk – Abweichung Fluchtweglänge"
            path="/entwuerfe/aktenvermerk-fluchtweg.md"
            bytes={4820}
            version={3}
            documentId="00000000-0000-4000-8000-000000000001"
            versionId="00000000-0000-4000-8000-0000000000a1"
            versionState="draft"
            cardKey="document_draft-1"
          />
        </Panel>

        <Panel
          title="Zur Freigabe eingereicht"
          note="Nach `submit_draft` oder nach dem Klick oben: Die Fassung kann nicht mehr ersetzt werden, also gibt es hier keine Schaltfläche mehr — nur die Auskunft, worauf gewartet wird. Ein Knopf, den die Route ablehnen würde, wäre schlechter als keiner."
        >
          <DocumentDraftCard
            title="Aktenvermerk – Abweichung Fluchtweglänge"
            path="/entwuerfe/aktenvermerk-fluchtweg.md"
            bytes={4820}
            version={3}
            documentId="00000000-0000-4000-8000-000000000001"
            versionId="00000000-0000-4000-8000-0000000000a1"
            versionState="in_review"
            cardKey="document_draft-2"
          />
        </Panel>

        <Panel
          title="Erster Schreibvorgang, noch leer"
          note="Der Stummel, den das Werkzeug anlegt, bevor Inhalt darin steht: v1 und 0 B. Die Karte muss auch so vollständig aussehen — eine Karte, die erst bei reichen Werten stimmt, sieht am Tag des Platzhalters kaputt aus."
        >
          <DocumentDraftCard
            title="Baubeschreibung.md"
            path="/entwuerfe/Baubeschreibung.md"
            bytes={0}
            version={1}
            cardKey="document_draft-3"
          />
        </Panel>
      </div>
    </I18nProvider>
  )
}
