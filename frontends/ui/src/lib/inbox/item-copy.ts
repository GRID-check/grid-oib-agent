/**
 * The words of one inbox item: the title and the line under it.
 *
 * One function for every surface that words an item, so the row in the inbox and
 * the system notification (`lib/push/payload.ts`, ADR-0112) can never say two
 * different things about the same item. It reads the dictionary the caller hands
 * it, so the browser passes the active locale's and the push job the recipient's.
 *
 * No `'server-only'`, no React: the row imports it in the browser.
 */

import { getByPath, type Translator } from '@/i18n/translate'
import { INBOX_TYPE_PRESENTATION, UNKNOWN_TYPE_PRESENTATION, type InboxItemView } from './types'

/** Dictionary root for the item-type entries. */
const TYPES_PATH = 'collaboration.inbox.types'

/**
 * Pick the counted title key by hand, because this i18n layer interpolates but
 * has no plural rules (see the dictionary header): counted types ship
 * `titleOne`/`titleMany`, uncounted ones a single `title`. Reading the dictionary
 * directly — rather than calling `t()` and sniffing the returned key — keeps a
 * type that legitimately has no `titleOne` from logging a missing-key warning on
 * every render.
 */
function pickKey(dictionary: unknown, i18nKey: string, candidates: readonly string[]): string | null {
  for (const leaf of candidates) {
    if (typeof getByPath(dictionary, `${TYPES_PATH}.${i18nKey}.${leaf}`) === 'string') return leaf
  }
  return null
}

/**
 * The leaves a row tries, its variant's first: a type worded per variant (why
 * Piloti could not work a mark, what a proposal changes) keeps them under
 * `variants.<variant>`, and a variant it has no words for reads the type's own.
 */
function withVariant(variant: string | null, leaves: readonly string[]): string[] {
  return variant ? [...leaves.map((leaf) => `variants.${variant}.${leaf}`), ...leaves] : [...leaves]
}

/**
 * `project` → `Project`, `product_feedback` → `ProductFeedback`: a resource
 * type as a leaf suffix. Empty for a view without one (a payload from a deploy
 * that did not send it), which then reads the plain `body`.
 */
function resourceLeaf(resourceType: string | undefined): string {
  return (resourceType ?? '')
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

export interface InboxItemCopy {
  title: string
  body: string | null
}

/**
 * @param t a translator scoped to `collaboration`
 * @param dictionary the whole dictionary `t` reads, for the key probes
 */
export function inboxItemCopy(item: InboxItemView, t: Translator, dictionary: unknown): InboxItemCopy {
  const presentation = INBOX_TYPE_PRESENTATION[item.type] ?? UNKNOWN_TYPE_PRESENTATION
  // A REDACTED row — inert, or its target no longer reachable — carries no href
  // and no payload, because the server withholds the conversation title exactly
  // as it withholds the quoted snippet (IB-13). Falling back to "Untitled
  // conversation" there would misstate WHY the row is nameless: the thread has a
  // title, this reader is simply no longer entitled to it.
  const redacted = !item.href

  const vars = {
    actor: item.actorName ?? t('inbox.unknownActor'),
    subject: item.subject ?? t(redacted ? 'inbox.inert' : 'inbox.untitledConversation'),
    related: item.related ?? '',
    count: item.count,
  }

  const countedTitles =
    // `count` is occurrences SINCE THE ROW WAS LAST READ, so 0 is the ordinary
    // state of a read row — and picking `titleOne` for it made a group of
    // twenty that had been read claim "1 new message". Three cases, not two.
    item.count > 1 ? ['titleMany', 'title'] : item.count === 1 ? ['titleOne', 'title'] : ['titleNone', 'titleOne', 'title']
  // A row that names a second thing reads the title written for two names,
  // where its type has one, and the plain title otherwise; one whose payload
  // lost the first name (a document that could not be described) reads the
  // title written without it. A counted type that names a second thing
  // (replies to one mark) counts there too: `titleRelatedMany`, and
  // `titleRelatedNone` for a row read since.
  const related = (leaf: string) =>
    item.count > 1 ? [`${leaf}Many`, leaf] : item.count === 0 ? [`${leaf}None`, leaf] : [leaf]
  // A type that is a sentence about a person (`{actor} hat …`) may say each of
  // its titles without one, as `<leaf>NoActor`, rather than „Jemand hat …“.
  const withoutActor = (leaves: readonly string[]) =>
    item.actorName === null ? leaves.flatMap((leaf) => [`${leaf}NoActor`, leaf]) : [...leaves]
  // A request that has been answered is history: `titleResolved` says so,
  // where its type has it, instead of still asking. A redacted row reads
  // `titleRedacted` where its type puts a name in quotes the reader may no
  // longer see.
  const titleCandidates = withVariant(item.variant, [
    ...(redacted ? ['titleRedacted'] : []),
    ...(item.state === 'resolved' ? withoutActor(['titleResolved']) : []),
    ...withoutActor([
      ...(item.related !== null && !redacted
        ? [...(item.subject === null ? related('titleRelatedNoSubject') : []), ...related('titleRelated')]
        : []),
      ...countedTitles,
    ]),
  ])
  const titleLeaf = pickKey(dictionary, presentation.i18nKey, titleCandidates) ?? 'title'
  const title = t(`inbox.types.${presentation.i18nKey}.${titleLeaf}`, vars)
  // A row whose payload names no subject (an upload to the Büroablage or a
  // chat) reads the sentence written without one, where its type has it. A
  // type whose excerpt IS the news (a new Fassung's „what changed") writes its
  // body only for the row without one, as `bodyNoExcerpt`: a sentence above
  // the excerpt saying „open it to see what changed" repeated it. A type that
  // lands in a different place by what it points at (a proposal: its chat, or
  // the file under Dateien) says where as `body<ResourceType>`.
  const bodyLeaf = pickKey(
    dictionary,
    presentation.i18nKey,
    withVariant(item.variant, [
      ...(item.subject === null ? ['bodyNoSubject'] : []),
      ...(item.excerpt === null ? ['bodyNoExcerpt'] : []),
      `body${resourceLeaf(item.resourceType)}`,
      'body',
    ]),
  )
  /*
    A REDACTED row gets a complete sentence of its own rather than the templated
    "in {subject}".

    The template needs a real title to read as a phrase, and interpolating the
    withheld-target placeholder into it produced German nonsense — "2 neue
    Nachrichten in Nicht mehr verfügbar" — because one string was being asked to
    work in two grammatical positions: standalone (`conversationShared`'s body is a
    bare `{subject}`) and inside a preposition. The distinction the placeholder
    exists to make is still made, and now it is a sentence: the thread HAS a name,
    this reader is simply no longer entitled to it (IB-13).
  */
  const body = redacted
    ? t('inbox.bodyUnavailable')
    : bodyLeaf
      ? t(`inbox.types.${presentation.i18nKey}.${bodyLeaf}`, vars)
      : null

  return { title, body }
}
