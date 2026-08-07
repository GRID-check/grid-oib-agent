/**
 * Every entry point must open a tenant scope before it touches a session.
 *
 * Row-level security means a query with no scope fails closed at runtime with
 * `MissingTenantContextError`. The scope is ambient — carried in
 * AsyncLocalStorage so repository signatures do not each grow an
 * `organizationId` parameter a caller could pass wrongly — which means exactly
 * one thing has to be true for the whole codebase to work: **something opened a
 * slot for this request.**
 *
 * Route handlers get that from the three factories in `lib/api/handler.ts`.
 * Server components and server actions have no factory, so for them it is
 * `withPageSession` (or `runWithTenantSlot` directly, when the session is
 * nullable). Nothing was doing it, `enterTenantContext` fell back to
 * `storage.enterWith`, and that binding does not survive the render — which is
 * issues #342 and #344, the same bug twice.
 *
 * So this rule checks the ~25 places that can get it wrong rather than the ~190
 * queries that merely inherit the consequences. An earlier version did the
 * opposite: it demanded `withTenant` around every `getDb()` use, which would
 * have forced the parameter-threading the tenant-context module was designed to
 * avoid. Checking the entry points is both smaller and the actual invariant.
 */

/** Session accessors that only mean anything inside a slot. */
const SESSION_ACCESSORS = new Set([
  'requireAuthorizedPageSession',
  'requireAuthorizedSession',
  'getGridSession',
  'requireGridSession',
])

/** Calls that open (or are given) a scope. */
const SCOPE_OPENING = new Set([
  'runWithTenantSlot',
  'withPageSession',
  'tenantSlotRoute',
  'withTenant',
  'withPlatformAccess',
  'withOptionalTenant',
])

/** Modules the real scope openers come from. */
const SCOPE_MODULES = new Set(['@/lib/db/tenant-context', '@/lib/auth/require-auth'])

/**
 * The name a call is made through, when the callee is a bare identifier.
 *
 * Member calls (`something.withTenant(...)`) return null on purpose: only a
 * direct call to an imported binding is trusted, and a property that merely
 * shares the name is not that.
 */
function calleeIdentifier(node) {
  if (!node || node.type !== 'CallExpression') return null
  return node.callee.type === 'Identifier' ? node.callee : null
}

/**
 * True when `identifier` resolves to an import of a real scope opener.
 *
 * Matching on the NAME alone would accept a local `const withTenant = …` that
 * does nothing, and a rule that can be satisfied by naming a variable well is
 * not a rule. Resolving the binding also means an aliased import
 * (`import { withTenant as scope }`) still counts, because what matters is
 * where the function came from, not what this file calls it.
 */
function resolvesToScopeOpener(identifier, sourceCode) {
  const scope = sourceCode.getScope ? sourceCode.getScope(identifier) : null
  if (!scope) return false
  let variable = null
  for (let current = scope; current && !variable; current = current.upper) {
    variable = current.variables.find((candidate) => candidate.name === identifier.name) ?? null
  }
  if (!variable) return false
  return variable.defs.some((def) => {
    if (def.type !== 'ImportBinding') return false
    const source = def.parent?.source?.value
    if (!SCOPE_MODULES.has(source)) return false
    const imported = def.node.imported?.name ?? def.node.local?.name
    return SCOPE_OPENING.has(imported)
  })
}

/** True when `node` is lexically inside a callback passed to a scope opener. */
function insideScope(node, sourceCode) {
  let current = node
  while (current) {
    const parent = sourceCode.getParent ? sourceCode.getParent(current) : current.parent
    if (!parent) return false
    if (
      (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') &&
      parent.type === 'CallExpression' &&
      parent.arguments.includes(current)
    ) {
      const callee = calleeIdentifier(parent)
      if (callee && resolvesToScopeOpener(callee, sourceCode)) return true
    }
    current = parent
  }
  return false
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require server components and server actions to resolve their session inside a tenant slot',
    },
    schema: [],
    messages: {
      unscoped:
        'This resolves a session outside a tenant slot. A server component gets no route factory, ' +
        'so nothing opens one for it, and every query underneath will fail closed under row-level ' +
        'security (MissingTenantContextError) — see issues #342 and #344. Wrap the body in ' +
        'withPageSession(async (session) => …), or runWithTenantSlot(async () => …) when the ' +
        'session is nullable.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()
    const filename = context.filename ?? context.getFilename()

    // Only entry points: pages, layouts, templates and server actions. Route
    // handlers are covered by their factories, and library code inherits the
    // caller's scope by design.
    const isEntryPoint =
      /[\\/]src[\\/]app[\\/]/.test(filename) && !/[\\/]route\.tsx?$/.test(filename) && !/\.spec\.tsx?$/.test(filename)
    if (!isEntryPoint) return {}

    return {
      CallExpression(node) {
        const callee = calleeIdentifier(node)
        if (!callee || !SESSION_ACCESSORS.has(callee.name)) return
        // `withPageSession` resolves the session itself, inside its own slot.
        if (insideScope(node, sourceCode)) return
        context.report({ node, messageId: 'unscoped' })
      },
    }
  },
}
