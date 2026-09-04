'use client'

import { useState } from 'react'

/**
 * Which way a drill-down just moved: `1` deeper, `-1` shallower, `0` neither.
 *
 * A hook rather than four lines in the pane because of how the four lines it
 * replaces failed. They were two `useRef`s written during render:
 *
 *     const navDirection = depth > prevDepthRef.current ? 1 : …
 *     prevDepthRef.current = depth
 *
 * React does not allow that, and it broke exactly as the rule says it will. A
 * render is not a commit. StrictMode invokes the function twice, and the second
 * pass compared the new depth against the value the first pass had just
 * written — so in development the direction was 0 on every navigation, and the
 * slide had no direction at all. Under concurrent rendering a render that is
 * thrown away still moves a ref the next one reads, so the same thing can
 * happen in production without StrictMode to make it obvious.
 *
 * This is React's documented shape for the same job: adjust state during render,
 * and let the re-render settle before anything commits. `previous` moves once
 * per COMMIT rather than once per render attempt, so a re-render for an
 * unrelated reason — a settling poll landing, a keystroke in the search field —
 * leaves the answer alone.
 *
 * Zero is a real answer and callers depend on it: the first paint has not
 * navigated anywhere, and a listing rendered by the server must not slide in
 * under a reader who has not asked for anything yet.
 */
export function useLevelDirection(depth: number): number {
  const [previous, setPrevious] = useState(depth)
  const [direction, setDirection] = useState(0)

  // Both `useState` calls run first, so the hook order is fixed whichever
  // branch this takes.
  if (previous === depth) return direction

  const next = depth > previous ? 1 : -1
  setPrevious(depth)
  setDirection(next)
  // React re-runs the component immediately and discards this output, so the
  // return is belt and braces — but a hook that is only correct on its second
  // pass is one refactor from being wrong.
  return next
}
