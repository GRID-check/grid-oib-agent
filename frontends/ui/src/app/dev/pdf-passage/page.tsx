'use client'

/**
 * Dev preview for the citation viewer: what a clicked citation opens onto.
 *
 * Renders the REAL components against a real PDF — built byte by byte in the
 * browser below, so the route needs no backend, no corpus file and no network.
 * That matters more here than on other previews: everything on this surface is
 * computed from pdf.js's text layer, so a fixture that faked the document would
 * fake the very thing being shown.
 *
 * Four variants, because the surface has four claims to make and no single
 * frame carries them:
 *
 *   (default)  the arrival pulse and the resting mark, side by side. The pulse
 *              is frozen mid-swell with a negative animation delay, so the
 *              screenshot is deterministic instead of catching whatever frame
 *              the harness happened to reach.
 *   `text`     the text layer, made visible. It ships transparent — its job is
 *              that a drag selects the sentence — so the only way to SEE
 *              whether it lines up with the glyphs it sits over is to paint it.
 *   `citation` the whole dialog: header, Fundstellen rail, document, mark.
 *   `single`   the same dialog for a document read at ONE page, which is a
 *              rail too.
 *   `plan`     a plan sheet cited for two depictions of a Sitztreppe: the
 *              dialog marks the Grundriss and the Schnitt by their boxes
 *              rather than searching the sheet for text.
 *   `quote`    the dialog with a passage the READER selected, and the offer
 *              that turns it into a citation. Driven by selecting a range and
 *              releasing the pointer — the same path a drag takes — because a
 *              screenshot of a resting page cannot show an affordance that
 *              only exists while something is selected.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { useEffect, useState, type FC } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { PdfDocumentView } from '@/features/knowledge/components/pdf-document-view'
import { CitationDocumentDialog } from '@/features/chat/components/SourcePreview'
import {
  buildCitationModel,
  resolveCitationTarget,
  type StoredDocumentRef,
} from '@/features/chat/lib/citations'
import type { CitationSource } from '@/features/chat/types'
import { assemblePdf, buildPdf, pdfString, type PdfLine } from '../_fixtures/sample-pdf'

const FILE_NAME = 'bescheid_ba-2026-0417.pdf'
const TITLE = 'Bescheid BA-2026-0417'

const PAGES: readonly (readonly PdfLine[])[] = [
  [
    ['Bescheid der Baubehörde erster Instanz', 22, true],
    ['Geschäftszahl BA-2026-0417/12', 11, false],
    ['', 11, false],
    ['I. Spruch', 14, true],
    ['', 11, false],
    ['Der Antrag auf Erteilung der Baubewilligung für den Zubau eines', 11, false],
    ['Stiegenhauses an der Nordfassade wird gemäß § 70 der Bauordnung', 11, false],
    ['bewilligt. Die Auflagen der Punkte 1 bis 7 sind Bestandteil dieses', 11, false],
    ['Bescheides.', 11, false],
    ['', 11, false],
    ['II. Auflagen', 14, true],
    ['', 11, false],
    ['1. Die Fertigstellung der Bauarbeiten ist der Behörde binnen vier', 11, false],
    ['Wochen schriftlich anzuzeigen. Der Anzeige sind die Bestätigungen', 11, false],
    ['der ausführenden Unternehmen anzuschließen.', 11, false],
    ['', 11, false],
    ['2. Die beiden voneinander unabhängigen Fluchtwege je Nutzungs-', 11, false],
    ['einheit sind während der gesamten Bauführung freizuhalten.', 11, false],
    ['', 11, false],
    ['3. Die Standsicherheit des bestehenden Dachstuhls ist vor Beginn', 11, false],
    ['der Arbeiten durch einen Sachverständigen zu beurteilen.', 11, false],
  ],
  [
    ['III. Begründung', 14, true],
    ['', 11, false],
    ['Das Bauvorhaben entspricht den Bestimmungen der OIB-Richtlinie 2', 11, false],
    ['in der Fassung 2023. Einwendungen der Nachbarn wurden innerhalb', 11, false],
    ['der Frist nicht erhoben.', 11, false],
    ['', 11, false],
    ['Die Rauchableitung des Stiegenhauses wurde durch den', 11, false],
    ['Brandschutzsachverständigen geprüft und für ausreichend befunden.', 11, false],
    ['', 11, false],
    ['Die Abstandsflächen zur nördlichen Grundgrenze bleiben', 11, false],
    ['unverändert; der Zubau liegt zur Gänze innerhalb der', 11, false],
    ['bebaubaren Fläche.', 11, false],
  ],
  [
    ['IV. Rechtsmittelbelehrung', 14, true],
    ['', 11, false],
    ['Gegen diesen Bescheid kann binnen vier Wochen ab Zustellung', 11, false],
    ['Beschwerde beim Landesverwaltungsgericht erhoben werden.', 11, false],
    ['', 11, false],
    ['Die Beschwerde ist bei der Behörde einzubringen, die den', 11, false],
    ['Bescheid erlassen hat.', 11, false],
  ],
]

/**
 * The passage the citation points at — deliberately quoted the way a retriever
 * would hand it over rather than the way the page prints it: the line break
 * between "Nutzungs-" and "einheit" is gone, and so is the one inside the
 * sentence. Recovering it anyway is the whole job of `passage-highlight.ts`.
 */
