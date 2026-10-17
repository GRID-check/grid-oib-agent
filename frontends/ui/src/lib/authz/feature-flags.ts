/**
 * Feature-flag registry — WORKOS-NATIVE (Feature Flags product).
 *
 * Flags are created and targeted in the WorkOS dashboard (per-organization
 * or per-user targets; changes are covered by WorkOS's own event log) and
 * arrive in the AuthKit JWT as the `feature_flags` claim — the same
 * delivery path as permissions, zero extra lookups. A caller with no session
 * (a scheduled fire, an internal service route, the per-turn stage read) asks
 * WorkOS per organization instead: `isOrgFeatureEnabled` in
 * `lib/workos/feature-flags.ts`, which applies the same rules as this module.
 *
 * ## One semantic, and where it comes from
 *
 * A flag is ON for a session exactly when WorkOS says so. Anything short of a
 * yes is a no: a token minted before the claim existed, a slug missing from
 * WorkOS, a failed lookup, a caller with no organization. There used to be
 * four semantics here — fail-open while `GRID_ENFORCE_FEATURE_FLAGS` was off,
 * an env opt-in that defaulted off, an env opt-out that defaulted on, and
 * fail-closed under enforcement — chosen per flag, and production ran the last
 * one while every other environment rehearsed one of the first three. Both
 * stacks enforced flags, so every `GRID_*_ENABLED` fallback was dead config in
 * them, and compose and local dev exercised a different code path from the one
 * that shipped.
 *
 * ## The one exception: a deployment that authenticates nobody
 *
 * With `REQUIRE_AUTH` not `true` (local dev, an anonymous compose stack) there
 * is no signed-in user, so there is no claim and usually no organization to
 * ask WorkOS about. Such a deployment gets a FIXED answer per flag, decided by
 * the flag's kind in {@link FLAG_KINDS}:
 *
 *   - a `rollout` is ON. It is a feature we ship to everybody and keep a kill
 *     switch for (web search, the model surfaces, filing agent-written
 *     documents, the post-answer stages). A developer must see what customers
 *     see.
 *   - an `entitlement` is OFF. It is granted per organization because it costs
 *     money or changes who can read what (deep research, tasks, BYOK, model
 *     configuration, collaboration, the mail import, skills). An unauthenticated
 *     deployment that is reachable from somewhere it should not be must not
 *     hand those out — the same direction every other failure here takes.
 *
 * The condition is `REQUIRE_AUTH` rather than `NODE_ENV`, because the built
 * image runs `NODE_ENV=production` in compose too, and rather than the absence
 * of a WorkOS key, because a stack that signs people in cannot run without one.
 * To exercise an entitlement locally, run with `REQUIRE_AUTH=true` against the
 * Staging WorkOS environment: that is the code path production runs, and the
 * only one worth rehearsing.
 *
 * Every slug below must exist in BOTH WorkOS environments, or it is off for
 * everybody: `task fe:provision:flags` checks that, read-only (runbook:
 * docs/deployment/workos-provisioning.md).
 */

import type { GridSession } from '@/lib/auth/types'
import { isAuthRequired } from '@/lib/auth/auth-required'
import { NextResponse } from 'next/server'

