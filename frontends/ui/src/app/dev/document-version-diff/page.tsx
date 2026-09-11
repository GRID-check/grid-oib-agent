'use client'

/**
 * Dev preview for the version diff — „was hat sich geändert" as the review pane
 * answers it.
 *
 * Four blocks, chosen so a reader can judge the two decisions this component
 * takes rather than admire one happy case:
 *
 *  1. **A revised Aktenvermerk.** The ordinary case: a corrected
 *     Gebäudeklasse, a tightened sentence, one paragraph added at the end.
 *     Judge whether an added line and a removed line are told apart WITHOUT
 *     colour — the left rule (solid vs dashed), the `+`/`−` gutter and the ink
 *     weight are all there is, on purpose, because chroma belongs to provenance.
 *  2. **An insert near the top of a long document.** The case the old
 *     side-by-side view refused to fake: every line after the insert shares no
 *     index with its counterpart, and the two line-number columns visibly drift
 *     apart. That drift is the evidence the alignment is real.
 *  3. **A long unchanged run.** Twelve pages with one correction is the diff
 *     nobody scrolls, so unchanged lines fold into a counted gap. Judge that
 *     the gap reads as "nothing happened here" rather than as a missing chunk.
 *  4. **Two identical versions.** A re-upload of the same bytes says so in a
 *     sentence instead of rendering an empty box the reader has to interpret.
 *
 * Pinned to German (`fixedLocale`) because the copy under review is the German
 * copy. 404s outside development.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { DocumentVersionDiff } from '@/features/documents/components/document-version-diff'

const AKTENVERMERK_V1 = `Aktenvermerk — Brandschutz, Bauteil B

1. Ausgangslage
Das Gebäude ist der Gebäudeklasse 4 zugeordnet.
Die Fluchtweglänge im 2. Obergeschoss beträgt 38 m.

2. Beurteilung
Die Anforderung nach OIB-Richtlinie 2 ist erfüllt.
Für den zweiten Fluchtweg ist kein Nachweis nötig.`

const AKTENVERMERK_V2 = `Aktenvermerk — Brandschutz, Bauteil B

1. Ausgangslage
Das Gebäude ist der Gebäudeklasse 5 zugeordnet.
Die Fluchtweglänge im 2. Obergeschoss beträgt 38 m.

2. Beurteilung
Die Anforderung nach OIB-Richtlinie 2 ist erfüllt.
Für den zweiten Fluchtweg liegt der Nachweis nach Tabelle 3 vor.

3. Offene Punkte
Die Tabelle 3 ist auf die neue Gebäudeklasse zu aktualisieren.`

const LONG_V1 = [
  'Einreichunterlagen — Prüfliste',
  '',
  ...Array.from({ length: 26 }, (_, index) => `${index + 1}. Punkt ${index + 1} geprüft, keine Beanstandung.`),
].join('\n')

const LONG_V2 = [
  'Einreichunterlagen — Prüfliste',
  '',
  'Hinweis: Die Liste folgt der Fassung vom 2. September.',
  ...Array.from({ length: 26 }, (_, index) => `${index + 1}. Punkt ${index + 1} geprüft, keine Beanstandung.`),
].join('\n')

const FOLDED_V1 = [
  ...Array.from({ length: 30 }, (_, index) => `Absatz ${index + 1} des Berichts.`),
  'Schlussfolgerung: Das Vorhaben ist bewilligungsfähig.',
].join('\n')

const FOLDED_V2 = [
  ...Array.from({ length: 30 }, (_, index) => `Absatz ${index + 1} des Berichts.`),
  'Schlussfolgerung: Das Vorhaben ist unter Auflagen bewilligungsfähig.',
].join('\n')

function Block({
  title,
  note,
  children,
}: {
  title: string
  note: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-foreground text-sm font-medium">{title}</h2>
        <p className="text-muted-foreground text-xs">{note}</p>
      </div>
      <div className="bg-card rounded-lg border p-3">{children}</div>
    </section>
  )
}

export default function DocumentVersionDiffDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        className="bg-background mx-auto max-w-3xl space-y-6 p-6"
        data-testid="document-version-diff-preview"
      >
        <h1 className="text-foreground text-base font-medium">Fassungen vergleichen</h1>

        <Block
          title="Überarbeiteter Aktenvermerk"
          note="Eine korrigierte Gebäudeklasse, ein umformulierter Satz, ein neuer Abschnitt."
        >
          <DocumentVersionDiff
            from={{ versionNumber: 1, content: AKTENVERMERK_V1 }}
            to={{ versionNumber: 2, content: AKTENVERMERK_V2 }}
          />
        </Block>

        <Block
          title="Eingefügte Zeile weit oben"
          note="Ab der Einfügung laufen die beiden Zeilennummern auseinander — genau das zeigt, dass verglichen und nicht nur nebeneinandergelegt wird."
        >
          <DocumentVersionDiff
            from={{ versionNumber: 4, content: LONG_V1 }}
            to={{ versionNumber: 5, content: LONG_V2 }}
          />
        </Block>

        <Block
          title="Eine Änderung in einem langen Bericht"
          note="Unveränderte Zeilen werden zu einer gezählten Lücke zusammengefasst."
        >
          <DocumentVersionDiff
            from={{ versionNumber: 7, content: FOLDED_V1 }}
            to={{ versionNumber: 8, content: FOLDED_V2 }}
          />
        </Block>

        <Block
          title="Zwei identische Fassungen"
          note="Ein erneuter Upload derselben Bytes sagt es in einem Satz, statt eine leere Liste zu zeigen."
        >
          <DocumentVersionDiff
            from={{ versionNumber: 9, content: FOLDED_V1 }}
            to={{ versionNumber: 10, content: FOLDED_V1 }}
          />
        </Block>
      </main>
    </I18nProvider>
  )
}
