/**
 * The guard on the guard for `grid/require-tenant-scope`.
 *
 * The rule's whole value is in resolving the binding: a scope opener counts only
 * when it is an IMPORT from the real module, so a local function that shares the
 * name, or a member call that shares it, does not open a slot. That resolution
 * goes through the linter's scope manager, which is exactly the part a linter
 * upgrade could change underneath the rule — so the shapes below run under the
 * engine that runs the rule in `bun run lint`, oxlint.
 */

import { RuleTester } from 'oxlint/plugins-dev'
import rule from './require-tenant-scope.mjs'

const ruleTester = new RuleTester({
  eslintCompat: true,
  languageOptions: { sourceType: 'module', parserOptions: { lang: 'tsx' } },
})

const PAGE = 'src/app/projects/[id]/page.tsx'

// `RuleTester.run` declares its own suite, so it has to sit at the top level.
ruleTester.run('require-tenant-scope', rule, {
  valid: [
    {
      // The pattern: the page body runs inside withPageSession's slot.
      filename: PAGE,
      code:
        "import { withPageSession } from '@/lib/auth/require-auth'\n" +
        'export default function Page() { return withPageSession(async (session) => session) }',
    },
    {
      // runWithTenantSlot for a nullable session, resolving inside the callback.
      filename: PAGE,
      code:
        "import { runWithTenantSlot } from '@/lib/db/tenant-context'\n" +
        "import { getGridSession } from '@/lib/auth/session'\n" +
        'export default function Page() { return runWithTenantSlot(async () => getGridSession()) }',
    },
    {
      // An aliased import is still the real opener.
      filename: PAGE,
      code:
        "import { runWithTenantSlot as slot } from '@/lib/db/tenant-context'\n" +
        "import { getGridSession } from '@/lib/auth/session'\n" +
        'export default function Page() { return slot(async () => getGridSession()) }',
    },
    {
      // Route handlers get their slot from the route factories.
      filename: 'src/app/api/projects/route.ts',
      code: "import { getGridSession } from '@/lib/auth/session'\nexport const GET = () => getGridSession()",
    },
    {
      // Library code inherits its caller's scope by design.
      filename: 'src/lib/projects/service.ts',
      code: "import { getGridSession } from '@/lib/auth/session'\nexport const load = () => getGridSession()",
    },
    {
      // Specs are not entry points.
      filename: 'src/app/projects/page.spec.tsx',
      code: "import { getGridSession } from '@/lib/auth/session'\ngetGridSession()",
    },
  ],
  invalid: [
    {
      // Issues #342 and #344: the session resolved with no slot open.
      filename: PAGE,
      code:
        "import { getGridSession } from '@/lib/auth/session'\n" +
        'export default async function Page() { const session = await getGridSession(); return session }',
      errors: [{ messageId: 'unscoped' }],
    },
    {
      // A server action is an entry point too.
      filename: 'src/app/projects/actions.ts',
      code:
        "'use server'\nimport { requireGridSession } from '@/lib/auth/session'\n" +
        'export async function rename() { return requireGridSession() }',
      errors: [{ messageId: 'unscoped' }],
    },
    {
      // A local function that merely shares the opener's NAME opens nothing.
      filename: PAGE,
      code:
        "import { getGridSession } from '@/lib/auth/session'\n" +
        'const withPageSession = (fn) => fn()\n' +
        'export default function Page() { return withPageSession(() => getGridSession()) }',
      errors: [{ messageId: 'unscoped' }],
    },
    {
      // Nor does an import of that name from somewhere else.
      filename: PAGE,
      code:
        "import { getGridSession } from '@/lib/auth/session'\n" +
        "import { withTenant } from './local-helpers'\n" +
        'export default function Page() { return withTenant(() => getGridSession()) }',
      errors: [{ messageId: 'unscoped' }],
    },
    {
      // Nor a member call that shares the name.
      filename: PAGE,
      code:
        "import { getGridSession } from '@/lib/auth/session'\n" +
        'export default function Page() { return helpers.withTenant(() => getGridSession()) }',
      errors: [{ messageId: 'unscoped' }],
    },
  ],
})