const CITED_PASSAGE =
  'Die beiden voneinander unabhängigen Fluchtwege je Nutzungseinheit sind während der gesamten Bauführung freizuhalten.'

const PLAN_FILE = 'einreichplan_eg.pdf'
const PLAN_TITLE = 'Einreichplan Erdgeschoss'
const PLAN_WIDTH = 842
const PLAN_HEIGHT = 595

/**
 * One A3-landscape sheet, drawn with real vector paths: a Grundriss with a
 * Sitztreppe on the left, a Schnitt through it on the right, a title block.
 * Its geometry is in PDF points, bottom-left origin; {@link PLAN_REGIONS} are
 * the same boxes normalised top-left, as the backend states them.
 */
const planContent = (): string => {
  const ops: string[] = ['0 0 0 RG']
  const rect = (x: number, y: number, w: number, h: number, width = 0.8) =>
    ops.push(`${width} w ${x} ${y} ${w} ${h} re S`)
  const line = (x1: number, y1: number, x2: number, y2: number, width = 0.5) =>
    ops.push(`${width} w ${x1} ${y1} m ${x2} ${y2} l S`)
  const text = (x: number, y: number, size: number, value: string, bold = false) =>
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfString(value)}) Tj ET`)

  // Grundriss EG: outer walls, two rooms, the Sitztreppe as eleven risers.
  rect(60, 90, 380, 400, 2.4)
  line(60, 300, 250, 300, 1.2)
  line(250, 90, 250, 300, 1.2)
  rect(270, 320, 150, 140, 0.8)
  for (let step = 0; step <= 10; step += 1) line(270, 320 + step * 14, 420, 320 + step * 14, 0.6)
  line(345, 330, 345, 450, 0.4)
  text(90, 400, 10, 'Foyer')
  text(100, 190, 10, 'Seminar')
  text(300, 200, 10, 'Innenhof')
  text(285, 466, 9, 'Sitztreppe')
  text(60, 505, 12, 'Grundriss EG  1:100', true)

  // Schnitt A-A: the same stair, stepped, in section.
  line(500, 260, 800, 260, 1.6)
  line(500, 430, 800, 430, 1.6)
  for (let step = 0; step < 8; step += 1) {
    const x = 560 + step * 22
    const y = 260 + step * 18
    line(x, y, x, y + 18, 0.8)
    line(x, y + 18, x + 22, y + 18, 0.8)
  }
  text(500, 445, 12, 'Schnitt A-A  1:100', true)

  // Title block.
  rect(600, 40, 220, 70, 0.8)
  text(612, 88, 10, 'Zubau Volksschule Nord', true)
  text(612, 70, 9, 'Einreichplan  Plan-Nr. EP-02')
  text(612, 54, 9, 'Architektur Muster ZT GmbH')
  return ops.join('\n') + '\n'
}

const buildPlanPdf = (): Uint8Array<ArrayBuffer> => {
  const content = planContent()
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PLAN_WIDTH} ${PLAN_HEIGHT}]` +
      '/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${content.length}>>\nstream\n${content}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>',
  ]
  return assemblePdf(objects)
}

/** A box in PDF points (bottom-left origin) as the backend states it: 0-1, top-left. */
const planBox = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => [
  +(x0 / PLAN_WIDTH).toFixed(4),
  +(1 - y1 / PLAN_HEIGHT).toFixed(4),
  +(x1 / PLAN_WIDTH).toFixed(4),
  +(1 - y0 / PLAN_HEIGHT).toFixed(4),
]

/**
 * The two depictions the vision model boxed on the sheet, with a little of the
 * approximation a real box has: each one takes in its own heading.
 */
const PLAN_REGIONS = [
  { box: planBox(48, 80, 452, 522), label: 'Grundriss EG' },
  { box: planBox(490, 250, 810, 462), label: 'Schnitt A-A' },
]

