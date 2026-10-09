/**
 * ESLint's `no-restricted-syntax`, as a plugin rule oxlint can run.
 *
 * oxlint implements most of ESLint's core rules natively, but not this one: it
 * takes arbitrary esquery selectors, and the native rules are Rust. Selectors
 * ARE supported in a JS plugin's visitor keys (oxlint bundles esquery), so the
 * whole rule is "turn each configured selector into a visitor key". The options
 * have ESLint's shape, `[{ selector, message }]`, so the selectors in
 * `.oxlintrc.json` are the ones that were in `eslint.config.mjs`, unchanged.
 *
 * What the selectors are FOR is written next to each one in `.oxlintrc.json`:
 * each encodes a production bug (drizzle's throwing `tx.rollback()`, the dead
 * `'23505'` comparisons, Safari's missing ReadableStream iteration).
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow the syntax a configured esquery selector matches' },
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: { selector: { type: 'string' }, message: { type: 'string' } },
        required: ['selector', 'message'],
        additionalProperties: false,
      },
    },
    messages: { restricted: '{{message}}' },
  },

  create(context) {
    const visitor = {}
    for (const { selector, message } of context.options) {
      visitor[selector] = (node) => context.report({ node, messageId: 'restricted', data: { message } })
    }
    return visitor
  },
}