export const FEATURE_FLAGS = {
  /** Runtime AI model configuration (ADR-0014) — a premium admin feature. */
  modelConfiguration: 'runtime-model-config',
  /** Deep research agent mode — the expensive long-running workflow. */
  deepResearch: 'deep-research',
  /**
   * Delegated tasks and their schedules (ADR-0051/0054): work a chat turn hands
   * over instead of answering, plus the recurring `cadence` form.
   *
   * Deliberately NOT part of `skills`, although the two shipped together and the
   * Automation section shows both. They are not one feature. A skill is a
   * published instruction the agent may follow inside a turn; a task is a unit
   * of work that OUTLIVES the turn, costs the requester's budget and runs under
   * their permissions. An organization can reasonably have the toolbox and not
   * the right to queue work against it — which is exactly the shape the product
   * wanted: the skills we publish stay usable in chat, the Automation tab and
   * everything that queues work do not.
   *
   * It is also the second door into the workflow `deep-research` closes, since
   * a task's agent type may be `researcher` or `deep_researcher`. Gating the
   * escalation and leaving this open would withdraw deep research from the chat
   * turn and leave it reachable by asking for it as a task.
   */
  taskAutomation: 'task-automation',
  /** Project-level knowledge-base transparency page (nav section). */
  projectKnowledgePage: 'project-knowledge-page',
  /** Per-org BYOK LLM credentials via WorkOS Vault (ADR-0022) — enterprise tier. */
  byokLlm: 'byok-llm',
  /** Platform-layer web-search gate; tenant toggle lives in org settings (ADR-0022). */
  webSearch: 'web-search',
  /** Standalone PNG/JPG image upload via VLM captioning (FB-15a); gates the
   *  accept-list (client) and the server-side upload allow-list (BFF). */
  imageUpload: 'image-upload',
  /** End-of-wizard AI conflict check (FB-13): on Save, an LLM checks the intake
   *  answers for internal contradictions and the user confirms/overrides or
   *  revises. Server-computed in the intake page, prop-drilled to the wizard;
   *  off → the wizard saves exactly as before (no check). */
  wizardConflictCheck: 'wizard-conflict-check',
  /**
   * Collaboration (ADR-0032/0033/0034/0035): shared chats, @-mentions with the
   * agent hand-off, and the inbox. An entitlement: it changes who can see a
   * conversation, so nobody has it until an operator targets the organization.
   *
   * Gates the inbox nav entry + page, the share surfaces, the mention picker, and
   * every `/api/inbox/*`, `/api/sharing/*` and `/api/stream` route. With the flag
   * off the product behaves exactly as it did before the feature existed
   * (spec NF-8).
   *
   * Note there is deliberately NO paired capability gate: the feature works with
   * the shared cache tier absent (live updates degrade to polling, spec RT-3), so
   * it has no infrastructure dependency to derive a capability from — per the
   * capability doctrine in AGENTS.md.
   */
  collaboration: 'collaboration',
  /**
   * IFC/BIM models (ADR-0045): `.ifc` upload, in-browser model viewer, and the
   * agent's deterministic `ifc_query` tool.
   *
   * Gates the `.ifc` entry in the upload accept-list (client and the BFF
   * allow-list), the model surfaces, and every `/api/**\/bim/*` route.
   *
   * Like `collaboration`, there is deliberately NO paired capability gate.
   * Extraction runs in the BFF process with `@ifc-lite/parser` and the viewer
   * runs in the browser, so the feature has no infrastructure dependency to
   * derive a capability from — per the capability doctrine in AGENTS.md. The
   * viewer's WebGPU requirement is a per-BROWSER fact, detected at render time
   * and degraded to the data explorer, not a deployment capability.
   */
  ifcModels: 'ifc-models',
  /**
   * Agent-authored documents: a finished deep-research report and a drawn
   * diagram filed into a project as `documents` rows
   * (`lib/documents/generated.ts`, ADR-0047's 2026-08-20 addenda).
   *
   * Gates the ONE filing seam, so every producer rides it — a flag per producer
   * could only let the two disagree, which is the argument the `skills` entry
   * above already makes about jobs.
   *
   * ## Why this exists ALONGSIDE `project:documents:generate`
   *
   * They answer different questions, and neither can answer the other's.
   *
   *   - The permission is the TENANT's: per project, per role, set by the
   *     organization's own admin, and withheld by putting people on a custom
   *     project role that omits it. It cannot serve as an operator kill switch,
   *     because the only way to withdraw it fleet-wide is to edit the built-in
   *     `project-editor`/`project-admin` roles in WorkOS — which makes
   *     `provision:authz --check` fail in CI (ADR-0038 §1). The repo actively
   *     forbids using the catalog as a knob.
   *   - This flag is the OPERATOR's: is the capability present in this
   *     deployment at all. It is what the rollout runbook's §4 reaches for when
   *     filing has to stop now, and it stops filing for every producer and every
   *     tenant without touching a single role.
   *
   * A rollout: ON for every organization in WorkOS, and switching it off for
   * one (or all) is a dashboard toggle, no deploy.
   */
  agentAuthoredDocuments: 'agent-authored-documents',
  /** Agent Skills: the org toolbox of agentskills.io-format skills plus the
   *  project jobs that may attach them. Gates every /api/skills and
   *  /api/projects/[id]/jobs route, and whether a due schedule fires for the
   *  organization (`fireScheduledJob`). Jobs ride this one flag: they ship as
   *  one feature, so a second flag could only let them disagree. */
  skills: 'skills',
  /**
   * The project email address: mail sent to a project's own address files its
   * attachments into the project as the sender (`lib/inbound-mail`, ADR-0075).
   *
   * An entitlement: mail from outside reaches a tenant's file system, so an
   * organization gets it after it has been told, never by default.
   *
   * Gates the address surface (`/api/projects/[id]/inbound-address`), the
   * webhook (a refusal the sender's server does not retry) and the filing job.
   * The webhook and the filing job have no session, so they read the org-level
   * half, `isProjectMailInboxEnabledForOrg` in `lib/workos/feature-flags.ts`.
   */
  projectMailInbox: 'project-mail-inbox',
  /** Outlook archive (.pst/.ost) import into a project (ADR-0085). It files the
   *  correspondence of everyone who wrote to the office, so an operator
   *  switches it on per organization, deliberately. */
  mailImport: 'mail-import',
  /**
   * The post-answer memory-reflection stage (`docs/architecture/
   * project-memory-design.md` §3.5). Read per turn by the agent tier through
   * `GET /api/internal/stages` (`POST_ANSWER_STAGE_FLAGS` in
   * `lib/workos/feature-flags.ts`), never from a session.
   */
  memoryReflection: 'memory-reflection',
  /** The post-answer follow-up-questions stage, read the same way. */
  postAnswerFollowUps: 'post-answer-follow-ups',
  /**
   * Events on Piloti's work wake a turn (ADR-0106): a reply that addresses
   * Piloti in an Anmerkung's thread, a reply on Piloti's own open question, and
   * a mark delegated to Piloti are answered by the server, as the person who
   * acted, with nobody's browser open. Read when the event is written (the
   * person's session) and again when the wake job runs (their pinned session).
   *
   * An entitlement, off until an operator targets the organization: a wake is
   * a model call nobody typed. With it off, an @Piloti reply is asked by the
   * browser that wrote it, exactly as before, and a mark cannot be delegated.
   */
  pilotiWakes: 'piloti-wakes',
  /**
   * Piloti acts when asked (ADR-0105): sets a mark open, changes one (resolve,
   * reopen, dismiss, take over, assign, date, reword) or deletes one, in the
   * asker's name, when the person asks for exactly that. Read from the asker's
   * pinned session on `POST /api/internal/document-annotations`.
   *
   * An entitlement, off until an operator targets the organization: an office
   * starts with Piloti proposing only and switches this on once it trusts it.
   * With it off, those ops are refused (`piloti-acts-off`) and Piloti proposes
   * instead; reads, the room, pointing, highlighting, replies and proposals are
   * untouched.
   */
  pilotiActs: 'piloti-acts',
} as const