const PLAN_SOURCES: CitationSource[] = [
  {
    id: 'plan-1',
    content: `[KB] ${PLAN_FILE}, p.1`,
    citationKey: `${PLAN_FILE}, p.1`,
    documentId: `doc:proj_demo:${PLAN_FILE}`,
    fileName: PLAN_FILE,
    collection: 'proj_demo',
    shelf: 'project',
    title: PLAN_TITLE,
    origin: 'kb',
    kind: 'projekt',
    lane: 'projekt',
    laneLabel: 'Projektwissen',
    sourceType: 'knowledge_layer',
    page: 1,
    number: 1,
    isCited: true,
    snippet:
      '[DRAWING from page 1] Grundriss EG 1:100: Foyer, Seminarraum und eine Sitztreppe mit elf Stufen zum Innenhof. Schnitt A-A durch die Sitztreppe.',
    regions: PLAN_REGIONS,
    timestamp: new Date('2026-09-29T10:30:00'),
  },
]

/** One wire source — one LOCUS of the document, the shape the backend sends. */
const locus = (page: number, snippet: string, number?: number): CitationSource => ({
  id: `bescheid-${page}`,
  content: `[KB] ${FILE_NAME}, p.${page}\n${snippet}`,
  citationKey: `${FILE_NAME}, p.${page}`,
  documentId: `doc:oib_knowledge:${FILE_NAME}`,
  fileName: FILE_NAME,
  collection: 'oib_knowledge',
  title: TITLE,
  origin: 'kb',
  kind: 'baurecht',
  lane: 'baurecht_oib',
  laneLabel: 'Bescheid',
  sourceType: 'knowledge_layer',
  page,
  number,
  isCited: number !== undefined,
  timestamp: new Date('2026-07-28T14:30:00'),
})

/**
 * A document the turn read at three pages, and one it read at a single page.
 * The third locus carries no `[N]`: retrieval surfaced it and the answer passed
 * over it, which the rail says rather than hides.
 */
const READ_AT_THREE = [
  locus(1, CITED_PASSAGE, 1),
  locus(2, 'Die Rauchableitung des Stiegenhauses wurde durch den Brandschutzsachverständigen geprüft und für ausreichend befunden.', 2),
  locus(3, 'Gegen diesen Bescheid kann binnen vier Wochen ab Zustellung Beschwerde beim Landesverwaltungsgericht erhoben werden.'),
]

const READ_AT_ONE = [locus(1, CITED_PASSAGE, 1)]

/**
 * Select a sentence on the open page, the way a reader's drag would.
 *
 * The harness captures a page at rest, and the quote offer exists only while a
 * selection does — so without this the one affordance the text layer was built
 * for would appear in no committed screenshot. It waits for the run to be in the
 * DOM rather than sleeping: how long pdf.js takes to lay out a page depends on
 * whether this route was compiled already, and a fixed delay silently captures
 * the wrong frame when it loses that race.
 */
const SelectOnLoad: FC<{ contains: string }> = ({ contains }) => {
  useEffect(() => {
    let attempts = 0
    let timer = 0
    const tick = (): void => {
      const run = [...document.querySelectorAll('.pdf-text-layer span')].find((span) =>
        span.textContent?.includes(contains)
      )
      const frame = document.querySelector('[data-testid="pdf-scroll"]')
      if (run && frame) {
        const range = document.createRange()
        range.selectNodeContents(run)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        frame.dispatchEvent(new Event('pointerup', { bubbles: true }))
        return
      }
      if (attempts++ > 80) return
      timer = window.setTimeout(tick, 50)
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [contains])

  return null
}

/** The real dialog, mounted open, over the fixture document. */
const DialogPreview = ({
  sources,
  src,
  fileName = FILE_NAME,
  storedDocuments,
}: {
  sources: CitationSource[]
  src: string
  fileName?: string
  /** A project upload resolves through its `documents` row, not the base corpus. */
  storedDocuments?: StoredDocumentRef[]
}) => {
  const [document] = buildCitationModel({ citations: sources })
  const [activeLocus, setActiveLocus] = useState(document?.loci[0])
  if (!document) return null
  const target = resolveCitationTarget(document, {
    locus: activeLocus,
    baseCorpusFiles: storedDocuments ? [] : [fileName],
    storedDocuments,
  })
  if (target.kind !== 'document') return null
  return (
    <CitationDocumentDialog
      target={target}
      citation={{ document, locus: activeLocus }}
      activeLocus={activeLocus}
      onSelectLocus={setActiveLocus}
      src={src}
      open
      onOpenChange={() => {}}
    />
  )
}

/** The plan sheet, served the way the other variants serve theirs. */
const PlanPreview = () => {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([buildPlanPdf()], { type: 'application/pdf' }))
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [])
  return src ? (
    <DialogPreview
      sources={PLAN_SOURCES}
      src={src}
      fileName={PLAN_FILE}
      storedDocuments={[
        { id: 'plan-eg', filename: PLAN_FILE, contentType: 'application/pdf', shelf: 'project' },
      ]}
    />
  ) : null
}

