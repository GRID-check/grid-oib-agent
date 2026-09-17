/**
 * The automatic JSX runtime for the PDF renderers — and ONLY for them.
 *
 * Every file that builds a `@react-pdf/renderer` tree carries
 * `@jsxImportSource @/lib/pdf/pdf-jsx-runtime`, so its JSX compiles to the
 * `jsx`/`jsxs` below instead of the ambient `react/jsx-runtime`.
 *
 * Why: the production server bundle maps the ambient runtime to Next's
 * vendored React 19, whose elements carry
 * `Symbol.for('react.transitional.element')`. `@react-pdf/renderer` resolves
 * outside the bundle to the root React 18, whose reconciler accepts only
 * `Symbol.for('react.element')`. One JSX node on the ambient runtime therefore
 * killed every production PDF with minified React #31
 * ("object with keys {$$typeof, type, key, ref, props}") while the suite stayed
 * green, because vitest resolves a single React copy. Minting here, with the
 * explicitly imported copy, keeps element identity on the renderer's side no
 * matter what the bundle maps the ambient runtime to next.
 *
 * `pdf-element-identity.spec.ts` pins both halves: that this factory mints
 * `react.element` symbols, and that every renderer file still carries the
 * pragma that routes it here.
 */

import React from 'react'

/** Everything the automatic runtime passes: the props, children included. */
type JsxProps = Record<string, unknown>

/**
 * `jsx(type, props, key)` — the automatic runtime's call shape. Children
 * always arrive inside `props`, never as trailing arguments, so this is a
 * `createElement` with the key folded back into the config.
 */
export function jsx(
  type: React.ElementType,
  props: JsxProps | null,
  key?: React.Key
): React.ReactElement {
  const config: JsxProps = { ...(props ?? {}) }
  if (key !== undefined) config.key = key
  // One boundary: the emitted call already guarantees the contract, and
  // `createElement`'s overloads cannot express "whatever the transform
  // passed" — every component on this path type-checks at its own call site.
  const factory = React.createElement as (
    type: React.ElementType,
    props?: JsxProps | null
  ) => React.ReactElement
  return factory(type, config)
}

/** The multi-child spelling; identical, because children ride in `props`. */
export const jsxs = jsx

/** Fragments come from the same copy, or they are foreign too. */
export const Fragment = React.Fragment
