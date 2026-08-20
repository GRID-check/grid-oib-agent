/**
 * @vitest-environment node
 */
/**
 * The PDF is real, and it is vector.
 *
 * The claim this file exists to hold is that a diagram becomes an attachable
 * PDF **with no browser anywhere** — `@react-pdf/renderer` is already a
 * production dependency and ships native SVG primitives, so nothing here needs
 * Chromium, a canvas or a DOM. A test that only asserted "some bytes came back"
 * would pass against a blank page, so the assertions go into the content stream
 * and look for the drawing operators the geometry has to have produced.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { acceptDiagram } from './svg'
import { renderDiagramPdf } from './svg-to-pdf'

/** Every Flate stream in the file, inflated. This is where the drawing is. */
function contentStreams(pdf: Uint8Array): string[] {
  const raw = Buffer.from(pdf).toString('latin1')
  const streams: string[] = []
  const marker = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = marker.exec(raw))) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end === -1) continue
    try {
      streams.push(inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'))
    } catch {
      // Not every stream is Flate (embedded font subsets are not), and a stream
      // this cannot read is not a failure — it is simply not the drawing.
    }
  }
  return streams
}

function drawing(svgBody: string, viewBox = '0 0 200 100') {
  return acceptDiagram({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${svgBody}</svg>`,
    sourceKind: 'mermaid',
    source: 'graph TD\n  A --> B',
  })
}

async function pdfFor(svgBody: string, viewBox?: string) {
  const accepted = drawing(svgBody, viewBox)
  return renderDiagramPdf({
    root: accepted.root,
    viewport: accepted.viewport,
    title: 'Ablauf Einreichung',
    projectName: 'Straßenhäuser',
    marking: 'Von Piloti erstellt — KI-generiert, nicht geprüft.',
    createdAt: new Date('2026-08-20T00:00:00Z'),
  })
}

describe('a diagram becomes a PDF, without a browser', () => {
  it('produces a real PDF', async () => {
    const pdf = await pdfFor('<rect x="10" y="10" width="80" height="40" fill="#eef" stroke="#333"/>')
    expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
  })

  it('draws the geometry as vector operators, not as a raster', async () => {
    // react-pdf emits a <Rect> as an explicit path — `10 10 m`, three `l`s, `h`
    // to close, `B` to fill AND stroke — rather than as the `re` operator. The
    // corner coordinates are the assertion that matters: they are the SVG's own
    // numbers, which is what "vector, not a screenshot" means. A rasterised
    // page would carry an image XObject and none of this.
    const pdf = await pdfFor('<rect x="10" y="10" width="80" height="40" fill="#eef" stroke="#333"/>')
    const streams = contentStreams(pdf).join('\n')
    expect(streams).toContain('10 10 m')
    expect(streams).toContain('90 50 l')
    expect(streams).toMatch(/\bB\b/)
    expect(streams).not.toContain('/Image')
  })

  it('draws a path as curves and lines', async () => {
    const pdf = await pdfFor('<path d="M 10 10 L 90 10 C 95 10 95 40 90 40" stroke="#080" fill="none"/>')
    const streams = contentStreams(pdf).join('\n')
    // `m` moveto, `l` lineto, `c` curveto — the path survived as a path.
    expect(streams).toMatch(/\bm\b[\s\S]*\bl\b/)
    expect(streams).toMatch(/\bc\b/)
  })

  it('prints text at the size the diagram asked for', async () => {
    // The font size reaches the PDF through a wrapper <G style>, because
    // react-pdf types an SVG <Text>'s style as SVGPresentationAttributes, which
    // has no font properties, while a <G>'s style is the full Style. This is
    // the assertion that keeps that arrangement honest instead of a cast.
    const pdf = await pdfFor('<text x="10" y="30" font-size="19" fill="#000">Bescheid</text>')
    expect(contentStreams(pdf).join('\n')).toMatch(/\/F\d+ 19 Tf/)
  })

  it('never asks for a font it cannot have', async () => {
    // Mermaid asks for `"trebuchet ms", verdana, arial, sans-serif`, and
    // requesting any of those throws at render time — a diagram would fail to
    // become a PDF over a typeface. Every family lands on Helvetica instead.
    const pdf = await pdfFor(
      '<text x="10" y="30" font-family="trebuchet ms, verdana" font-weight="bold">Fett</text>',
    )
    expect(Buffer.from(pdf).toString('latin1')).toContain('Helvetica-Bold')
  })

  it('turns the page to follow the drawing', async () => {
    // A wide flowchart rotated onto a portrait page is the same drawing at half
    // the size, and the whole reason this artifact exists is that somebody has
    // to read it on paper.
    const wide = Buffer.from(await pdfFor('<rect width="10" height="10"/>', '0 0 400 100')).toString('latin1')
    const tall = Buffer.from(await pdfFor('<rect width="10" height="10"/>', '0 0 100 400')).toString('latin1')
    // The trailing digits are pdfkit's own float formatting of the same A4.
    expect(wide).toMatch(/MediaBox \[0 0 841\.89\d* 595\.28\d*\]/)
    expect(tall).toMatch(/MediaBox \[0 0 595\.28\d* 841\.89\d*\]/)
  })

  it('carries the provenance line as text on the page', async () => {
    // The grey byline in the Files pane is chrome; this line is the artifact,
    // and the artifact is what reaches the Behörde.
    const pdf = await pdfFor('<rect width="10" height="10"/>')
    const streams = contentStreams(pdf).join('\n')
    // Three text runs: the title, the project · date line, and the marking.
    expect(streams.match(/\bTf\b/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('does not print the diagram source across the page', async () => {
    // `<metadata>` carries the mermaid text so the drawing can be regenerated.
    // It is not paint, and a PDF that printed it would be unreadable.
    const accepted = drawing('<rect width="10" height="10"/>')
    const pdf = await renderDiagramPdf({
      root: accepted.root,
      viewport: accepted.viewport,
      title: 'Ablauf',
      projectName: 'P',
      marking: 'm',
      createdAt: new Date('2026-08-20T00:00:00Z'),
    })
    expect(Buffer.from(pdf).toString('latin1')).not.toContain('graph TD')
  })
})

/**
 * The same pipeline, against real mermaid output.
 *
 * The fixture is not handwritten: it is what `renderMermaid` produced in
 * Chromium for a seven-node Einreichung flow — mermaid's own SVG with the
 * cascade flattened onto the elements and the whole thing already through
 * `serializeDiagramSvg`. It is checked in so the SERVER half can be tested
 * against the real thing in Node, with no browser, which is the only place this
 * repository has one.
 *
 * It is also the regression that would have caught the bug a screenshot found:
 * an early `flattenComputedStyles` stripped `class` in the same pass that read
 * the cascade, so mermaid's `#id .node rect { fill }` stopped matching and every
 * node came back black. A fixture with real fills is what makes that visible
 * without opening a browser.
 */
const REAL_MERMAID = readFileSync(join(__dirname, '__fixtures__/mermaid-flowchart.svg'), 'utf8')

describe('real mermaid output', () => {
  const accepted = () =>
    acceptDiagram({ svg: REAL_MERMAID, sourceKind: 'mermaid', source: 'graph TD\n  A --> B' })

  it('is accepted by the validator that produced it', () => {
    // The client renders THROUGH this same validator before it shows anything,
    // so a mermaid release that starts emitting something the server refuses
    // fails on a developer's screen rather than as a 400 on a finished diagram.
    expect(() => accepted()).not.toThrow()
  })

  it('carries paint, not just geometry', () => {
    // The cascade reached the attributes. `#ECECFF` is mermaid's default node
    // fill; a black diagram is what "read the cascade after stripping the
    // classes" produces, and it renders as a valid SVG all the same.
    expect(REAL_MERMAID.toLowerCase()).toContain('fill="#ececff"')
    expect(REAL_MERMAID).not.toContain('<style')
    expect(REAL_MERMAID).not.toContain('foreignObject')
  })

  it('draws an arrowhead on a directed edge, and none on an undirected one', async () => {
    // `@react-pdf/renderer` exports a `Marker` component that its own renderer
    // cannot resolve from an SVG `url(#id)` reference, so the heads are computed
    // from the edges here. A process flow without them is not a smaller drawing
    // — „A → B" and „A — B" are different claims, and this is the file that gets
    // attached to an Einreichung.
    //
    // A stroked, unfilled edge produces NO fill operator, so counting `f` on a
    // page holding nothing else is exactly a count of arrowheads. The pair is
    // the assertion: an earlier version of this test counted fills on the whole
    // fixture and passed with the heads removed, because the nodes are filled.
    const fills = (pdf: Uint8Array) => contentStreams(pdf).join('\n').match(/\bf\b/g)?.length ?? 0
    const directed = await pdfFor('<path d="M 10 10 L 10 90" stroke="#000" fill="none" marker-end="url(#a)"/>')
    const plain = await pdfFor('<path d="M 10 10 L 10 90" stroke="#000" fill="none"/>')
    expect(fills(plain)).toBe(0)
    expect(fills(directed)).toBe(1)
  })

  it('refuses to guess a direction it cannot compute', async () => {
    // An arc's last two coordinate pairs are not its end tangent, so a head
    // placed from them points somewhere the edge does not go. On a drawing
    // somebody signs, no head is better than a wrong one.
    const arc = await pdfFor('<path d="M 10 10 A 20 20 0 0 1 60 60" stroke="#000" fill="none" marker-end="url(#a)"/>')
    expect(contentStreams(arc).join('\n').match(/\bf\b/g)?.length ?? 0).toBe(0)
  })

  it('becomes a PDF with the node labels in it', async () => {
    const diagram = accepted()
    const pdf = await renderDiagramPdf({
      root: diagram.root,
      viewport: diagram.viewport,
      title: 'Ablauf Einreichung',
      projectName: 'Straßenhäuser',
      marking: 'Von Piloti erstellt — KI-generiert, nicht geprüft.',
      createdAt: new Date('2026-08-20T00:00:00Z'),
    })
    const streams = contentStreams(pdf).join('\n')
    // Every shape is a subpath: 23 rects, 13 paths and eight arrowheads.
    expect(streams.match(/\bm\b/g)?.length ?? 0).toBeGreaterThanOrEqual(20)
    // The LABELS, which is the assertion that matters and the one that caught a
    // real bug: mermaid writes a node label as a `<text>` with no `x`/`y` inside
    // a translated `<g>`, and requiring those attributes dropped every label —
    // producing a PDF that looked like a diagram and said nothing. `TJ` is the
    // text-showing operator, so counting it counts labels that actually print.
    expect(streams.match(/\bTJ\b/g)?.length ?? 0).toBeGreaterThanOrEqual(10)
    expect(pdf.byteLength).toBeGreaterThan(3000)
  })
})
