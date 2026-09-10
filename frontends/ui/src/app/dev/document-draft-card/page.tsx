'use client'

/**
 * Dev preview — the `document_draft` card, in the two states it actually has.
 *
 *  1. **A draft that has been worked on.** The state the reader meets most: the
 *     tool wrote the path, the reader asked for a change, `edit_file` wrote it
 *     again — so the version is not 1. Everything on the card is a fact the
 *     working directory holds (name, path, size, how often it was written), and
 *     the byline is the Files feature's own component and words, because a file
 *     should say who wrote it the same way everywhere in the product.
 *  2. **The first write, and an empty one.** A stub the tool created with
 *     nothing in it yet: `v1`, `0 B`. It is here because a card that only looks
 *     right on rich values is a card that looks broken on the day the model
 *     writes a placeholder — and `bytes: 0` is inside the schema (`ge=0`).
 *
 * What the screenshot is FOR is the third thing, present on both: „Ins Projekt
 * übernehmen" is drawn and inert. This slice does not wire the filing call, and
 * a control that looked pressable would tell the reader their draft is now a
 * project document — the one claim a draft cannot make. Judge in both themes
 * that it reads as unavailable rather than as a control that failed to load,
 * and that it stays quieter than the draft's own name two lines above it.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): the copy
 * under review is the German copy. 404s outside development.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
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

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="document-draft-card-preview"
        className="flex min-h-screen flex-col items-center gap-10 bg-background p-10"
      >
        <Panel
          title="Überarbeiteter Entwurf"
          note="Dreimal geschrieben: einmal angelegt, zweimal auf Zuruf geändert. Titel ist die erste Überschrift im Dokument, darunter der Pfad im Arbeitsordner — bewusst als Pfad und nicht als Dateiname, denn der Entwurf liegt nicht in den Projektdateien."
        >
          <DocumentDraftCard
            title="Aktenvermerk – Abweichung Fluchtweglänge"
            path="/entwuerfe/aktenvermerk-fluchtweg.md"
            bytes={4820}
            version={3}
          />
        </Panel>

        <Panel
          title="Erster Schreibvorgang, noch leer"
          note="Der Stummel, den das Werkzeug anlegt, bevor Inhalt darin steht: v1 und 0 B. Die Karte muss auch so vollständig aussehen — eine Karte, die erst bei reichen Werten stimmt, sieht am Tag des Platzhalters kaputt aus."
        >
          <DocumentDraftCard title="Baubeschreibung.md" path="/entwuerfe/Baubeschreibung.md" bytes={0} version={1} />
        </Panel>
      </div>
    </I18nProvider>
  )
}
