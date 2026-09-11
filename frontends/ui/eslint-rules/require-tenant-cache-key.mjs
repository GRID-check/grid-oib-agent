/**
 * Every shared-cache key must name the organization it belongs to.
 *
 * `getCached` returns BEFORE the loader runs. A key with no organization segment
 * therefore serves whichever tenant populated it first, to every tenant, and it
 * never enters the tenant scope where row-level security would have caught the
 * read. That is not hypothetical: `docs/contributing/gotchas.md:36` records it
 * as "Cached project context comes back belonging to another tenant", and
 * `frontends/ui/AGENTS.md` carries "Put the organization in every cache key" as
 * a rule precisely because a reviewer had to say it.
 *
 * A rule rather than a rule in prose because the failure is invisible in the
 * diff that causes it: `getCached(\`digest:${projectId}\`, …)` is locally correct
 * in every way a reader checks, and the tenant it leaks to is whichever one
 * happens to ask second. Keys were ad-hoc template strings at 28 call sites when
 * the caching audit counted them (`latency-and-caching-audit-2026-09.md` §4.4,
 * option E3), with nothing between a new one and production.
 *
 * ## What it checks, and what it deliberately does not
 *
 * Only `getCached` and `setCached`, and only when they resolve to an import of
 * the real `@/lib/cache` module — a local function that shares the name is not
 * this cache. `invalidateCached` and `invalidateCachedPrefix` are out of scope
 * on purpose: an under-scoped DELETE drops too much and costs a loader call,
 * which is a performance bug, not a cross-tenant read. Scoping the rule to the
 * two functions that can SERVE another tenant's value is what keeps it from
 * reporting the legitimate prefix drops (`invalidateCachedPrefix('budgetlimits:')`)
 * and the `.map((key) => invalidateCached(key))` shapes, where the key is a
 * callback parameter and no static rule can say what it holds.
 *
 * The check is on the key's SHAPE, not on the value that reaches it. A key
 * built as `budgetlimits:${organizationId}:…` passes; whether the caller handed
 * `limitsCacheKey` a project id where an org id belonged is a question for the
 * type checker and for review. The shape is what the class of bug is made of.
 *
 * ## How a key is read
 *
 * The key argument is resolved through the pieces a key is actually built from:
 * a template literal is read directly, an identifier through its initializer,
 * and a call through the local key-builder's `return`. That last one matters
 * because the good pattern in this repo IS a builder (`orgNameCacheKey`,
 * `limitsCacheKey`, `promptViewCacheKey`), and a rule that only understood
 * inline templates would have pushed authors away from it.
 *
 * Three outcomes:
 *   - a segment naming an organization  → fine;
 *   - a constant string                 → fine only if `global-cache-keys.mjs`
 *                                         lists it, with its reason;
 *   - anything the rule cannot read     → reported, because "I could not tell"
 *                                         is the answer that hid the original bug.
 */

import { GLOBAL_CACHE_KEYS } from './global-cache-keys.mjs'

/** The two operations that can SERVE one tenant another tenant's value. */
const KEYED_OPERATIONS = new Set(['getCached', 'setCached'])

/** The module the real cache comes from. */
const CACHE_MODULE = '@/lib/cache'

/**
 * An expression that names an organization, after punctuation and case are
 * removed: `organizationId`, `organization_id`, `orgId`, `session.organizationId`,
 * `filters.organizationId ?? '*'`. Normalizing rather than listing spellings
 * means a member expression and a nullish default read the same as a bare
 * parameter, which is how they are all written in `lib/`.
 */
const ORG_SEGMENT = /organizationid|orgid/

/** Depth cap on binding/return resolution — a key is never four hops deep. */
const MAX_DEPTH = 4

const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '')

const namesAnOrganization = (node, sourceCode) => ORG_SEGMENT.test(normalize(sourceCode.getText(node)))

/** The variable `identifier` resolves to, walking out through enclosing scopes. */
function resolveVariable(identifier, sourceCode) {
  const scope = sourceCode.getScope ? sourceCode.getScope(identifier) : null
  if (!scope) return null
  for (let current = scope; current; current = current.upper) {
    const found = current.variables.find((candidate) => candidate.name === identifier.name)
    if (found) return found
  }
  return null
}

/** Every expression a function body can hand back, arrow shorthand included. */
function returnedExpressions(fn) {
  if (!fn) return []
  if (fn.body && fn.body.type !== 'BlockStatement') return [fn.body]
  const found = []
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return
    // Do not descend into a nested function: its returns are not this one's.
    if (node !== fn && /Function(Declaration|Expression)$/.test(node.type)) return
    if (node !== fn && node.type === 'ArrowFunctionExpression') return
    if (node.type === 'ReturnStatement' && node.argument) found.push(node.argument)
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach(walk)
      else if (child && typeof child.type === 'string') walk(child)
    }
  }
  walk(fn.body)
  return found
}

