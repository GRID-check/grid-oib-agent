'use client'

/**
 * Dev preview — a diagram Piloti drew, inside an answer.
 *
 * Three panels, in the order a reader meets them:
 *
 *  1. **Drawn.** A process flow written as mermaid in the answer. Mermaid's
 *     parser reads it into a model (`features/diagrams/parse-mermaid.ts`) and
 *     this product's own `FlowDiagram` draws it, with no „Schematisch — ohne
 *     Maßangabe." line: that line is a claim about a drawing's geometry, and
 *     these views have none. Under it only the „Im Projekt ablegen" action,
 *     which appears because the panel is wrapped in a filing target the way an
 *     answer inside a project is. Mermaid's SVG is drawn only when the reader
 *     files it (`renderPaperDiagram`), on paper, and it carries the line in its
 *     own text.
 *  2. **Not drawable.** The model wrote broken mermaid, which it does. The
 *     reader gets the source they would have seen anyway plus one quiet line.
 *     Never a red box.
 *  3. **Still arriving.** CommonMark runs an unclosed fence to the end of its
 *     container, so a half-written diagram LOOKS complete on every token, and
 *     drawing it would flash a parse error. While the fence is open
 *     (`isOpenFence`) `MermaidDiagram` holds the drawing's place with
 *     `DrawingSkeleton`, not with the source: a code block turning into a
 *     picture when its fence closed was the largest jump a streamed answer
 *     made (ADR-0066).
 *
 * The drawing paints no ground of its own: the card surface shows through in
 * both themes (`components/mermaid-diagram.tsx`, „The drawing has no ground of
 * its own"). Only the filed copy is drawn on paper, whatever the theme.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): the copy
 * under review is the German copy. 404s outside development.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { DiagramFilingProvider } from '@/features/diagrams/diagram-filing-context'

const FLOW = `\`\`\`mermaid
graph TD
  A["Einreichung"] --> B["Bauverhandlung"]
  B --> C{"Auflagen?"}
  C -- "ja" --> D["Auflagen erfüllen"]
  C -- "nein" --> E["Baubewilligung"]
  D --> E
  E --> F["Fertigstellungsanzeige"]
\`\`\``

const BROKEN = `\`\`\`mermaid
graph TD
  A[Einreichung --> B[
\`\`\``

const STREAMING = `\`\`\`mermaid
graph TD
  A["Einreichung"] --> B["Bauver`

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex w-[680px] max-w-full flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
      <div className="rounded-lg border border-input bg-card px-[22px] pb-[17px] pt-[18px]">{children}</div>
    </section>
  )
}

export default function DiagramAnswerPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="diagram-answer-preview"
        className="flex min-h-screen flex-col items-center gap-10 bg-background p-10"
      >
        <Panel
          title="Gezeichnet, im Projekt ablegbar"
          note="Der Ablauf, von Piloti selbst gezeichnet, darunter die Aktion, die daraus zwei Dateien im Projekt macht: ein SVG, das in „Dateien“ vorschaubar ist und den Quelltext mitträgt, und ein PDF, das an eine Einreichung geht. Erst die abgelegte Fassung trägt die Zeile „Schematisch — ohne Maßangabe.“"
        >
          <DiagramFilingProvider target={{ projectId: 'proj-preview', answerId: 'msg-preview' }}>
            <MarkdownRenderer content={FLOW} />
          </DiagramFilingProvider>
        </Panel>

        <Panel
          title="Nicht zeichenbar"
          note="Das Modell schreibt regelmäßig fehlerhaftes Mermaid. Die Leserin bekommt genau das, was sie vorher bekommen hätte — den Quelltext — und eine leise Zeile dazu. Kein roter Kasten."
        >
          <MarkdownRenderer content={BROKEN} />
        </Panel>

        <Panel
          title="Noch im Fluss"
          note="Während die Antwort streamt, hält ein offener Mermaid-Block den Platz der Zeichnung frei, statt seinen Quelltext zu zeigen. Ein halbes Diagramm sähe fertig aus und würde bei jedem Token einen Parse-Fehler zeigen; gezeichnet wird erst, wenn der Block geschlossen ist."
        >
          <MarkdownRenderer content={STREAMING} isStreaming />
        </Panel>
      </div>
    </I18nProvider>
  )
}
