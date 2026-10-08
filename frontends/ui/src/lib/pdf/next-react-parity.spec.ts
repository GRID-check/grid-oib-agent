/**
 * @vitest-environment node
 *
 * react-pdf renders what the Next server builds, under the Reacts production
 * actually pairs.
 *
 * In `next start`, a route handler's `React.createElement` is Next's vendored
 * React (`next/dist/compiled/react`), while `@react-pdf/renderer` is a server
 * external and loads `react` from `node_modules`. With `node_modules` on React
 * 18 the two disagreed on what an element is, and every markdown → PDF render
 * in production failed with "Minified React error #31 … object with keys
 * {$$typeof, type, key, ref, props}" — every filed deep-research report,
 * whatever it contained (#675-#677, #699-#705, #713, #714). The rest of this
 * suite could not see it: vitest resolves one `react` for both sides.
 *
 * This file builds the element with the React Next builds with, and renders
 * it with react-pdf as installed. It failed on the React 18 tree.
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type CreateElement = (type: unknown, props: object | null, ...children: unknown[]) => unknown

describe('react-pdf and the React Next compiles route handlers against', () => {
  it('renders an element Next built into a PDF', async () => {
    const nextReact = require('next/dist/compiled/react') as { createElement: CreateElement }
    const { Document, Page, Text, renderToBuffer } = await import('@react-pdf/renderer')
    const h = nextReact.createElement
    const element = h(Document, null, h(Page, null, h(Text, null, 'OIB-Richtlinie 2 – Brandschutz')))

    const pdf = await renderToBuffer(element as Parameters<typeof renderToBuffer>[0])

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('agrees with Next on the React major version', () => {
    const major = (version: string) => version.split('.')[0]
    const nextReact = require('next/dist/compiled/react') as { version: string }
    const pdfRequire = createRequire(require.resolve('@react-pdf/renderer'))
    const pdfReact = pdfRequire('react') as { version: string }
    expect(major(pdfReact.version)).toBe(major(nextReact.version))
  })
})
