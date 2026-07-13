/**
 * Feature-flag registry — WORKOS-NATIVE (Feature Flags product).
 *
 * Flags are created and targeted in the WorkOS dashboard (per-organization
 * or per-user targets; changes are covered by WorkOS's own event log) and
 * arrive in the AuthKit JWT as the `feature_flags` claim — the same
 * delivery path as permissions, zero extra lookups. The platform owner can
 * also target orgs programmatically (`workos.featureFlags.addFlagTarget`).
 *
 * Enforcement is an explicit deployment opt-in: `GRID_ENFORCE_FEATURE_FLAGS
 * =true` AFTER the flags below exist in the WorkOS environment and the
 * intended orgs are targeted (runbook:
 * docs/deployment/workos-provisioning.md). While off, every feature stays
 * available (back-compat for environments without the flag product). Once
 * on, a token WITHOUT the claim fails closed — users pick the flags up on
 * their next sign-in.
 */

import type { GridSession } from '@/lib/auth/types'
import { NextResponse } from 'next/server'

export const FEATURE_FLAGS = {
  /** Runtime AI model configuration (ADR-0014) — a premium admin feature. */
  modelConfiguration: 'runtime-model-config',
  /** Deep research agent mode — the expensive long-running workflow. */
  deepResearch: 'deep-research',
  /** Command palette + global keyboard shortcuts (workspace polish). */
  keyboardShortcuts: 'keyboard-shortcuts',
  /** Project-level knowledge-base transparency page (nav section). */
  projectKnowledgePage: 'project-knowledge-page',
  /** Per-org BYOK LLM credentials via WorkOS Vault (ADR-0022) — enterprise tier. */
  byokLlm: 'byok-llm',
  /** Platform-layer web-search gate; tenant toggle lives in org settings (ADR-0022). */
  webSearch: 'web-search',
} as const

export type KnownFeatureFlag = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS]

function enforcementOn(): boolean {
  return (process.env.GRID_ENFORCE_FEATURE_FLAGS ?? '').toLowerCase() === 'true'
}

/** Whether the session's user+org context has the feature enabled. */
export function isFeatureEnabled(
  session: Pick<GridSession, 'featureFlags'>,
  flag: KnownFeatureFlag,
): boolean {
  if (!enforcementOn()) return true
  if (session.featureFlags === null) return false // stale token — re-auth picks flags up
  return session.featureFlags.includes(flag)
}

/**
 * Default-OFF gate for the project knowledge page. Unlike isFeatureEnabled
 * (which fails open when enforcement is off, for back-compat), this feature
 * launches dark: without WorkOS flag enforcement it is only available when a
 * deployment explicitly opts in via GRID_PROJECT_KNOWLEDGE_PAGE_ENABLED=true
 * (mirrors the MEMORY_REFLECTION_ENABLED fallback pattern). The platform
 * owner's base-knowledge manager is NOT gated by this.
 */
export function isProjectKnowledgePageEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  if (enforcementOn()) {
    return isFeatureEnabled(session, FEATURE_FLAGS.projectKnowledgePage)
  }
  return (process.env.GRID_PROJECT_KNOWLEDGE_PAGE_ENABLED ?? '').toLowerCase() === 'true'
}

/**
 * Route guard: stable-coded 403 when the feature is off, null when allowed.
 * Usage: `const gated = requireFeature(session, FEATURE_FLAGS.x); if (gated) return gated`
 */
export function requireFeature(
  session: Pick<GridSession, 'featureFlags'>,
  flag: KnownFeatureFlag,
): Response | null {
  if (isFeatureEnabled(session, flag)) return null
  return NextResponse.json({ error: 'feature-disabled', feature: flag }, { status: 403 })
}
