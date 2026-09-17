/**
 * The development spelling of the PDF JSX runtime.
 *
 * Development transforms (dev server, vitest) import `jsxDEV` from
 * `<import-source>/jsx-dev-runtime` instead of `jsx` from `jsx-runtime`.
 * Same factory, same copy — see `jsx-runtime.ts` for why the copy matters.
 */

export { Fragment, jsx, jsxs } from './jsx-runtime'
import { jsx } from './jsx-runtime'
import type React from 'react'

/** `__source`/`__self` are debug metadata; the renderer needs neither. */
export function jsxDEV(
  type: React.ElementType,
  props: Record<string, unknown> | null,
  key?: React.Key
): React.ReactElement {
  return jsx(type, props, key)
}
