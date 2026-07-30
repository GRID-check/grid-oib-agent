/**
 * Typed plumbing for the zustand store mocks that specs set up.
 *
 * A spec almost never wants to build a whole store: it fixtures the handful of
 * fields the component under test actually selects. Historically that was
 * expressed as `(selector: (s: any) => any)`, which switched off type checking
 * for the fixture as well as the selector — a renamed store field left the test
 * green while the component broke.
 *
 * `StoreSelector` keeps the mock's signature identical to the real hook, and
 * `asStoreState` is the single audited place where a partial fixture widens to
 * the full store type. Because the fixture is constrained to
 * `DeepPartial<TState>`, every field name and value type is still checked
 * against the real store — omissions are allowed, mistakes are not.
 */

/**
 * A partial view of `T` that stays partial all the way down, leaving functions
 * and arrays usable: array elements become deep-partial too, so a fixture can
 * list half-built rows, while function properties keep their real signature.
 */
export type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer TElement>
    ? ReadonlyArray<DeepPartial<TElement>>
    : T extends Date
      ? T
      : T extends object
        ? { [K in keyof T]?: DeepPartial<T[K]> }
        : T

/** A zustand selector exactly as the real store hook types it. */
export type StoreSelector<TState> = (state: TState) => unknown

/**
 * Hand a deliberately partial fixture to a selector that expects the whole
 * store. The assertion is confined to this helper: callers still get their
 * fixture checked field-by-field against the real store type.
 */
export const asStoreState = <TState>(fixture: DeepPartial<TState>): TState =>
  fixture as unknown as TState
