/**
 * `Text`, with the WinAnsi transliteration already applied.
 *
 * `printable()` states the contract — every string that becomes a `Text` passes
 * through it — and the only way to hold a caller to that is to make the
 * component they already reach for do it. Applying the function at each call
 * site instead works exactly until the next `<Text>` is added, and the failure
 * mode is silent in the worst possible place: `≤ 40 m` renders as `d 40 m` in a
 * compliance document, the number beside it is still right, and nothing
 * anywhere goes red. A reader has no way to tell the limit was inverted.
 *
 * So the renderers import `Text` from here, not from `@react-pdf/renderer`.
 *
 * Only string children are rewritten. Nested elements — a run list, a citation
 * chip — pass through untouched: they are built from this same component and
 * are already safe, and a second pass would re-transliterate text that has
 * already been decomposed once.
 */

import React from 'react'
import { Link as PdfLink, Text as PdfText } from '@react-pdf/renderer'
import type { LinkProps, TextProps } from '@react-pdf/renderer'

import { printable } from './printable'

// `TextProps`, not `ComponentProps<typeof PdfText>`: the library types `Text`
// as a union with its SVG namesake, which has no `children` to narrow on.
export function Text({
  children,
  ...props
}: React.PropsWithChildren<TextProps>): React.JSX.Element {
  return (
    <PdfText {...props}>
      {React.Children.map(children, (child) =>
        typeof child === 'string' ? printable(child) : child
      )}
    </PdfText>
  )
}

/**
 * `Link`, transliterated like `Text`.
 *
 * A link is a second way a string reaches the page, and it was the way the
 * first pass missed: `Text` was wrapped, `Link` was not, so `≤ 40 m` inside a
 * link LABEL still printed as `d 40 m` while the identical text one word
 * earlier came out right. The href is deliberately NOT transliterated — an
 * address is machinery, not prose, and rewriting a character in it would break
 * the link instead of the glyph.
 */
export function Link({ children, ...props }: React.PropsWithChildren<LinkProps>): React.JSX.Element {
  return (
    <PdfLink {...props}>
      {React.Children.map(children, (child) =>
        typeof child === 'string' ? printable(child) : child
      )}
    </PdfLink>
  )
}
