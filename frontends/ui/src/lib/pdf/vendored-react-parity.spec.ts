/**
 * @vitest-environment node
 */
/**
 * The two Reacts in this process have to agree, or every server-side PDF is a
 * 500.
 *
 * Next vendors its own React (`next/dist/compiled/react`) and aliases every
 * `react`, `react/jsx-runtime` and `react-dom` import in the bundles it builds
 * to that copy — client layer included. The `react` in `node_modules` is
 * therefore NOT what our components are compiled against; it is what the
 * packages Next refuses to bundle resolve at runtime, and
 * `@react-pdf/renderer` is on Next's own default `serverExternalPackages`
 * list, so it is one of them.
 *
 * `@react-pdf/reconciler` then reads `React.version` from that copy and picks
 * one of three bundled reconcilers. React 18's carries
 * `Symbol.for('react.element')`; React 19's carries
 * `Symbol.for('react.transitional.element')`. Pick the wrong one and the
 * reconciler does not recognise a single element the app hands it — it sees a
 * plain object and throws React error #31, `Objects are not valid as a React
 * child (found: object with keys {$$typeof, type, key, ref, props})`. That is
 * a total failure of both PDF pipelines: the diagram export (#589) and the
 * deep-research report (#580), each of which files its PDF from a route
 * handler.
 *
 * Nothing else catches this. `tsc` sees one React. The other PDF specs import
 * `react` the way any spec does, so under Vitest both sides of the render
 * resolve to the same copy and agree no matter which one it is — they passed
 * green through the whole outage. This file is the one place that builds its
 * element tree with the React that PRODUCTION builds elements with and renders
 * it through the React the renderer will actually load, so a drift between the
 * two fails here rather than in a route handler.
 */

import { createRequire } from 'node:module'
import { renderToBuffer } from '@react-pdf/renderer'
import { Document, Page, Text } from '@react-pdf/renderer'
import { describe, expect, it } from 'vitest'
import appReact from 'react'

/**
 * Next's vendored React, loaded the way Node loads it — not imported.
 *
 * A bare `import` here would be resolved by Vite and could be aliased back to
 * the same copy the renderer sees, which would make this file assert that a
 * thing equals itself.
 */
const vendoredReact = createRequire(import.meta.url)(
  'next/dist/compiled/react',
) as typeof appReact

/** The `$$typeof` brand a React copy stamps on the elements it creates. */
const elementBrand = (react: typeof appReact): symbol | number =>
  (react.createElement('div') as unknown as { $$typeof: symbol | number }).$$typeof

describe('the React that renders PDFs', () => {
  it('brands elements the same way in the vendored and the installed copy', () => {
    expect(elementBrand(vendoredReact)).toBe(elementBrand(appReact))
  })

  it('renders a document built by the vendored React', async () => {
    const document = vendoredReact.createElement(
      Document,
      null,
      vendoredReact.createElement(Page, null, vendoredReact.createElement(Text, null, 'Piloti')),
    )

    // `renderToBuffer` is typed against the installed React's element type;
    // the point of the test is that it is handed the other copy's.
    const pdf = await renderToBuffer(document as Parameters<typeof renderToBuffer>[0])

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
