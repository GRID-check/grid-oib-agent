/**
 * Which agent groups a zero-data-retention organization cannot currently run.
 *
 * Turning ZDR on is never blocked: it is a privacy control, and refusing it
 * because some model lacks a ZDR endpoint would leave data flowing to
 * endpoints that retain it. But with ZDR on, OpenRouter refuses every request
 * whose model has no ZDR endpoint that can serve it, so the admin has to learn
 * which groups that is, before their members do.
 *
 * "The model" is the EFFECTIVE one, resolved exactly as the runtime resolves it
 * (`getEffectiveModelOverrides`, the internal model-overrides route): the org's
 * own choice, else the platform default, else the workflow YAML model. An org
 * that chose nothing still inherits models, and those are the ones most likely
 * to be overlooked.
 */

import 'server-only'
import { AGENT_GROUPS, getAgentGroup } from './agent-groups'
import { getGroupDefaultSources, splitGroupDefault, type GroupDefaultSource } from './backend-defaults'
import { fetchZdrEndpoints, zdrShortfall, type ZdrIndex, type ZdrShortfall } from './openrouter'
import { getActiveModelOverrides, layerOrgOverrides } from './service'

/** Which layer a group's effective model comes from. */
export type EffectiveModelSource = 'org' | 'platform' | 'workflow'

export interface EffectiveGroupModel {
  group: string
  /** Usually one id; the workflow layer may name several for a multi-LLM group (deep research). */
  modelIds: string[]
  /** Null when no layer resolved a model (the backend's workflow config was unreachable). */
  source: EffectiveModelSource | null
}

export interface ZdrBlockedGroup {
  group: string
  modelId: string
  source: EffectiveModelSource
  /** `not_zdr`: no ZDR endpoint at all. `zdr_endpoint_lacks_capability`: none that serves this group. */
  reason: ZdrShortfall
}

export interface ZdrCoverage {
  /** `unknown`: the ZDR list (or the models) could not be read, so nothing below is a statement of safety. */
  status: 'checked' | 'unknown'
  blockedGroups: ZdrBlockedGroup[]
  /** Groups whose effective model could not be resolved, and so could not be checked. */
  unresolvedGroups: string[]
}

/** What a caller reports when it could not work the coverage out at all. */
export const UNKNOWN_COVERAGE: ZdrCoverage = { status: 'unknown', blockedGroups: [], unresolvedGroups: [] }

/**
 * Per current agent group: the org's own choice layered over what it inherits
 * (`getGroupDefaultSources`: platform default, else workflow YAML), with the
 * same `layerOrgOverrides` merge the runtime map uses.
 */
export function resolveEffectiveGroupModels(
  orgOverrides: Record<string, string> | null,
  inherited: Record<string, GroupDefaultSource>
): EffectiveGroupModel[] {
  const inheritedModels = Object.fromEntries(
    Object.entries(inherited)
      .filter((entry): entry is [string, GroupDefaultSource & { model: string }] => entry[1].model !== null)
      .map(([group, { model }]) => [group, model])
  )
  const effective = layerOrgOverrides(inheritedModels, orgOverrides)
  return AGENT_GROUPS.map(({ id }) => {
    const source: EffectiveModelSource | null = orgOverrides?.[id] ? 'org' : (inherited[id]?.source ?? null)
    return { group: id, modelIds: splitGroupDefault(effective[id]), source: source && effective[id] ? source : null }
  })
}

/** Every (group, model) pair whose model has no ZDR endpoint able to serve that group. */
export function findZdrBlockedGroups(models: EffectiveGroupModel[], zdr: ZdrIndex): ZdrBlockedGroup[] {
  const blocked: ZdrBlockedGroup[] = []
  for (const { group: groupId, modelIds, source } of models) {
    const group = getAgentGroup(groupId)
    if (!group || !source) continue
    for (const modelId of modelIds) {
      const reason = zdrShortfall(modelId, group, zdr)
      if (reason) blocked.push({ group: groupId, modelId, source, reason })
    }
  }
  return blocked
}

/**
 * The org's ZDR coverage right now. Never throws for the ZDR list: its outage
 * is reported as `status: 'unknown'`, which the card must say out loud rather
 * than read as "all clear".
 */
export async function getZdrCoverage(organizationId: string): Promise<ZdrCoverage> {
  const [orgOverrides, inherited] = await Promise.all([
    getActiveModelOverrides(organizationId),
    getGroupDefaultSources(),
  ])
  const models = resolveEffectiveGroupModels(orgOverrides, inherited)
  const unresolvedGroups = models.filter((model) => model.source === null).map((model) => model.group)
  let zdr: ZdrIndex
  try {
    zdr = await fetchZdrEndpoints()
  } catch (error) {
    console.warn('[Model Config] ZDR coverage unknown: the ZDR list could not be read:', error)
    return { ...UNKNOWN_COVERAGE, unresolvedGroups }
  }
  return { status: 'checked', blockedGroups: findZdrBlockedGroups(models, zdr), unresolvedGroups }
}
