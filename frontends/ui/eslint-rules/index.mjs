/**
 * The repo's own lint rules, as one plugin under the `grid` namespace.
 *
 * The rules are written against ESLint's rule API, which is also the API
 * oxlint's JS plugins implement, so `.oxlintrc.json` loads this file through
 * `jsPlugins` and runs the rule modules unchanged. Severities and file scopes
 * live in `.oxlintrc.json`; this file only names the rules.
 */

import cardTypeScale from './card-type-scale.mjs'
import motionVocabulary from './motion-vocabulary.mjs'
import noRestrictedSyntax from './no-restricted-syntax.mjs'
import requireTenantCacheKey from './require-tenant-cache-key.mjs'
import requireTenantScope from './require-tenant-scope.mjs'

export default {
  meta: { name: 'grid' },
  rules: {
    'require-tenant-scope': requireTenantScope,
    'require-tenant-cache-key': requireTenantCacheKey,
    'motion-vocabulary': motionVocabulary,
    'card-type-scale': cardTypeScale,
    'no-restricted-syntax': noRestrictedSyntax,
  },
}
