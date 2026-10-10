/**
 * Turn-event keys: the closed set of sentences the live line can say, and the
 * one renderer (`docs/design/chat-wire-v2.md` §e.3, §e.5).
 *
 * **The wire carries KEYS, not sentences.** A step ships `key` (a stable dotted
 * id) plus `values` (interpolation data only), and THIS side owns every word in
 * every locale. `TURN_EVENT_KEYS` is the closed set of ids we can phrase; an id
 * outside it renders NOTHING, because the alternative is printing an
 * identifier, and this product has already shipped "Use Skill …" once.
 *
 * The fold (`turn-fold.ts`) stores a `turnEvent` only for a live-channel step
 * that carries a key, so a technical record has nothing here to render.
 */

import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'

/**
 * Every turn-event key this UI can phrase, and where it looks it up.
 *
 * A closed set on purpose. `createTranslator` falls back to the KEY ITSELF for
 * a miss (and only warns outside production), so resolving an unrecognised id
 * would put `status.retrieval.withQuery` on the live line as if it were a
 * status — the same class of bug as title-casing `use_skill` into "Use Skill".
 * Anything not listed here renders nothing at all, and the caller falls back to
 * the previous meaningful phrase.
 *
 * The dictionary path is the `chat` namespace plus this prefix plus the key, so
 * `status.citations` lives at `chat.thinking.turnStatus.status.citations` and
 * `skill.activated` at `chat.thinking.skill.activated`.
 */
export const TURN_EVENT_KEYS: Record<string, string> = {
  'status.documents.archiv': 'thinking.turnStatus.',
  'status.documents.project': 'thinking.turnStatus.',
  'status.documents.session': 'thinking.turnStatus.',
  'status.documents.several': 'thinking.turnStatus.',
  'status.documents.waiting': 'thinking.turnStatus.',
  'status.retrieval.withQuery': 'thinking.turnStatus.',
  'status.retrieval.plain': 'thinking.turnStatus.',
  // The locator rounds: a passage the agent already identified is being READ,
  // not searched for. No `{corpus}` slot — the document names itself.
  'status.retrieval.punkt': 'thinking.turnStatus.',
  'status.retrieval.page': 'thinking.turnStatus.',
  'status.retrieval.requery': 'thinking.turnStatus.',
  'status.action.remember': 'thinking.turnStatus.',
  'status.action.card': 'thinking.turnStatus.',
  // The conversation's working directory: one verb per tool, and nothing is
  // being RETRIEVED — the draft being worked on is the one the turn is writing.
  'status.action.draftList': 'thinking.turnStatus.',
  'status.action.draftRead': 'thinking.turnStatus.',
  'status.action.draftWrite': 'thinking.turnStatus.',
  'status.action.draftEdit': 'thinking.turnStatus.',
  // A file operation being PROPOSED. One key for all five verbs: the card that
  // follows says which operation on which file, so the live line's job is only
  // to say that a proposal is being prepared — not to be the card, early.
  'status.action.fileProposal': 'thinking.turnStatus.',
  // The two steps that leave the conversation: the draft becomes a project
  // document, and then a person is asked to look at it. Kept apart, unlike the
  // five proposal verbs above, because there is no card following to say which
  // of the two just happened.
  'status.action.draftFiled': 'thinking.turnStatus.',
  'status.action.draftSubmitted': 'thinking.turnStatus.',
  // Handing the work over: this turn will not produce the answer, something
  // outside the conversation will. Its own key, and not one of the two above,
  // because no draft is moving.
  'status.action.taskCreated': 'thinking.turnStatus.',
  // The tool calls are over and the answer is being written. Without this key
  // the live line keeps showing the last retrieval event through the whole
  // synthesis call — a status event marks what happens NEXT, and nothing else
  // marks this phase.
  'status.synthesis': 'thinking.turnStatus.',
  'status.citations': 'thinking.turnStatus.',
  'status.repair': 'thinking.turnStatus.',
  'status.escalation': 'thinking.turnStatus.',
  // Skill keys drop the `skill.` segment: it is already the dictionary group.
  //
  // There is one. `skill.forced` was the other — the sentence for a skill the
  // turn HAD to apply because the composer named it or the platform published
  // it as fleet standard. Both mechanisms are gone (migration 0088), so every
  // activation is now the model reaching for a capability, which is what
  // `skill.activated` already said.
  'skill.activated': 'thinking.',
}

/** Keys whose template has a `{corpus}` slot filled from a list of corpus ids. */
const CORPUS_KEYS = new Set(['status.retrieval.withQuery', 'status.retrieval.plain'])

/** Corpus ids the dictionary can name. Anything else is dropped, not printed. */
const CORPUS_IDS = new Set(['knowledge', 'ris', 'web', 'documents', 'ifc', 'otherProjects'])

/** A `chat`-namespace translator. Structural, so no i18n import is needed here. */
export type StepEventTranslator = (
  key: string,
  vars?: Record<string, string | number>
) => string

/**
 * The `{corpus}` slot: corpus IDS named and joined in the reader's language.
 *
 * The backend sends `knowledge,ris` because "im OIB-Wissen" is product copy
 * with a German preposition welded on, and the "und" between two of them is
 * grammar. Both belong here. An id we cannot name is dropped; if that leaves
 * nothing, the whole line is dropped rather than shown with an empty slot.
 */
const corpusPhrase = (raw: string, t: StepEventTranslator): string | null => {
  const named = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => CORPUS_IDS.has(id))
    .map((id) => t(`thinking.turnStatus.corpus.${id}`))
  if (named.length === 0) return null
  return named.join(t('thinking.turnStatus.corpusJoin'))
}

/**
 * Resolve a turn-event key and its values to one sentence, or `null`.
 *
 * `null` for an unknown key, and for a key whose values cannot be resolved —
 * silence beats an identifier, and beats a template with a hole in it.
 */
export const renderTurnEventKey = (
  key: string,
  values: Record<string, string> | undefined,
  t: StepEventTranslator
): string | null => {
  const prefix = TURN_EVENT_KEYS[key]
  if (prefix === undefined) return null

  const vars: Record<string, string> = { ...(values ?? {}) }
  if (CORPUS_KEYS.has(key)) {
    const phrase = corpusPhrase(vars.corpus ?? '', t)
    if (!phrase) return null
    vars.corpus = phrase
  }

  const rendered = t(`${prefix}${key}`, vars).trim()
  // Belt and braces against the translator's key-as-fallback: a key listed
  // above but missing from the dictionary must still not reach the screen.
  return rendered && rendered !== `${prefix}${key}` ? rendered : null
}

/**
 * The sentence a stored step may show on the live line, or `null` for silence.
 * Skills and status slots alike: the fold hoisted the key, the dictionary words it.
 */
export const stepEventLiveText = (step: Pick<StoredThinkingStep, 'turnEvent'>, t: StepEventTranslator): string | null =>
  step.turnEvent ? renderTurnEventKey(step.turnEvent.key, step.turnEvent.values, t) : null
