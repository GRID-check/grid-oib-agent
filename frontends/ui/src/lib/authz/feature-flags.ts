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
  /** [KB]/[RIS]/[Web] origin badges in report source lists (FB-2); off → plain text. */
  sourceOriginBadges: 'source-origin-badges',
  /** Self-assessed confidence chip on shallow chat answers (FB-6). */
  chatConfidenceChip: 'chat-confidence-chip',
  /** Files preview metadata block: summary/pages/passages/contents rows (FB-8). */
  filesMetadataPanel: 'files-metadata-panel',
  /** Standalone PNG/JPG image upload via VLM captioning (FB-15a); gates the
   *  accept-list (client) and the server-side upload allow-list (BFF). */
  imageUpload: 'image-upload',
  /** Fold the Research runs tab into the chat-history panel as a "Deep
   *  Research" section (FB-10). ON → hide the `research` nav item, redirect
   *  `/research` to chat, show the Deep Research section in SessionsPanel;
   *  OFF → keep the legacy Research tab + ResearchRunsList page. */
  researchInChatHistory: 'research-in-chat-history',
  /** End-of-wizard AI conflict check (FB-13): on Save, an LLM checks the intake
   *  answers for internal contradictions and the user confirms/overrides or
   *  revises. Server-computed in the intake page, prop-drilled to the wizard;
   *  off → the wizard saves exactly as before (no check). */
  wizardConflictCheck: 'wizard-conflict-check',
  /** Scheduled deep-research workflows (ADR-0023): saved research briefs per
   *  project, run manually or on a cron schedule. Dark-launched — gated by the
   *  WorkOS flag when enforcement is on, else the GRID_WORKFLOWS_ENABLED env
   *  opt-in (default off). Gates the nav item, the page (404 when off), and
   *  every BFF workflow route. */
  workflows: 'workflows',
  /** Org-wide document Archiv (ADR-0024): a top-level, cross-project document
   *  store shared by every project in the org. A standard WorkOS feature flag —
   *  gated per-org by the `organization-archiv` flag when enforcement is on, and
   *  (like every flag) available to all while enforcement is off. Gates the
   *  `/archiv` nav entry + page, every BFF `/api/archiv/*` route, and the
   *  injection of the org archive collection into project retrieval scope. */
  orgArchiv: 'organization-archiv',
  /** Per-answer thumbs feedback (WS-7, click-dummy overhaul spec §6): the
   *  "Was this helpful?" row under assistant answers + the
   *  `/api/feedback/answers` routes. A standard flag — fail-open while
   *  enforcement is off; provision it default-off in WorkOS and target the
   *  orgs that should collect feedback. */
  answerFeedback: 'answer-feedback',
} as const

export type KnownFeatureFlag = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS]

/**
 * Whether WorkOS flag enforcement is on for this deployment. Exported so
 * session-less gates (e.g. the workflows scheduled-fire path) share this one
 * definition instead of re-parsing GRID_ENFORCE_FEATURE_FLAGS themselves.
 */
export function enforcementOn(): boolean {
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
 * Default-OFF gate for scheduled workflows (ADR-0023). Like
 * isProjectKnowledgePageEnabled, this feature launches dark: with WorkOS flag
 * enforcement it follows the per-org `workflows` flag; without enforcement it
 * is only available when a deployment explicitly opts in via
 * GRID_WORKFLOWS_ENABLED=true (mirrors the project-knowledge-page fallback).
 */
export function isWorkflowsEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  if (enforcementOn()) {
    return isFeatureEnabled(session, FEATURE_FLAGS.workflows)
  }
  return (process.env.GRID_WORKFLOWS_ENABLED ?? '').toLowerCase() === 'true'
}

/**
 * Route guard for the workflows feature: stable-coded 403 when off (matching
 * requireFeature's envelope), null when allowed. Distinct from requireFeature
 * because the gate is the dark-launch isWorkflowsEnabled(), not a plain flag
 * check. Usage: `const gated = requireWorkflowsEnabled(session); if (gated) return gated`
 */
export function requireWorkflowsEnabled(session: Pick<GridSession, 'featureFlags'>): Response | null {
  if (isWorkflowsEnabled(session)) return null
  return NextResponse.json({ error: 'feature-disabled', feature: FEATURE_FLAGS.workflows }, { status: 403 })
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
