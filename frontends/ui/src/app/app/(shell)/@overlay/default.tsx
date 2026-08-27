/**
 * The `@overlay` slot when no overlay route is active — nothing.
 *
 * The slot exists so the Archiv and the Postfach can rise as sheets above the
 * current page via intercepting routes (`(.)archiv`, `(.)inbox`) while keeping
 * their real URLs. Everywhere else it must render null, or every page would
 * carry a phantom sibling.
 */
export default function Default(): null {
  return null
}
