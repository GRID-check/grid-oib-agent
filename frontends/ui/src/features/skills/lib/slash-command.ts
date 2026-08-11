/**
 * The TEXT side of a `/skill` invocation in the composer.
 *
 * A skill is invoked by typing `/name` at the start of a message. That reaches
 * the agent as a STRUCTURED field (`skills: ['name']` on the message envelope,
 * which the backend lifts onto `force_skills`), not as prose — the same
 * separation `mention-text.ts` keeps for `@` mentions, and for the same reason:
 * the composer is a plain textarea, so the token can be edited or deleted after
 * it is inserted and the structured value must be re-derived from the text at
 * the last possible moment rather than remembered.
 *
 * Three operations, kept here rather than inside the composer so they can be
 * tested directly instead of through the DOM:
 *
 * 1. **Find the fragment being typed** (`findSlashCommandQuery`) — what opens
 *    and filters the menu — and **replace it** on pick (`insertSlashCommand`).
 * 2. **Resolve before sending** (`resolveSlashInvocation`) — match the leading
 *    token against the skills that actually exist, and report the argument text
 *    that follows it.
 *
 * ## Why only at the start of the message
 *
 * The trigger is deliberately narrower than `@`: a `/` opens the menu ONLY when
 * it is the first non-whitespace character of the composer. Slashes are
 * ordinary mid-sentence punctuation in this product's domain — `12/05`,
 * `OIB-RL 2/3`, `und/oder`, `m/s`, file paths — and a menu that opened on those
 * would fire constantly while someone writes a normal German sentence about a
 * Richtlinie. Restricting it to the opening token costs nothing (an invocation
 * applies to the whole turn, so it belongs at the front) and removes the entire
 * class of false positives rather than trying to filter them.
 *
 * ## Why an unknown name is not an invocation
 *
 * `resolveSlashInvocation` matches against the caller's list of real skills. A
 * message that merely starts with a slash — `/etc/passwd ist gemeint` — is sent
 * as the plain text it is. Inventing a skill name from text would be the same
 * mistake `mention-text` avoids by never deriving mentions from prose.
 *
 * Pure and dependency-free on purpose.
 */

/** The `/…` fragment under the caret that the menu is filtering on. */
export interface SlashCommandQuery {
  /** Everything after the `/`, up to the caret (never contains whitespace). */
  query: string
  /** Index of the `/` itself. */
  start: number
  /** Index just past the fragment (the caret position). */
  end: number
}

/** A resolved invocation: which skill, and what the user asked alongside it. */
export interface SlashInvocation {
  /** The skill's `name` — the frontmatter/`use_skill` identifier. */
  skillName: string
  /**
   * The text after the token, trimmed. Often empty: `/oib-check` on its own is
   * a complete instruction, since the skill's own body says what to do.
   */
  argument: string
}

/**
 * Upper bound on a command fragment. A skill name is capped at 64 characters by
 * the Agent Skills spec; past that the user is writing prose, not a command.
 */
const MAX_QUERY_LENGTH = 64

/**
 * The `/` fragment the caret sits in, or `null` when it is not in one.
 *
 * Only the message's opening token counts (see the module note), so this is a
 * forward check from the first non-whitespace character rather than the
 * backward scan `@` mentions need.
 */
export function findSlashCommandQuery(text: string, caret: number): SlashCommandQuery | null {
  const start = text.search(/\S/)
  if (start === -1 || text[start] !== '/') return null

  const position = Math.max(0, Math.min(caret, text.length))
  // The caret must be inside the token: after the `/`, and not past the
  // whitespace that ends it. Typing the message body must close the menu.
  if (position <= start) return null

  const fragment = text.slice(start + 1, position)
  if (/\s/.test(fragment)) return null
  if (fragment.length > MAX_QUERY_LENGTH) return null

  return { query: fragment, start, end: position }
}

/**
 * Replace the `/…` fragment with `/name ` and report the new caret position.
 *
 * The trailing space is what closes the menu (the fragment now contains
 * whitespace) and lets the user keep typing their request immediately. It is
 * skipped when the text already continues with a space, so picking a command in
 * front of existing text does not leave a double gap.
 */
export function insertSlashCommand(
  text: string,
  range: SlashCommandQuery,
  name: string,
): { text: string; caret: number } {
  const rest = text.slice(range.end)
  const token = `/${name}${rest.startsWith(' ') ? '' : ' '}`
  return {
    text: `${text.slice(0, range.start)}${token}${rest}`,
    caret: range.start + token.length,
  }
}

/**
 * The invocation this message carries, or `null` when it carries none.
 *
 * Matched against `knownNames` — the skills the member can actually invoke — so
 * a leading slash that names nothing real stays ordinary text. Matching is
 * exact and case-sensitive: skill names are lowercase by construction (the
 * spec's name rule), so a capitalised token is not a near-miss to be repaired,
 * it is something else.
 */
export function resolveSlashInvocation(
  text: string,
  knownNames: readonly string[],
): SlashInvocation | null {
  const start = text.search(/\S/)
  if (start === -1 || text[start] !== '/') return null

  const afterSlash = text.slice(start + 1)
  const boundary = afterSlash.search(/\s/)
  const token = boundary === -1 ? afterSlash : afterSlash.slice(0, boundary)
  if (!token || !knownNames.includes(token)) return null

  return {
    skillName: token,
    argument: boundary === -1 ? '' : afterSlash.slice(boundary).trim(),
  }
}

/**
 * Filter a skill list to a typed fragment, best-match first.
 *
 * A prefix match outranks a match in the middle of the name, and a name match
 * outranks a description-only match — someone who has typed `/oib` wants the
 * skill CALLED `oib-…` above one that merely mentions OIB in its description.
 * The description is searched at all because the description is what states
 * when a skill applies, so it is often how a user who has not memorised the
 * names finds the right one.
 */
export function filterSlashCommands<T extends { name: string; description: string }>(
  skills: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...skills]

  const ranked: Array<{ skill: T; rank: number }> = []
  for (const skill of skills) {
    const name = skill.name.toLowerCase()
    if (name.startsWith(needle)) ranked.push({ skill, rank: 0 })
    else if (name.includes(needle)) ranked.push({ skill, rank: 1 })
    else if (skill.description.toLowerCase().includes(needle)) ranked.push({ skill, rank: 2 })
  }
  // Stable within a rank: the caller's order is already alphabetical, and a
  // menu that reshuffles equal-ranked entries between keystrokes is unusable.
  return ranked.sort((left, right) => left.rank - right.rank).map((entry) => entry.skill)
}
