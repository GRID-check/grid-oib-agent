/**
 * The answer's grounding, as a reference list.
 *
 * An exported answer whose sources arrive as bare `[3]` markers is worth less
 * than the chat message it came from: in the app the marker is a chip you can
 * click, in a Word file it is a number pointing at nothing. So the export reads
 * the stored provenance and writes an actual numbered reference list — the
 * Fundstelle an architect can check, quote in a Befund, or hand to a Behörde.
 *
 * ## Where the numbers come from
 *
 * The prose keeps its `[N]` markers, and this list has to agree with them or it
 * is worse than absent. That is the whole reason for the rule below: WHEN ANY
 * stored source carries a `number`, only numbered sources are listed and their
 * own numbers are used. A source with no number was retrieved but not cited, so
 * renumbering the list 1..n would move every entry out from under the marker
 * that points at it. Only when nothing carries a number at all — older rows,
 * and answers whose backend never assigned any — does the list number itself in
 * stored order, where there are no markers to contradict.
 *
 * ## Two sources of truth, in order
 *
 * 1. `metadata.citations`, the versioned wire payload written by
 *    `encodeCitations` (`features/chat/lib/citations/persistence`). Read here
 *    with its own narrow parser rather than through that module's decoder: this
 *    runs on the server and needs the raw wire fields (title, page, edition),
 *    not the client `CitationSource` model with its ids and Date stamps.
 * 2. Failing that, the sources section the answer WROTE into its own prose
 *    (`## Quellen` + numbered entries). The backend's minimal-citation fallback
 *    emits one, and it is real grounding even though it never became structured
 *    data.
 *
 * Nothing is invented in either path: a source with no title is listed under
 * the one honest label for it rather than under a guess.
 */

import { z } from 'zod'
import type { Translator } from '@/i18n/translate'
import { splitReportSources } from '@/features/layout/lib/report-citations'

/**
 * One stored source, in the wire spelling the persistence layer writes.
 *
 * `.passthrough()` and the nullish fields mirror that schema deliberately: a
 * row written by an older or newer build must degrade to the fields we do
 * recognise, never fail the whole export.
 */
const storedSourceSchema = z
  .object({
    title: z.string().nullish(),
    url: z.string().nullish(),
    citation_key: z.string().nullish(),
    file_name: z.string().nullish(),
    page: z.number().int().positive().nullish(),
    number: z.number().int().positive().nullish(),
    content: z.string().nullish(),
    lane_label: z.string().nullish(),
    binding_note: z.string().nullish(),
  })
  .passthrough()

const payloadSchema = z.object({
  /** Bumped by the writer for a shape change; unknown versions decode to nothing. */
  v: z.literal(1),
  sources: z.array(storedSourceSchema),
})

export interface ReferenceEntry {
  /** The `[N]` in the prose that points at this entry. */
  number: number
  /** Title, citation key or file name — whatever the source actually stated. */
  label: string
  /** Page locator, already localized ("S. 18"). */
  page?: string
  /** Edition or shelf note, when the stored source carried one. */
  note?: string
  url?: string
}

const trimmed = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** The stored source array, from either the versioned envelope or a bare array. */
const readSources = (value: unknown): z.infer<typeof storedSourceSchema>[] => {
  const versioned = payloadSchema.safeParse(value)
  if (versioned.success) return versioned.data.sources
  const bare = z.array(storedSourceSchema).safeParse(value)
  return bare.success ? bare.data : []
}

/**
 * The name to file a source under.
 *
 * Ordered by how verifiable each is: a citation key ("OIB-RL 2, Pkt. 3.1") is a
 * locator, a title is a name, a file name is at least the object on disk, a
 * host is the last thing that identifies anything. `untitledSource` rather than
 * an empty row, because a blank line in a reference list reads as a formatting
 * bug rather than as a source that never told us what it was.
 */
const labelFor = (source: z.infer<typeof storedSourceSchema>, t: Translator): string => {
  const key = trimmed(source.citation_key)
  const title = trimmed(source.title)
  if (title && key && !title.includes(key)) return `${key} — ${title}`
  return key ?? title ?? trimmed(source.file_name) ?? hostOf(source.url) ?? t('untitledSource')
}

const hostOf = (url: unknown): string | undefined => {
  const value = trimmed(url)
  if (!value) return undefined
  try {
    return new URL(value).hostname
  } catch {
    return undefined
  }
}

/**
 * Build the reference list from the stored citation payload.
 *
 * Returns an empty list — never a placeholder entry — when the answer stored no
 * provenance. An answer with no sources is one whose export must show none:
 * that is a visible, honest gap, and inventing a "no sources" row would be the
 * export making a claim the answer did not.
 */
export function referencesFromStored(value: unknown, t: Translator): ReferenceEntry[] {
  const sources = readSources(value)
  if (sources.length === 0) return []

  const numbered = sources.filter((source) => typeof source.number === 'number')
  const listed = numbered.length > 0 ? numbered : sources

  const entries: ReferenceEntry[] = []
  const seen = new Set<number>()
  listed.forEach((source, index) => {
    const number = numbered.length > 0 ? (source.number as number) : index + 1
    // Two chunks of the same document share one `[N]`; the reference list wants
    // the source once, not once per retrieved passage.
    if (seen.has(number)) return
    seen.add(number)
    const page = typeof source.page === 'number' ? t('page', { page: source.page }) : undefined
    entries.push({
      number,
      label: labelFor(source, t),
      ...(page ? { page } : {}),
      ...(trimmed(source.binding_note) ?? trimmed(source.lane_label)
        ? { note: trimmed(source.binding_note) ?? trimmed(source.lane_label) }
        : {}),
      ...(trimmed(source.url) ? { url: trimmed(source.url) } : {}),
    })
  })

  return entries.sort((a, b) => a.number - b.number)
}

export interface ProseSplit {
  /** The answer's prose with its written sources section lifted out. */
  body: string
  /** The entries of that section, or an empty list when it had none. */
  references: ReferenceEntry[]
}

/**
 * Split the written sources section off the answer's prose.
 *
 * Done even when structured citations exist, because leaving it in would state
 * the answer's sources twice — once as the model wrote them, once as the
 * reference list — and the two lists are not guaranteed to agree. The parser is
 * `splitReportSources`, reused rather than re-derived: it is a dependency-free
 * pure module, and a second regex for the same "## Quellen" shape is a second
 * thing to keep in step with what the backend emits.
 */
export function splitProse(markdown: string): ProseSplit {
  const split = splitReportSources(markdown)
  return {
    body: split.body,
    references: split.entries.map((entry) => ({ number: entry.number, label: entry.markdown })),
  }
}
