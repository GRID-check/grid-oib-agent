'use client'

/**
 * Dev preview — a diagram Piloti drew, inside an answer.
 *
 * Three panels, in the order a reader meets them:
 *
 *  1. **Drawn.** A process flow written as mermaid in the answer, rendered by
 *     the real client renderer (mermaid → flatten the cascade onto the elements
 *     → through the SERVER'S own SVG validator → injected). Under it: the line
 *     that carries the doctrine — „Schematisch — ohne Maßangabe." — and the
 *     „Im Projekt ablegen" action, which appears only because this panel is
 *     wrapped in a filing target the way an answer inside a project is.
 *  2. **Not drawable.** The model wrote broken mermaid, which it does. The
 *     reader gets the source they would have seen anyway plus one quiet line.
 *     Never a red box.
 *  3. **Still arriving.** During streaming a mermaid fence is a code block: the
 *     markdown stabiliser auto-closes an odd fence, so a half-written diagram
 *     LOOKS complete on every token and drawing it would flash a parse error.
 *
 * The drawing sits on a light surface in BOTH themes on purpose — it is a
 * preview of a document that is filed, converted to PDF and attached on white,
 * and the Files pane already previews PDFs the same way. The dark screenshot is
 * where that decision is visible; it is a decision, not a missing dark mode.
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
          note="Der Ablauf als Diagramm, darunter die Zeile, die sagt, dass nichts gemessen ist — und die Aktion, die daraus zwei Dateien im Projekt macht: ein SVG, das in „Dateien“ vorschaubar ist und den Quelltext mitträgt, und ein PDF, das an eine Einreichung geht."
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
          note="Während die Antwort streamt, ist ein Mermaid-Block ein Codeblock. Der Stabilisator schließt eine offene Zäune automatisch, ein halbes Diagramm sähe also fertig aus — und würde bei jedem Token einen Parse-Fehler zeigen."
        >
          <MarkdownRenderer content={STREAMING} isStreaming />
        </Panel>
      </div>
    </I18nProvider>
  )
}
