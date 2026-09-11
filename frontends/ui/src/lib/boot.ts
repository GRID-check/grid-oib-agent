/**
 * What this process is, in one line, at startup.
 *
 * ## The question this answers
 *
 * A pilot said a feature did not work. Nobody could say which build the pilot
 * was running, and nobody could say whether that feature was even switched on
 * for them: `GRID_SKILLS_ENABLED`, `GRID_COLLABORATION_ENABLED` and
 * `GRID_ENFORCE_FEATURE_FLAGS` all default to `false`
 * (`deploy/compose/docker-compose.coolify.yaml`), so an organization can have
 * no inbox, no sharing, no mentions, no jobs and no skills — and the product
 * looks, from the outside, exactly like one where those things are broken.
 * Three of the four feedback items in
 * `docs/audit/pilot-feedback-triage-2026-09.md` are indistinguishable from
 * "the flag was off".
 *
 * So: one line, first thing, on both services, naming the deployed commit and
 * the effective value of each gate. Plus `sha` on the health endpoints, so the
 * question can be answered about a RUNNING deployment without shell access to
 * read a log that has since rotated.
 *
 * ## Effective values, not raw env
 *
 * Each field below is what the gate that reads it would actually decide, not
 * what the variable literally says — a boot line you have to re-derive is a
 * boot line nobody trusts. In particular `agentDocs` defaults **on** while the
 * other three default **off**, because
 * `agentAuthoredDocumentsEnvEnabled()` treats unset as enabled. The parsing
 * rules here are duplicated from `lib/authz/feature-flags` deliberately: this
 * module is imported by a health route and by nothing that has a session, so
 * it must not pull `next/server` or WorkOS in behind it. `bootFlags` is
 * therefore pinned against those gates by its own spec.
 *
 * ## The CommonJS twin
 *
 * `server.js` prints the same line before Next.js is even built, and it is
 * plain CommonJS that cannot import this module (see its header). It carries a
 * byte-for-byte copy of {@link formatBootLine}'s output rules, and
 * `tests/lib/boot.test.ts` extracts that copy from the source and runs both
 * implementations over the same table — so a change to one that is not made to
 * the other fails a test instead of producing two different boot lines.
 */

/** The four gates a pilot report has to be able to name. */
export interface BootFlags {
  skills: boolean
  collaboration: boolean
  enforceFlags: boolean
  agentDocs: boolean
}

/** What every field of the boot line is about. */
export interface BootFacts {
  sha: string
  flags: BootFlags
}

/** The value used when nothing stamped a commit into the image. */
export const UNKNOWN_SHA = 'unknown'

/** Env vars an opt-in gate reads: only the exact string `true` turns it on. */
function optIn(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true'
}

/**
 * Env vars a default-ON gate reads: unset means on, and only an explicit falsey
 * spelling turns it off. Same accepted spellings as
 * `agentAuthoredDocumentsEnvEnabled` / `ifcModelsEnvEnabled`.
 */
function optOut(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase()
  return value === '' || !['false', '0', 'no', 'off'].includes(value)
}

/**
 * The commit this image was built from, or {@link UNKNOWN_SHA}.
 *
 * `GRID_GIT_SHA` is stamped as a build arg by the image build and re-exported
 * as an env var (both Dockerfiles), so it survives into the running container
 * without a runtime lookup — there is no `.git` in the image to ask.
 */
export function deployedSha(env: NodeJS.ProcessEnv = process.env): string {
  const sha = (env.GRID_GIT_SHA ?? '').trim()
  return sha === '' ? UNKNOWN_SHA : sha
}

/** The effective value of each of the four gates, for this process's env. */
export function bootFlags(env: NodeJS.ProcessEnv = process.env): BootFlags {
  return {
    skills: optIn(env.GRID_SKILLS_ENABLED),
    collaboration: optIn(env.GRID_COLLABORATION_ENABLED),
    enforceFlags: optIn(env.GRID_ENFORCE_FEATURE_FLAGS),
    agentDocs: optOut(env.GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED),
  }
}

/**
 * The boot line itself. One line, `[boot]`-prefixed, `key=value` pairs in a
 * fixed order — greppable across both services and across replicas, which a
 * pretty multi-line banner is not.
 */
export function formatBootLine(facts: BootFacts): string {
  const { sha, flags } = facts
  return (
    `[boot] sha=${sha} skills=${flags.skills} collaboration=${flags.collaboration}` +
    ` enforceFlags=${flags.enforceFlags} agentDocs=${flags.agentDocs}`
  )
}

/** {@link formatBootLine} for the current process. */
export function bootLine(env: NodeJS.ProcessEnv = process.env): string {
  return formatBootLine({ sha: deployedSha(env), flags: bootFlags(env) })
}
