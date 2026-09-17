'use client'

/**
 * Dev preview — the `diagram` card, in the two states a screenshot can pin.
 *
 *  1. **Drawn.** The card the model was taught to emit: the fixture is
 *     `CARD_EXAMPLES['diagram']` from `src/aiq_agent/cards/catalog.py`, drawn by
 *     the real client renderer (mermaid → the cascade flattened onto the
 *     elements → through the SERVER'S own SVG validator → injected). Under the
 *     drawing: the caption, then „Schematisch — ohne Maßangabe." — the same
 *     sentence a mermaid FENCE prints, from the same key — then the Fundstelle.
 *  2. **Not drawable.** The model writes invalid mermaid regularly, so this is
 *     the state the card meets most. It degrades to the source in a code block
 *     plus one quiet line. Never a red box, and note what SURVIVES: the title,
 *     the caption and the Fundstelle are the card's own words and they are just
 *     as true when the picture could not be laid out.
 *
 * The third state — the skeleton held while mermaid lays the graph out — is
 * genuinely transient and cannot be photographed deterministically (it ends the
 * moment the dynamic import resolves). It is pinned in `DiagramCard.spec.tsx`
 * instead ("holds the drawing's space instead of showing the source").
 *
 * The drawing sits on a light plate in BOTH themes on purpose — it is a preview
 * of a document that is filed, converted to PDF and attached on white, and the
 * Files pane already previews PDFs the same way. The dark screenshot is where
 * that decision is visible; it is a decision, not a missing dark mode.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): the copy
 * under review is the German copy. 404s outside development.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { DiagramCard } from '@/features/grid-cards/components/DiagramCard'

const REFERENCE = { document: 'Wiener Bauordnung', section: '§§ 60 ff.' }

/** `CARD_EXAMPLES['diagram']` — the shape the model is shown, drawn. */
const SEQUENCE = [
  'sequenceDiagram',
  '  participant BW as Bauwerber',
  '  participant BB as Baubehörde',
  '  participant ASV as Amtssachverständige',
  '  BW->>BB: Einreichunterlagen',
  '  BB->>ASV: Befassung zur Begutachtung',
  '  ASV-->>BB: Gutachten',
  '  BB-->>BW: Verbesserungsauftrag',
  '  BW->>BB: ergänzte Unterlagen',
  '  BB-->>BW: Baubewilligungsbescheid',
].join('\n')

/** An unclosed bracket — the commonest way a model-written source fails. */
const BROKEN = 'flowchart TD\n  A[Einreichung --> B[Bauverhandlung\n  B --> C'

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex w-[680px] max-w-full flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
      {children}
    </section>
  )
}

export default function DiagramCardPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="diagram-card-preview"
        className="flex min-h-screen flex-col items-center gap-10 bg-background p-10"
      >
        <Panel
          title="Gezeichnet"
          note="Drei Stellen reichen einander einen Akt — eine Form, die der Verfahrensablauf als Schiene nicht zeigen kann. Unter der Zeichnung steht, was sie weglässt, und darunter die Zeile, die sagt, dass hier nichts gemessen ist."
        >
          <DiagramCard
            title="Baubewilligungsverfahren – wer wem was übergibt"
            source={SEQUENCE}
            caption="Die Fristen zeigt die Grafik nicht — sie steht für die Reihenfolge der Übergaben."
            reference={REFERENCE}
          />
        </Panel>

        <Panel
          title="Nicht zeichenbar"
          note="Das Modell schreibt regelmäßig fehlerhaftes Mermaid. Die Leserin bekommt den Quelltext und eine leise Zeile — kein roter Kasten. Titel, Bildunterschrift und Fundstelle bleiben stehen: ein Verfahren ohne seine Fundstelle wäre ein Verfahren von nirgendwo."
        >
          <DiagramCard
            title="Bauanzeige – Ablauf mit Einspruchsfrist"
            source={BROKEN}
            caption="Gilt für Wien; andere Länder führen das Verfahren anders."
            reference={REFERENCE}
          />
        </Panel>
      </div>
    </I18nProvider>
  )
}