/** The function node a callee identifier resolves to, when it is a local one. */
function resolveLocalFunction(identifier, sourceCode) {
  const variable = resolveVariable(identifier, sourceCode)
  if (!variable) return null
  for (const def of variable.defs) {
    if (def.type === 'FunctionName') return def.node
    if (def.type === 'Variable' && def.node.init) {
      const init = def.node.init
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') return init
    }
  }
  return null
}

/**
 * Read one key expression.
 *
 * @returns {'scoped'|'global'|'unscoped'|'unreadable'} and, for `unscoped`, the
 *   literal string that has to be allowlisted is recoverable from the node.
 */
function classifyKey(node, sourceCode, depth) {
  if (!node || depth > MAX_DEPTH) return 'unreadable'

  if (node.type === 'TemplateLiteral') {
    if (node.expressions.length === 0) return classifyConstant(node.quasis[0].value.cooked)
    return node.expressions.some((expression) => namesAnOrganization(expression, sourceCode))
      ? 'scoped'
      : 'unscoped'
  }

  if (node.type === 'Literal' && typeof node.value === 'string') return classifyConstant(node.value)

  if (node.type === 'Identifier') {
    const variable = resolveVariable(node, sourceCode)
    const init = variable?.defs.find((def) => def.type === 'Variable' && def.node.init)?.node.init
    if (!init) return 'unreadable'
    return classifyKey(init, sourceCode, depth + 1)
  }

  if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
    const fn = resolveLocalFunction(node.callee, sourceCode)
    const returns = returnedExpressions(fn)
    if (returns.length === 0) return 'unreadable'
    return worstOf(returns.map((returned) => classifyKey(returned, sourceCode, depth + 1)))
  }

  // `a ? x : y` and `x ?? y` both have to hold, or one branch is the leak.
  if (node.type === 'ConditionalExpression') {
    return worstOf([
      classifyKey(node.consequent, sourceCode, depth + 1),
      classifyKey(node.alternate, sourceCode, depth + 1),
    ])
  }
  if (node.type === 'LogicalExpression') {
    return worstOf([
      classifyKey(node.left, sourceCode, depth + 1),
      classifyKey(node.right, sourceCode, depth + 1),
    ])
  }

  // String concatenation: one org-bearing half is enough, same as a template.
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    if (namesAnOrganization(node, sourceCode)) return 'scoped'
    return worstOf([
      classifyKey(node.left, sourceCode, depth + 1),
      classifyKey(node.right, sourceCode, depth + 1),
    ])
  }

  return 'unreadable'
}

const classifyConstant = (value) =>
  typeof value === 'string' && Object.hasOwn(GLOBAL_CACHE_KEYS, value) ? 'global' : 'unscoped'

const SEVERITY = { scoped: 0, global: 1, unscoped: 2, unreadable: 3 }
const worstOf = (results) => results.reduce((worst, next) => (SEVERITY[next] > SEVERITY[worst] ? next : worst), 'scoped')

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require an organization segment in every shared-cache key, or an allowlist entry',
    },
    schema: [],
    messages: {
      unscoped:
        'This cache key carries no organization segment. `getCached` returns before the loader runs, ' +
        "so the first tenant to populate this key serves its value to every other tenant, and the read " +
        'never enters a tenant scope where row-level security would catch it (gotchas.md:36). ' +
        'Interpolate the organization id into the key — `lib/project-profile/prompt-view.ts` is the ' +
        'pattern — or, if the value really is the same for the whole deployment, add the key to ' +
        'eslint-rules/global-cache-keys.mjs with the reason it is safe to share.',
      unreadable:
        'This rule cannot read the shape of this cache key, so it cannot tell whether it is partitioned ' +
        'by organization. Build the key in a template literal at the call site, or in a key-builder ' +
        'function in this file whose `return` is one, so the organization segment is visible to a ' +
        'reader and to this rule.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    /** True when `identifier` is an import of a keyed operation from the cache module. */
    const isCacheOperation = (identifier) => {
      if (!KEYED_OPERATIONS.has(identifier.name)) return false
      const variable = resolveVariable(identifier, sourceCode)
      if (!variable) return false
      return variable.defs.some((def) => {
        if (def.type !== 'ImportBinding') return false
        if (def.parent?.source?.value !== CACHE_MODULE) return false
        const imported = def.node.imported?.name ?? def.node.local?.name
        return KEYED_OPERATIONS.has(imported)
      })
    }

    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier') return
        if (!isCacheOperation(node.callee)) return
        const key = node.arguments[0]
        if (!key) return

        const verdict = classifyKey(key, sourceCode, 0)
        if (verdict === 'scoped' || verdict === 'global') return
        context.report({ node: key, messageId: verdict })
      },
    }
  },
}
