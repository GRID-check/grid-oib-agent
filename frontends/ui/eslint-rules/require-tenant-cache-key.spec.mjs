/**
 * The guard on the guard.
 *
 * `grid/require-tenant-cache-key` has the two failure modes every allowlisted
 * rule has, and both are silent. Too permissive and the tenant leak it exists to
 * stop walks back in wearing a key-builder; too strict and the next author
 * reaches for `eslint-disable`, which is worse than not having the rule at all
 * because it looks like the rule ran.
 *
 * So the valid cases below are every key SHAPE that is actually in `lib/` today
 * — inline template, builder function, local const, nullish default — and the
 * invalid ones are the shapes a leak arrives in.
 */

import { RuleTester } from 'eslint'
import { describe, expect, it } from 'vitest'
import rule from './require-tenant-cache-key.mjs'
import { GLOBAL_CACHE_KEYS } from './global-cache-keys.mjs'

const ruleTester = new RuleTester({
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

const withImport = (body) => `import { getCached, setCached } from '@/lib/cache'\n${body}`

// `RuleTester.run` declares its own suite, so it has to sit at the top level.
ruleTester.run('require-tenant-cache-key', rule, {
  valid: [
    // The inline template, which is most of the call sites.
    withImport("getCached(`orgname:${organizationId}`, 1000, load)"),
    // Two segments, org first — `membership-role:` and `budgetlimits:`.
    withImport("getCached(`membership-role:${organizationId}:${userId}`, 1000, load)"),
    // A nullish default around the org, which is how the anonymous deployment
    // is spelled in `lib/project-profile/prompt-view.ts`.
    withImport("getCached(`promptview:${organizationId ?? ANON}:${projectId}`, 1000, load)"),
    // Off the session rather than a parameter.
    withImport("getCached(`websearch:${session.organizationId}`, 1000, load)"),
    // The key-builder pattern, which is the one the repo prefers.
    withImport(
      'const orgNameCacheKey = (organizationId) => `orgname:${organizationId}`\n' +
        'getCached(orgNameCacheKey(id), 1000, load)',
    ),
    // The same, as a function declaration with a guard clause before the return.
    withImport(
      'function limitsCacheKey(organizationId, unit) {\n' +
        '  if (!unit) return `budgetlimits:${organizationId}:credit`\n' +
        '  return `budgetlimits:${organizationId}:${unit}`\n' +
        '}\n' +
        'getCached(limitsCacheKey(id, unit), 1000, load)',
    ),
    // A local const, as in `model-config/org-catalog.ts`.
    withImport(
      'const cacheKey = `orgmodelcatalog:${organizationId}:${credential.id}`\n' +
        'getCached(cacheKey, 1000, load)',
    ),
    // `orgId` is the same word.
    withImport("getCached(`zdronly:${orgId}`, 1000, load)"),
    // A constant key that IS one per deployment, and says why in the allowlist.
    withImport("getCached('openrouter:catalog', 1000, load)"),
    withImport("const KEY = 'platformpricing:active'\ngetCached(KEY, 1000, load)"),
    // `setCached` is checked on the same terms.
    withImport("setCached(`ratelimit:${organizationId}:${userId}`, 1, 1000)"),
    // Invalidation is deliberately out of scope: dropping too much is a
    // performance bug, not a cross-tenant read. A callback parameter as the key
    // (`.map((key) => invalidateCached(key))`) is exactly the shape this
    // exclusion keeps quiet.
    "import { invalidateCached, invalidateCachedPrefix } from '@/lib/cache'\n" +
      "invalidateCachedPrefix('budgetlimits:')\n" +
      'keys.map((key) => invalidateCached(key))',
    // A local function that merely SHARES the name is not this cache.
    'function getCached(key, ttl, load) { return load() }\ngetCached(`digest:${projectId}`, 1000, load)',
    // An aliased import is still the real thing, and still passes when scoped.
    "import { getCached as readThrough } from '@/lib/cache'\n" +
      'readThrough(`orgname:${organizationId}`, 1000, load)',
  ],
  invalid: [
    {
      // The bug from gotchas.md:36, in the diff that caused it.
      code: withImport('getCached(`promptview:${projectId}`, 1000, load)'),
      errors: [{ messageId: 'unscoped' }],
    },
    {
      // A constant key nobody wrote a reason for.
      code: withImport("getCached('platformlessons:digest:v2', 1000, load)"),
      errors: [{ messageId: 'unscoped' }],
    },
    {
      // A builder is not a free pass: this one leaves the org out.
      code: withImport(
        'const digestKey = (windowDays, topic) => `feedback:digest:${windowDays}:${topic}`\n' +
          'getCached(digestKey(30, topic), 1000, load)',
      ),
      errors: [{ messageId: 'unscoped' }],
    },
    {
      // One branch scoped and one not is still a leak, on the unscoped branch.
      code: withImport(
        'getCached(scoped ? `orgname:${organizationId}` : `orgname:global`, 1000, load)',
      ),
      errors: [{ messageId: 'unscoped' }],
    },
    {
      // `setCached` poisons the same key `getCached` reads.
      code: withImport('setCached(`directory:${userId}`, people, 1000)'),
      errors: [{ messageId: 'unscoped' }],
    },
    {
      // A key that arrives as a parameter cannot be read, and "I could not
      // tell" is the answer that hid the original bug.
      code: withImport('export const read = (key) => getCached(key, 1000, load)'),
      errors: [{ messageId: 'unreadable' }],
    },
    {
      // Nor can one built by a function from another module.
      code:
        "import { getCached } from '@/lib/cache'\n" +
        "import { keyFor } from './keys'\n" +
        'getCached(keyFor(projectId), 1000, load)',
      errors: [{ messageId: 'unreadable' }],
    },
  ],
})

describe('the global-key allowlist', () => {
  it('gives every entry a reason', () => {
    for (const [key, reason] of Object.entries(GLOBAL_CACHE_KEYS)) {
      expect(reason, `${key} has no reason`).toBeTruthy()
      // A sentence, not a word: "platform" explains nothing to the next reader.
      expect(reason.length, `${key}'s reason is too short to be one`).toBeGreaterThan(40)
    }
  })

  it('holds only constant keys — a key with a segment in it is not global', () => {
    for (const key of Object.keys(GLOBAL_CACHE_KEYS)) {
      expect(key, `${key} looks interpolated`).not.toMatch(/\$\{|\*/)
    }
  })
})