export type KnownFeatureFlag = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS]

/**
 * What kind of switch each flag is — which decides only its answer in a
 * deployment that authenticates nobody (see the module header). A `Record`
 * over every slug, so a flag added to the registry does not compile until
 * somebody has said which kind it is.
 */
export const FLAG_KINDS: Readonly<Record<KnownFeatureFlag, 'entitlement' | 'rollout'>> = {
  'runtime-model-config': 'entitlement',
  'deep-research': 'entitlement',
  'task-automation': 'entitlement',
  'byok-llm': 'entitlement',
  collaboration: 'entitlement',
  skills: 'entitlement',
  'mail-import': 'entitlement',
  'project-mail-inbox': 'entitlement',
  'piloti-wakes': 'entitlement',
  'piloti-acts': 'entitlement',
  'web-search': 'rollout',
  'project-knowledge-page': 'rollout',
  'image-upload': 'rollout',
  'wizard-conflict-check': 'rollout',
  'ifc-models': 'rollout',
  'agent-authored-documents': 'rollout',
  'memory-reflection': 'rollout',
  'post-answer-follow-ups': 'rollout',
}

/** Every slug the code reads, for the WorkOS drift check. */
export const REGISTRY_FLAG_SLUGS: readonly KnownFeatureFlag[] = Object.values(FEATURE_FLAGS)

