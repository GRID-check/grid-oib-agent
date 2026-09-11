/**
 * Cache keys that are deliberately NOT partitioned by organization.
 *
 * `grid/require-tenant-cache-key` refuses every other constant key, so this file
 * is the whole escape hatch and the whole audit trail. One entry per key, each
 * with the reason it is safe to share across every tenant in the deployment —
 * the reason is the point: an unexplained entry is indistinguishable from a
 * tenant leak somebody silenced, and the next reader has no way to tell.
 *
 * The bar for adding a row: **the value is a property of the deployment or of an
 * external provider, and knowing it tells you nothing about any organization.**
 * Platform defaults, an upstream model catalog, the pricing table everybody is
 * billed from. If the value is derived from a tenant's rows, its settings, its
 * members or its documents, it is not global no matter how harmless it looks —
 * that judgement is exactly the one `gotchas.md:36` records somebody getting
 * wrong, and the cached project context came back belonging to another tenant.
 *
 * Keys built per organization need no entry: the rule reads the org segment out
 * of the key expression itself.
 */

/** @type {Readonly<Record<string, string>>} */
export const GLOBAL_CACHE_KEYS = Object.freeze({
  'authz:env-role-permissions':
    'WorkOS environment roles and the permissions each holds — one catalog per environment, identical for every organization in it.',
  platformretrievalsettings:
    'Platform retrieval knobs (top-k, thresholds), set by platform admins and applied to every tenant.',
  platformmodeldefaults:
    'The platform model defaults an organization inherits when it has set no override of its own.',
  platformreasoningefforts:
    'The platform reasoning-effort defaults, same shape and same reasoning as the model defaults.',
  'platformpricing:active':
    'The active pricing version: margin and credit price, one row for the deployment and the same number on every invoice.',
  'platformlessons:digest:v1':
    'The platform-lessons digest is a cross-tenant artefact BY DESIGN — it is only ever read on platform surfaces, which are gated on GRID Platform membership plus a platform:* permission.',
  'openrouter:catalog':
    "OpenRouter's public model list. Fetched with the platform key, identical for every caller, and it is upstream data rather than ours.",
  'openrouter:zdr-endpoints:v2':
    "OpenRouter's zero-data-retention endpoint list. Upstream data, same as the catalog above.",
})