export default function PdfPassagePreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  const variant = useSearchParams()?.get('variant')
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([buildPdf(PAGES)], { type: 'application/pdf' }))
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [])

  if (variant === 'plan') {
    return (
      <div className="min-h-dvh bg-background p-6">
        {/* At rest, for the reason the other dialog shots give. */}
        <style>{`.animate-passage-ping { animation: none; }`}</style>
        <PlanPreview />
      </div>
    )
  }

  if (variant === 'citation' || variant === 'single' || variant === 'quote') {
    return (
      <div className="min-h-dvh bg-background p-6">
        {/* The mark at REST. These three shots are about the dialog, not about
            the arrival pulse — which has its own frozen pane in the default
            variant — and an animation still running makes the capture depend on
            when the harness got there: the light and dark shots come off one
            page load, so without this they would land on different frames of
            the same swell and every re-capture would produce a different pair. */}
        <style>{`.animate-passage-ping { animation: none; }`}</style>
        {variant === 'quote' && <SelectOnLoad contains="Standsicherheit" />}
        {src && (
          <DialogPreview
            sources={variant === 'single' ? READ_AT_ONE : READ_AT_THREE}
            src={src}
          />
        )}
      </div>
    )
  }

  if (variant === 'text') {
    return (
      <div className="min-h-dvh bg-background p-6">
        {/* The layer ships transparent over the canvas, so alignment is
            invisible by construction — and a layer that has drifted selects the
            wrong words with no sign that anything is wrong. Painting it is the
            only way a screenshot can hold that evidence. */}
        <style>{`
          [data-textlayer-visible] .pdf-text-layer span {
            color: color-mix(in oklch, var(--source-law) 85%, transparent);
            background-color: color-mix(in oklch, var(--source-law) 10%, transparent);
          }
        `}</style>
        <h1 className="mb-1 text-lg font-semibold text-foreground">Textlayer über der Seite</h1>
        <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
          Die Seite wird als Bild gerendert; darüber liegt der echte Text der Seite, unsichtbar und
          auswählbar. Hier ist er eingefärbt: Jede Zeile muss auf den Glyphen darunter liegen —
          sonst markiert eine Auswahl die falschen Wörter.
        </p>
        <div
          data-textlayer-visible
          className="flex h-[760px] flex-col rounded-lg border border-border bg-card p-3"
        >
          {src && <PdfDocumentView src={src} title={`${TITLE}.pdf`} page={1} />}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-background p-6">
      {/* Freezing the pulse is what makes this capturable. A negative delay
          starts the animation part-way through and `paused` holds it there, so
          the left pane is always the same frame of the swell.

          -0.055s is not a guess. The ping runs 1.15s on cubic-bezier(0.16, 1,
          0.3, 1), whose eased output reaches the 30% keyframe — the peak — at
          roughly 4.7% of the duration, because that curve spends almost all of
          its range in the first sliver of its domain. Freezing any later lands
          in the settle, where the two panes look identical. */}
      <style>{`
        [data-passage-state='arriving'] .animate-passage-ping {
          animation-delay: -0.055s;
          animation-play-state: paused;
        }
        [data-passage-state='resting'] .animate-passage-ping {
          animation: none;
        }
      `}</style>

      <h1 className="mb-1 text-lg font-semibold text-foreground">Fundstelle im PDF</h1>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Die zitierte Passage wird im Textlayer der Seite gesucht und markiert — links der
        ankommende Impuls, rechts die bleibende Markierung. Der Ausschnitt ist über zwei Zeilen
        umbrochen und im Zitat ohne Trennstrich zitiert.
      </p>

      <div className="flex gap-4">
        {(['arriving', 'resting'] as const).map((state) => (
          <div
            key={state}
            data-passage-state={state}
            className="flex h-[760px] min-w-0 flex-1 flex-col rounded-lg border border-border bg-card p-3"
          >
            <p className="mb-2 shrink-0 text-xs font-medium uppercase tracking-[0.05em] text-muted-foreground">
              {state === 'arriving' ? 'Beim Öffnen' : 'Danach'}
            </p>
            {src && (
              <PdfDocumentView
                src={src}
                title={`${TITLE}.pdf`}
                page={1}
                highlight={CITED_PASSAGE}
                highlightColor="var(--source-law)"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
