/**
 * Every database handle must be used inside a declared tenant scope.
 *
 * Row-level security means a query with no scope fails closed at runtime with
 * `MissingTenantContextError`. Whether a scope exists depends on the CALLER's
 * transport — an API route gets one from its route factory, a server component
 * does not — so the same repository function is correct from one caller and
 * broken from another, and nothing in the code says which. That gap has now
 * caused two production outages (#342, #344), each found by a user rather than
 * by a test, and each "fixed" one function at a time.
 *
 * This rule moves the invariant to where it can be checked before shipping: a
 * handle from `getDb()` may only be exercised inside a callback passed to
 * `withTenant`, `withPlatformAccess` or `withOptionalTenant`. It reports in the
 * editor, so the feedback arrives while the query is being written rather than
 * when a page 500s in production.
 *
 * It is deliberately lexical. It does not try to prove that some caller
 * somewhere establishes a scope, because "somebody upstream probably does" is
 * exactly the assumption that failed twice.
 */

/** Functions that establish a scope for the duration of their callback. */
const SCOPE_ESTABLISHING = new Set(['withTenant', 'withPlatformAccess', 'withOptionalTenant'])

/** The accessor that hands out an unscoped handle. */
const DB_ACCESSOR = 'getDb'

/** Handle members that actually reach the database. */
const QUERY_MEMBERS = new Set(['select', 'insert', 'update', 'delete', 'transaction', 'execute', '$client'])

/** The callee name of a call expression, for plain and member callees alike. */
function calleeName(node) {
  if (!node || node.type !== 'CallExpression') return null
  const { callee } = node
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') return callee.property.name
  return null
}

/**
 * True when `node` sits inside a callback given to a scope-establishing call.
 *
 * Walks ancestors rather than inspecting the immediate parent, so the ordinary
 * shape — `withTenant({ organizationId }, () => db.select()...)`, and the same
 * with a `db.transaction` nested inside — is recognised at any depth.
 */
function insideScopeCallback(node, sourceCode) {
  let current = node
  while (current) {
    const parent = sourceCode.getParent ? sourceCode.getParent(current) : current.parent
    if (!parent) return false
    const isCallback =
      (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') &&
      parent.type === 'CallExpression' &&
      parent.arguments.includes(current) &&
      SCOPE_ESTABLISHING.has(calleeName(parent))
    if (isCallback) return true
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
        'Require every getDb() handle to be used inside withTenant / withPlatformAccess / withOptionalTenant',
    },
    schema: [],
    messages: {
      unscoped:
        'This query runs with no tenant context and will fail closed under row-level security ' +
        '(MissingTenantContextError) whenever the caller has not established one — which server ' +
        'components never do. Wrap it in withTenant({ organizationId }, () => …), or, if it ' +
        'genuinely spans organizations, withPlatformAccess(reason, () => …).',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    function report(node) {
      if (!insideScopeCallback(node, sourceCode)) {
        context.report({ node, messageId: 'unscoped' })
      }
    }

    return {
      // `const db = getDb()` — check every place the handle is later used.
      VariableDeclarator(node) {
        if (calleeName(node.init) !== DB_ACCESSOR) return
        for (const variable of sourceCode.getDeclaredVariables(node)) {
          for (const reference of variable.references) {
            const identifier = reference.identifier
            const parent = sourceCode.getParent ? sourceCode.getParent(identifier) : identifier.parent
            // Only flag uses that actually issue a query; passing the handle
            // around or reassigning it is not itself a database access.
            if (
              parent?.type === 'MemberExpression' &&
              parent.property.type === 'Identifier' &&
              QUERY_MEMBERS.has(parent.property.name)
            ) {
              report(identifier)
            }
          }
        }
      },

      // `getDb().select()` — no intermediate variable to follow.
      MemberExpression(node) {
        if (calleeName(node.object) !== DB_ACCESSOR) return
        if (node.property.type !== 'Identifier' || !QUERY_MEMBERS.has(node.property.name)) return
        report(node)
      },
    }
  },
}
