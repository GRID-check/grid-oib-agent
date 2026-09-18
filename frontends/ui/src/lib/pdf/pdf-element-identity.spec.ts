/**
 * @vitest-environment node
 *
 * The PDF element-identity contract, both halves.
 *
 * The five renderer files build their tree through `@jsxImportSource
 * @/lib/pdf/pdf-jsx-runtime` so every node is minted by the explicitly
 * imported React copy — the copy `@react-pdf/renderer` validates against.
 * The production bundle maps the ambient JSX runtime to a different React
 * copy, and one node minted there fails every production PDF with minified
 * React #31 while this suite stays green. These tests pin the factory and the
 * pragma; the real-render specs pin the bytes.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { Fragment, jsx, jsxs } from './pdf-jsx-runtime/jsx-runtime'
import { jsxDEV } from './pdf-jsx-runtime/jsx-dev-runtime'

/** The tag the renderer accepts — React 18's, not the vendored copy's. */
const REACT_ELEMENT = Symbol.for('react.element')

/** Read the tag off an element without pretending it is public API. */
const tagOf = (element: React.ReactElement): symbol =>
  (element as unknown as { $$typeof: symbol }).$$typeof

describe('the pdf jsx factory mints the renderer copy elements', () => {
  it('jsx tags its elements react.element', () => {
    expect(tagOf(jsx(React.Fragment, { children: 'x' }))).toBe(REACT_ELEMENT)
  })

  it('jsxs tags its elements react.element', () => {
    expect(tagOf(jsxs(React.Fragment, { children: ['x', 'y'] }))).toBe(REACT_ELEMENT)
  })

  it('jsxDEV tags its elements react.element', () => {
    expect(tagOf(jsxDEV(React.Fragment, { children: 'x' }))).toBe(REACT_ELEMENT)
  })

  it('carries children and the static key through to the element', () => {
    const element = jsx(React.Fragment, { children: ['a', 'b'] }, 'k')
    expect(element.key).toBe('k')
    expect(element.props.children).toEqual(['a', 'b'])
  })

  it('re-exports the same Fragment the renderer copy owns', () => {
    expect(Fragment).toBe(React.Fragment)
  })
})

describe('every renderer file routes its JSX through the factory', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const renderers = [
    'blocks-to-pdf.tsx',
    'branding.tsx',
    'printable-text.tsx',
    'ReactPdfDocument.tsx',
    join('..', 'diagrams', 'svg-to-pdf.tsx'),
  ]
  const pragma = '@jsxImportSource @/lib/pdf/pdf-jsx-runtime'

  for (const file of renderers) {
    it(`${file} carries the pragma`, () => {
      const source = readFileSync(join(here, file), 'utf8')
      expect(source).toContain(pragma)
    })
  }
})
