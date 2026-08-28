import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The canonical card JSON Schema (`shared/cards/schemas.json`, repo root),
 * loaded at RUNTIME — the same way `scripts/generate-card-schemas.mjs` reads
 * it — never as a compile-time import.
 *
 * Why that distinction is load-bearing: the file lives ABOVE the app root, so
 * it is outside the frontend image's Docker build context, and Next 16.3's
 * `next build` type-checks spec files. A static `import … from
 * '../../../../../shared/cards/schemas.json'` in any spec therefore fails the
 * production image build with TS2307 while passing everywhere the repo is
 * checked out whole (local, CI test jobs). The specs only ever cast the JSON
 * to their own interfaces, so a typed import bought nothing a runtime read
 * loses.
 *
 * Resolved by walking up from `process.cwd()` rather than `import.meta.url`:
 * under happy-dom specs `import.meta.url` is an http-scheme URL and
 * `fileURLToPath` throws.
 */
export function loadCardJsonSchema(): unknown {
  let dir = process.cwd()
  for (;;) {
    const candidate = join(dir, 'shared', 'cards', 'schemas.json')
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8'))
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`shared/cards/schemas.json not found in any directory above ${process.cwd()}`)
    }
    dir = parent
  }
}
