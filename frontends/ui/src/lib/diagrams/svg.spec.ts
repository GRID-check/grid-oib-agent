/**
 * @vitest-environment node
 */
/**
 * What a stored SVG is allowed to be.
 *
 * These bytes arrive from a browser and are served back to browsers, so an
 * unvalidated one is stored XSS with a `documents` row and a preview pane. Every
 * rule in `svg.ts` gets a case here that FAILS, by name, because a validator
 * tested only on good input is a validator whose deny-list is never exercised.
 *
 * The last block is the other half of the design and the one that survives a
 * gap in the deny-list: what is stored is written from an allow-list, so an
 * attribute nobody thought to refuse is simply not carried across.
 */
import { describe, expect, it } from 'vitest'
import { MAX_DIAGRAM_SVG_BYTES, MAX_DIAGRAM_SVG_DEPTH } from './diagram-sources'
import {
  DIAGRAM_SVG_REJECTIONS,
  DiagramSvgError,
  acceptDiagram,
  attributeOf,
  diagramSourceOf,
  parseDiagramSvg,
  serializeDiagramSvg,
  withDiagramMarking,
} from './svg'

const OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">'

/**
 * The marking every stored diagram carries, as a fixture.
 *
 * Marker strings rather than the real dictionary line and the real
 * `aiProvenanceMarking` output, for the reason `markdown-pdf.spec.ts` gives
 * about its own placeholder: a test that reads the production copy back passes
 * just as well when the module hardcodes a sentence of its own, which is the
 * failure a required argument exists to prevent. What the marking really says
 * is asserted where it is really produced — `filing.spec.ts`, on the bytes that
 * reach the object store.
 */
const MARKING = { notice: 'a machine drew this', provenance: 'MARK=yes' }

/**
 * An SVG whose deepest element sits at `depth`, counting the root as 1.
 *
 * Nesting rather than size is what this builds, because the two budgets are
 * independent: 5000 levels is ~35 KB, which is 3% of the byte cap.
 */
function nested(depth: number): string {
  const groups = depth - 2
  return `${OPEN}${'<g>'.repeat(groups)}<rect width="1" height="1"/>${'</g>'.repeat(groups)}</svg>`
}

function rejection(svg: string): string {
  try {
    parseDiagramSvg(svg)
  } catch (error) {
    if (error instanceof DiagramSvgError) return error.rejection
    throw error
  }
  throw new Error('expected a rejection, and the parser accepted it')
}

