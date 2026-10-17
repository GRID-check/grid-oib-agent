/**
 * Whether two values say the same thing: the same value, or two plain objects
 * or arrays with the same content, compared by their JSON. For the small,
 * JSON-shaped values a selector or a merge compares (a summary of who is in a
 * room, a row's metadata), where a value rebuilt from the same facts must count
 * as unchanged. Not for values JSON cannot tell apart (a Map, a Date against
 * its string, keys in another order).
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