/**
 * Whether flags come from WorkOS here — true wherever people sign in. The one
 * definition the session gates and the session-less ones share.
 */
export function flagsFromWorkOS(): boolean {
  return isAuthRequired()
}

/** A flag's fixed answer in a deployment that authenticates nobody. */
export function unauthenticatedDefault(flag: KnownFeatureFlag): boolean {
  return FLAG_KINDS[flag] === 'rollout'
}

/** Whether the session's user+org context has the feature enabled. */
export function isFeatureEnabled(
  session: Pick<GridSession, 'featureFlags'>,
  flag: KnownFeatureFlag
): boolean {
  if (!flagsFromWorkOS()) return unauthenticatedDefault(flag)
  if (session.featureFlags === null) return false // stale token — re-auth picks flags up
  return session.featureFlags.includes(flag)
}

/**
 * The project knowledge page. The platform owner's base-knowledge manager is
 * NOT gated by this.
 */
export function isProjectKnowledgePageEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.projectKnowledgePage)
}

/**
 * The Outlook archive import (ADR-0085). Checked when an import is started and
 * when its upload completes; the job that files it does not re-check, so
 * switching the flag off stops new imports and lets a running one finish.
 */
export function isMailImportEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.mailImport)
}

/** The project email address (ADR-0075). */
export function isProjectMailInboxEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.projectMailInbox)
}

/** Whether events on Piloti's work wake a turn for this organization (ADR-0106). */
export function isPilotiWakesEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.pilotiWakes)
}

/** Whether Piloti may apply a change to Anmerkungen when the asker asks, or only propose (ADR-0105). */
export function isPilotiActsEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.pilotiActs)
}

/** Collaboration (ADR-0032…0035). */
export function isCollaborationEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.collaboration)
}

/**
 * IFC/BIM models (ADR-0045). Worth knowing before enabling it for a customer:
 * the feature renders OIB compliance verdicts, so an organization that has not
 * looked at its output is being told something about a building.
 */
export function isIfcModelsEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.ifcModels)
}

/**
 * Agent-authored documents: whether Piloti may file what it writes. The
 * OPERATOR's lever; the tenant's is `project:documents:generate`. See the
 * registry entry for why there are two.
 */
export function isAgentAuthoredDocumentsEnabled(
  session: Pick<GridSession, 'featureFlags'>
): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.agentAuthoredDocuments)
}

/**
 * Route guard for collaboration: stable-coded 403 when off, null when allowed.
 * Usage: `const gated = requireCollaborationEnabled(session); if (gated) return gated`
 */
export function requireCollaborationEnabled(
  session: Pick<GridSession, 'featureFlags'>
): Response | null {
  return requireFeature(session, FEATURE_FLAGS.collaboration)
}

/** Agent Skills and the project jobs that attach them (ADR-0046). */
export function isSkillsEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.skills)
}

/**
 * Route guard for the skills feature: stable-coded 403 when off (matching
 * requireFeature's envelope), null when allowed. Usage:
 * `const gated = requireSkillsEnabled(session); if (gated) return gated`
 */
export function requireSkillsEnabled(session: Pick<GridSession, 'featureFlags'>): Response | null {
  return requireFeature(session, FEATURE_FLAGS.skills)
}

/** Whether this session may create delegated tasks and schedules. */
export function isTaskAutomationEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.taskAutomation)
}

/**
 * Route guard for delegated tasks: stable-coded 403 when off, null when allowed.
 * Usage: `const gated = requireTaskAutomationEnabled(session); if (gated) return gated`
 */
export function requireTaskAutomationEnabled(
  session: Pick<GridSession, 'featureFlags'>
): Response | null {
  return requireFeature(session, FEATURE_FLAGS.taskAutomation)
}

/**
 * Route guard: stable-coded 403 when the feature is off, null when allowed.
 * Usage: `const gated = requireFeature(session, FEATURE_FLAGS.x); if (gated) return gated`
 */
export function requireFeature(
  session: Pick<GridSession, 'featureFlags'>,
  flag: KnownFeatureFlag
): Response | null {
  if (isFeatureEnabled(session, flag)) return null
  return NextResponse.json({ error: 'feature-disabled', feature: flag }, { status: 403 })
}