describe('what is refused, by name', () => {
  it('refuses nothing at all', () => {
    expect(rejection('')).toBe('empty')
  })

  it('refuses more bytes than the budget', () => {
    // The cap is a REFUSAL BUDGET, not a guess at what diagrams weigh: the parse
    // happens on the caller's chosen length before anything else does.
    const filler = 'a'.repeat(MAX_DIAGRAM_SVG_BYTES)
    expect(rejection(`${OPEN}<desc>${filler}</desc></svg>`)).toBe('too-large')
  })

  it('refuses a script', () => {
    expect(rejection(`${OPEN}<script>alert(1)</script></svg>`)).toBe('script-element')
  })

  it('refuses a script whatever its case', () => {
    // XML is case-sensitive and `<SCRIPT>` is a different element to an XML
    // parser — but not to a browser recovering from a content-type sniff.
    expect(rejection(`${OPEN}<SCRIPT>alert(1)</SCRIPT></svg>`)).toBe('script-element')
  })

  it('refuses a foreignObject', () => {
    // Arbitrary HTML inside a file that is served back to browsers, and the one
    // thing `@react-pdf/renderer` cannot draw at all. Mermaid emits these by
    // default, which is why the client renderer turns `htmlLabels` off.
    expect(rejection(`${OPEN}<foreignObject><b>hi</b></foreignObject></svg>`)).toBe('foreign-object')
  })

  it('refuses a stylesheet', () => {
    // Refused rather than sanitised: a CSS parser is a second place external
    // references can hide, and the PDF cannot apply CSS at any price.
    expect(rejection(`${OPEN}<style>.a{fill:red}</style></svg>`)).toBe('style-element')
  })

  it('refuses an event handler', () => {
    expect(rejection(`${OPEN}<rect width="1" height="1" onload="alert(1)"/></svg>`)).toBe(
      'event-handler-attribute',
    )
  })

  it('refuses an external href', () => {
    expect(rejection(`${OPEN}<a href="https://evil.example"><rect width="1" height="1"/></a></svg>`)).toBe(
      'external-reference',
    )
  })

  it('refuses an external xlink:href', () => {
    expect(rejection(`${OPEN}<rect width="1" height="1" xlink:href="//evil.example"/></svg>`)).toBe(
      'external-reference',
    )
  })

  it('allows a fragment href, which is the only reference a self-contained file makes', () => {
    // Not a rejection test by accident: if the href rule refused fragments too,
    // every arrowhead and gradient in a mermaid diagram would be refused with it.
    expect(() => parseDiagramSvg(`${OPEN}<rect width="1" height="1" clip-path="url(#c)"/></svg>`)).not.toThrow()
  })

  it('refuses an external url() inside an attribute value', () => {
    // The functional-IRI form is how a reference hides in a value rather than in
    // a name, so the check is on the value and applies to every attribute.
    expect(rejection(`${OPEN}<rect width="1" height="1" fill="url(https://evil.example/x)"/></svg>`)).toBe(
      'external-reference',
    )
  })

  it('refuses a javascript: value', () => {
    expect(rejection(`${OPEN}<rect width="1" height="1" fill="javascript:alert(1)"/></svg>`)).toBe(
      'external-reference',
    )
  })

  it('refuses an external url() smuggled through a style attribute', () => {
    // The style attribute is FLATTENED rather than dropped, so it has to be
    // refused on the same terms as the attribute form — or `fill: url(...)`
    // would be refused in one spelling and admitted in the other.
    expect(rejection(`${OPEN}<rect width="1" height="1" style="fill:url(https://evil.example/x)"/></svg>`)).toBe(
      'external-reference',
    )
  })

  it('refuses a DOCTYPE, which is what makes XXE unrepresentable', () => {
    expect(rejection('<!DOCTYPE svg SYSTEM "http://evil.example/x.dtd">' + OPEN + '</svg>')).toBe(
      'doctype-or-entity',
    )
  })

  it('refuses an entity declaration, which is what makes billion-laughs unrepresentable', () => {
    expect(rejection('<!ENTITY lol "lol">' + OPEN + '</svg>')).toBe('doctype-or-entity')
  })

  it('refuses an entity reference nothing defines', () => {
    expect(rejection(`${OPEN}<desc>&lol;</desc></svg>`)).toBe('malformed-xml')
  })

  it('refuses a mismatched closing tag', () => {
    expect(rejection(`${OPEN}<g></rect></svg>`)).toBe('malformed-xml')
  })

  it('refuses an unclosed element', () => {
    expect(rejection(`${OPEN}<g>`)).toBe('malformed-xml')
  })

  it('refuses an unquoted attribute value', () => {
    expect(rejection('<svg viewBox=0 0 100 50></svg>')).toBe('malformed-xml')
  })

  it('refuses content after the root element', () => {
    expect(rejection(`${OPEN}</svg><svg/>`)).toBe('malformed-xml')
  })

  it('refuses a root that is not an svg', () => {
    expect(rejection('<html><body/></html>')).toBe('not-svg')
  })

  it('refuses an element it does not draw, rather than dropping it', () => {
    // Elements carry geometry, so dropping one files a diagram that is missing
    // part of the picture and says nothing about it. Attributes are dropped;
    // elements are refused. That asymmetry is the rule.
    expect(rejection(`${OPEN}<image width="1" height="1"/></svg>`)).toBe('unsupported-element')
  })

  it('refuses a diagram with no viewport', () => {
    // A browser invents 300x150 for a sizeless <svg> and the PDF cannot: it
    // needs a box to fit the drawing into, and a guessed one crops the artifact
    // that goes to the Behörde while the preview looks right.
    expect(rejection('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')).toBe(
      'missing-viewport',
    )
  })

  it('accepts a sizeless viewBox-less svg that states width and height', () => {
    expect(parseDiagramSvg('<svg width="80" height="40"><rect width="1" height="1"/></svg>').viewport).toEqual({
      width: 80,
      height: 40,
      viewBox: '0 0 80 40',
    })
  })

  it('refuses a source longer than its kind allows', () => {
    expect(() =>
      acceptDiagram(
        { svg: `${OPEN}</svg>`, sourceKind: 'mermaid', source: 'x'.repeat(64 * 1024) },
        MARKING,
      ),
    ).toThrow(/source-too-large/)
  })

  it('refuses a tree nested past the depth bound', () => {
    // Depth is its own budget: `parseElement`, `refuseUnsupportedElements`,
    // `serializeNode` and `toPdfNode` each recurse once per level, so the stack
    // — not the byte cap — is what a deep document exhausts.
    expect(rejection(nested(MAX_DIAGRAM_SVG_DEPTH + 1))).toBe('too-deep')
  })

  it('accepts a tree exactly at the bound, so the bound is where it says it is', () => {
    // The pair is the test. Only the refusal would pass with the limit set to
    // zero, and a validator that refuses everything is not a validator.
    expect(() => parseDiagramSvg(nested(MAX_DIAGRAM_SVG_DEPTH))).not.toThrow()
  })

  it('refuses a depth no byte cap would ever catch, by name rather than by RangeError', () => {
    // The defect, as it was reproduced: depth 5000 is ~35 KB, well inside the
    // 1 MiB refusal budget, and it threw `RangeError: Maximum call stack size
    // exceeded`. A RangeError is not a `DiagramSvgError`, so the route answered
    // an untranslated `Internal server error` 500 — rendered inside a German
    // figcaption — to a request the module promises a named 400 for.
    const svg = nested(5000)
    expect(new TextEncoder().encode(svg).byteLength).toBeLessThan(MAX_DIAGRAM_SVG_BYTES)
    expect(rejection(svg)).toBe('too-deep')
  })

  it('refuses a metadata block anywhere but the root', () => {
    // `<metadata>` is allow-listed for the ONE position this module writes it
    // in. Anywhere deeper it is a second source claim inside a file that is
    // supposed to carry exactly one, and the one the server validated.
    expect(
      rejection(`${OPEN}<g><metadata data-grid-diagram-source="mermaid">x</metadata></g></svg>`),
    ).toBe('unsupported-element')
  })

  it('has a case for every declared rejection', () => {
    // The tuple is the contract the route's copy is keyed by. A member with no
    // case here is a rule nobody has ever seen fire.
    const covered = new Set([
      'empty',
      'too-large',
      'malformed-xml',
      'doctype-or-entity',
      'not-svg',
      'missing-viewport',
      'script-element',
      'foreign-object',
      'style-element',
      'unsupported-element',
      'event-handler-attribute',
      'external-reference',
      'source-too-large',
      'too-deep',
    ])
    expect([...DIAGRAM_SVG_REJECTIONS].filter((member) => !covered.has(member))).toEqual([])
  })
})

