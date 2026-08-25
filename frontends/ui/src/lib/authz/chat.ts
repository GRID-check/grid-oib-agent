/**
 * The permission that gates USING the research agent inside a project.
 *
 * `project:chat` shipped with ADR-0038 and the `project-contributor` role built
 * on it, and then nothing ever checked it: every chat entry point gated on
 * `project:view`. The role that exists to say "may run the agent, may not change
 * the corpus" was therefore indistinguishable from `project-viewer`, which the
 * catalog documents as read-only and which could open threads and spend the
 * tenant's LLM budget. The org Access tab rendered both, so the product
 * advertised a distinction it did not enforce.
 *
 * ## Why an any-of list rather than the bare permission
 *
 * The same back-compat idiom the write split uses (`requireProjectAccess`'s list
 * form). `project:chat` sits on the built-in Contributor, Editor and Admin roles
 * in the catalog — but a tenant whose WorkOS provisioning has not been replayed
 * since it was added has editors and admins holding only `project:edit`.
 * Accepting either means enforcing the permission does not take chat away from
 * anyone who legitimately had it, in any environment, on the day it deploys.
 *
 * `project:view` is deliberately NOT in the list: including it would restore
 * exactly the behaviour this replaces.
 */

import type { ProjectPermission } from './projects'

/** Holding any ONE of these means the caller may chat in the project. */
export const CHAT_PERMISSIONS: readonly ProjectPermission[] = ['project:chat', 'project:edit']
