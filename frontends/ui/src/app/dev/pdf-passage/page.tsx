'use client'

/**
 * Dev preview for the cited-passage highlight.
 *
 * Renders the REAL `PdfDocumentView` against a real PDF — built byte by byte in
 * the browser below, so the route needs no backend, no corpus file and no
 * network. That matters more here than on other previews: the highlight is
 * computed from pdf.js's text layer, so a fixture that faked the document would
 * fake the very thing being shown.
 *
 * Two panes, because the affordance has two states and only one of them lasts:
 * the arrival pulse (frozen mid-swell with a negative animation delay, so the
 * screenshot is deterministic instead of catching whatever frame the harness
 * happened to reach) and the resting mark that stays behind.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { PdfDocumentView } from '@/features/knowledge/components/pdf-document-view'

const PAGE_LINES = [
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
  ['', 11, false],
  ['III. Begründung', 14, true],
  ['', 11, false],
  ['Das Bauvorhaben entspricht den Bestimmungen der OIB-Richtlinie 2', 11, false],
  ['in der Fassung 2023. Einwendungen der Nachbarn wurden innerhalb', 11, false],
  ['der Frist nicht erhoben.', 11, false],
] as const

/**
 * The passage the citation points at — deliberately quoted the way a retriever
 * would hand it over rather than the way the page prints it: the line break
 * between "Nutzungs-" and "einheit" is gone, and so is the one inside the
 * sentence. Recovering it anyway is the whole job of `passage-highlight.ts`.
 */
const CITED_PASSAGE =
  'Die beiden voneinander unabhängigen Fluchtwege je Nutzungseinheit sind während der gesamten Bauführung freizuhalten.'

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842

/** Escape the three characters a PDF literal string cannot carry raw. */
const pdfString = (text: string): string => text.replace(/([\\()])/g, '\\$1')

/**
 * Assemble a one-page PDF.
 *
 * Written out longhand rather than pulled from a library because the whole file
 * is under a hundred lines of it, and because the cross-reference table has to
 * carry real byte offsets — which is exactly what a string-concatenating
 * "generator" gets wrong. Every character stays below U+0100, so the string's
 * indices ARE its byte offsets and WinAnsi encodes umlauts one byte each.
 */
const buildPdf = (): Uint8Array<ArrayBuffer> => {
  let content = ''
  let y = PAGE_HEIGHT - 70
  for (const [text, size, bold] of PAGE_LINES) {
    if (text) {
      content += `BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 64 ${y} Tm (${pdfString(text)}) Tj ET\n`
    }
    y -= size + 8
  }

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]` +
      '/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${content.length}>>\nstream\n${content}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>',
  ]

  let file = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(file.length)
    file += `${index + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefStart = file.length
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) file += `${String(offset).padStart(10, '0')} 00000 n \n`
  file += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`

  const bytes = new Uint8Array(new ArrayBuffer(file.length))
  for (let i = 0; i < file.length; i += 1) bytes[i] = file.charCodeAt(i) & 0xff
  return bytes
}

export default function PdfPassagePreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([buildPdf()], { type: 'application/pdf' }))
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [])

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
        {(['arriving', 'resting'] as const).map((variant) => (
          <div
            key={variant}
            data-passage-state={variant}
            className="flex h-[760px] min-w-0 flex-1 flex-col rounded-lg border border-border bg-card p-3"
          >
            <p className="mb-2 shrink-0 text-xs font-medium uppercase tracking-[0.05em] text-muted-foreground">
              {variant === 'arriving' ? 'Beim Öffnen' : 'Danach'}
            </p>
            {src && (
              <PdfDocumentView
                src={src}
                title="Bescheid BA-2026-0417.pdf"
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