describe('what is stored is written here, not copied from the request', () => {
  it('drops an attribute it does not know, without refusing the diagram', () => {
    const { root } = parseDiagramSvg(
      `${OPEN}<rect width="10" height="10" fill="#eee" data-mermaid="x" aria-label="y"/></svg>`,
    )
    const stored = serializeDiagramSvg(root)
    expect(stored).toContain('fill="#eee"')
    expect(stored).not.toContain('data-mermaid')
    expect(stored).not.toContain('aria-label')
  })

  it('flattens a style attribute into real attributes', () => {
    // Mermaid puts real paint in `style`, so dropping it files a diagram that
    // previews grey and prints blank.
    const { root } = parseDiagramSvg(`${OPEN}<rect width="10" height="10" style="fill:#123456;stroke-width:2"/></svg>`)
    const stored = serializeDiagramSvg(root)
    expect(stored).toContain('fill="#123456"')
    expect(stored).toContain('stroke-width="2"')
    expect(stored).not.toContain('style=')
  })

  it('lets a style declaration beat the attribute it collides with, exactly once', () => {
    // Two `fill`s on one element is not well-formed XML, so this is correctness
    // rather than tidiness — and the winner is CSS's own precedence.
    const { root } = parseDiagramSvg(`${OPEN}<rect width="1" height="1" fill="red" style="fill:blue"/></svg>`)
    const stored = serializeDiagramSvg(root)
    expect(stored.match(/fill=/g)).toHaveLength(1)
    expect(stored).toContain('fill="blue"')
  })

  it('adds the namespace a standalone .svg file needs', () => {
    const { root } = parseDiagramSvg('<svg viewBox="0 0 10 10"><rect width="1" height="1"/></svg>')
    expect(serializeDiagramSvg(root)).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('escapes text rather than carrying it through', () => {
    const { root } = parseDiagramSvg(`${OPEN}<text x="0" y="0">&lt;b&gt;&amp;</text></svg>`)
    const stored = serializeDiagramSvg(root)
    expect(stored).toContain('&lt;b&gt;&amp;')
    expect(stored).not.toContain('<b>')
  })
})

describe('the diagram carries its own source', () => {
  const submission = {
    svg: `${OPEN}<rect width="10" height="10"/></svg>`,
    sourceKind: 'mermaid' as const,
    source: 'graph TD\n  A --> B & "C"',
  }

  it('files the source inside the file, so it travels with the drawing', () => {
    // The person who needs to regenerate or hand-edit the diagram is the person
    // who has the file — possibly a year later, possibly outside this product.
    const accepted = acceptDiagram(submission, MARKING)
    expect(diagramSourceOf(accepted.root)).toEqual({ kind: 'mermaid', source: submission.source })
    expect(acceptDiagram(submission, MARKING).svg).toContain('<metadata data-grid-diagram-source="mermaid">')
  })

  it('survives a round trip through the parser it will be read back with', () => {
    const stored = acceptDiagram(submission, MARKING).svg
    expect(diagramSourceOf(parseDiagramSvg(stored).root)?.source).toBe(submission.source)
  })

  it('discards a metadata block the client sent and records its own', () => {
    // Whatever the client claimed the source was, what is stored is the source
    // the server validated against its own cap — the two must not disagree.
    const accepted = acceptDiagram(
      {
        ...submission,
        svg: `${OPEN}<metadata data-grid-diagram-source="mermaid">a lie</metadata><rect width="1" height="1"/></svg>`,
      },
      MARKING,
    )
    expect(accepted.svg).not.toContain('a lie')
    expect(diagramSourceOf(accepted.root)?.source).toBe(submission.source)
  })

  it('refuses a nested metadata rather than filing the source inside it', () => {
    // Proven before it was fixed: 200 KiB of client text inside
    // `<g><metadata data-grid-diagram-source="mermaid">…` was ACCEPTED against
    // a 32 KiB per-kind cap and serialised into the stored file, because
    // `withDiagramSource` filters only the root's children while the allow-list
    // and `keptAttributes` both worked at any depth. The stored file then
    // carried a second, unvalidated source the server never saw.
    const decoy = 'x'.repeat(200 * 1024)
    expect(() =>
      acceptDiagram(
        {
          ...submission,
          svg: `${OPEN}<g><metadata data-grid-diagram-source="mermaid">${decoy}</metadata></g></svg>`,
        },
        MARKING,
      ),
    ).toThrow(/unsupported-element/)
  })

  it('stores exactly one source, so nothing downstream has to pick', () => {
    const accepted = acceptDiagram(
      {
        ...submission,
        svg: `${OPEN}<metadata data-grid-diagram-source="mermaid">a lie</metadata><rect width="1" height="1"/></svg>`,
      },
      MARKING,
    )
    expect(accepted.svg.match(/data-grid-diagram-source/g)).toHaveLength(1)
  })

  it('reads the viewport off the root, for the page the PDF has to fit', () => {
    const accepted = acceptDiagram(submission, MARKING)
    expect(accepted.viewport).toEqual({ width: 100, height: 50, viewBox: '0 0 100 50' })
    expect(attributeOf(accepted.root, 'viewBox')).toBe('0 0 100 50')
  })
})

describe('the stored diagram says a machine drew it', () => {
  const submission = {
    svg: `${OPEN}<rect width="10" height="10"/></svg>`,
    sourceKind: 'mermaid' as const,
    source: 'graph TD\n  A --> B',
  }

  it('survives the allow-list it is written back out through', () => {
    // The point of the whole choice. `svg.ts` serialises from an allow-list, so
    // a marking the serialiser does not know about is stripped on the way to
    // the object store while every assertion on the pre-serialisation tree goes
    // on passing. `<title>` and `<desc>` are already in `ELEMENT_GEOMETRY`, so
    // this survives with the allow-list widened by nothing at all.
    const stored = acceptDiagram(submission, MARKING).svg
    expect(stored).toContain('<title>a machine drew this</title>')
    expect(stored).toContain('<desc>MARK=yes</desc>')
  })

  it('is still there after the parser it will be read back with', () => {
    // A stored file is re-parsed on the regeneration path, and a marking that
    // the reader refuses is a file that cannot be opened by the product that
    // wrote it.
    const stored = acceptDiagram(submission, MARKING).svg
    const { root } = parseDiagramSvg(stored)
    expect(serializeDiagramSvg(root)).toContain('<title>a machine drew this</title>')
  })

  it('names the file before anything else, because the first title is the name', () => {
    // SVG names an element after its FIRST `<title>` child. A marking that came
    // after the drawing's own title would be in the file and absent from the
    // tooltip, the screen reader and every embedding surface — present and
    // invisible, which is the failure mode this whole change is about.
    const marked = withDiagramMarking(parseDiagramSvg(`${OPEN}<rect width="1" height="1"/></svg>`).root, MARKING)
    expect(marked.children[0]).toMatchObject({ name: 'title' })
    expect(marked.children[1]).toMatchObject({ name: 'desc' })
  })

  it('replaces what the client said about the file, and not what it said inside it', () => {
    // The same rule `withDiagramSource` applies to `<metadata>`, and the same
    // reason: what the file says about ITSELF is the server's statement. A
    // `<title>` nested in the drawing is a node label the diagram author wrote
    // and is none of this module's business.
    const accepted = acceptDiagram(
      {
        ...submission,
        svg: `${OPEN}<title>a person drew this</title><desc>honest</desc><g><title>Einreichung</title><rect width="1" height="1"/></g></svg>`,
      },
      MARKING,
    )
    expect(accepted.svg).not.toContain('a person drew this')
    expect(accepted.svg).not.toContain('<desc>honest</desc>')
    expect(accepted.svg).toContain('<title>Einreichung</title>')
  })

  it('escapes a marking rather than letting it close a tag', () => {
    // The notice is a dictionary string today, so this is not an injection the
    // product has — it is the reason the marking goes through `serializeNode`
    // like every other text node instead of being concatenated into the output.
    const accepted = acceptDiagram(submission, {
      notice: '</title><script>x()</script>',
      provenance: 'MARK=yes',
    })
    expect(accepted.svg).not.toContain('<script>')
    expect(accepted.svg).toContain('&lt;/title&gt;')
  })

  it('leaves the tree the PDF redraws unmarked', () => {
    // The PDF carries its own footer line and its own `Keywords`; `<title>` and
    // `<desc>` are not paint, so putting them in the tree `svg-to-pdf.tsx`
    // walks would add nothing there and make that module responsible for
    // skipping them.
    const accepted = acceptDiagram(submission, MARKING)
    expect(accepted.root.children.some((child) => child.kind === 'element' && child.name === 'title')).toBe(false)
  })
})
