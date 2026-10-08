/**
 * @vitest-environment node
 */

/**
 * One fact, one word.
 *
 * `key-coverage.spec.ts` guards that a key the code asks for EXISTS, and the
 * `typeof en.<ns>` annotations guard that both locales have the same keys.
 * Neither can see the failure this file is about: two keys that name the same
 * fact, both present, both resolvable, carrying different words.
 *
 * That is not cosmetic. A document that finished indexing was „Zitierbar" on
 * its status chip and „Zitierfähig" in the filter menu ON THE SAME SCREEN, and
 * a reader filtering for one had no way to know it was the other. A run that
 * finished well said „Fertig" on its card, „Abgeschlossen" in the drawer's run
 * history and „Erledigt" on the schedule card — three words for the state a
 * person is scanning for. Each was locally defensible and none of them was
 * caught, because nothing in the build reads two dictionary entries as claims
 * about one thing.
 *
 * So the claims are written down here, as groups. Adding a surface that states
 * a fact this file names means pointing its key at the group, not choosing a
 * synonym that reads well in that one sentence. A group that genuinely needs
 * two words — a CONTROL label („Aktiv", the switch you press) beside a STATE
 * („Pausiert", what the row is) — is not one group; say so by leaving them out
 * and writing down why, rather than by weakening the rule.
 */

import { describe, expect, it } from 'vitest'
import { en } from './dictionaries/en'
import { de } from './dictionaries/de'
import { getByPath } from './translate'

/**
 * Keys that state one fact, and must therefore carry one word.
 *
 * Every member is a full dot-path from a dictionary root. The first is not
 * privileged: the test reports the group, not a diff against a chosen master,
 * because which of two words is right is a copy decision and this file only
 * insists that there is one of them.
 */
const ONE_FACT_ONE_WORD: Record<string, string[]> = {
  /**
   * A document is in Piloti's knowledge and can be cited.
   *
   * Three surfaces: the live upload row, the document's own status chip, and
   * the filter menu in the file browser. The filter drifted to „Zitierfähig"
   * in German only — English said `Citable` in all three — which is exactly
   * the shape a per-locale review misses.
   */
  'document: indexed and citable': [
    'files.uploads.row.ready',
    'files.status.ready',
    'files.filters.status.ready',
  ],

  /**
   * A document is mid-pipeline: not yet citable, nothing wrong.
   *
   * Said in three words across the same three surfaces („Wird gelesen", „Wird
   * verarbeitet", „In Arbeit"), which made the filter look like a fourth state
   * rather than the one the chip was already showing.
   */
  'document: still being processed': [
    'files.uploads.row.processing',
    'files.status.processing',
    'files.filters.status.processing',
    // The chat's attachment card and its line in the thread. It said „Wird
    // verarbeitet..." after the file surfaces had settled on „Wird gelesen",
    // so one upload read as two different states depending on where you
    // looked.
    'research.fileSourceCard.statusIngesting',
  ],

  /**
   * A file of an upload matched what the project already holds, byte for
   * byte, so it was not sent. The folder-upload plan labels the row before the
   * upload, and the upload summary counts the same files after it (ADR-0086).
   */
  'upload: identical file, not sent again': [
    'files.folderUpload.action.unchanged',
    'uploadBatches.summary.counts.unchanged',
  ],

  /** A document's processing broke. */
  'document: processing failed': [
    'files.uploads.row.failed',
    'files.status.failed',
    'files.filters.status.failed',
  ],

  /**
   * The sentence under a document that could not be read, where a person is
   * deciding whether to rely on it. The file preview said „Lesen
   * fehlgeschlagen" while the chat's source peek for the same row said „Die
   * Verarbeitung dieser Datei ist fehlgeschlagen".
   */
  'document: reading failed, said on a peek': ['files.preview.peekFailedHint', 'chat.fileReference.failed'],

  /**
   * Start reading a document again.
   *
   * The project's action menu said „Erneut einlesen", the preview pane's
   * button „Verarbeitung erneut starten", English „Retry indexing" beside
   * „Retry ingestion": one button, four names, next to a status that said
   * „Wird verarbeitet". The verb is the one the status uses, „lesen".
   */
  'document: read it again': [
    'files.actions.reingest',
    'files.preview.retryIngestion',
    'archiv.actions.reingest',
    'archiv.actions.reingestConfirmAction',
  ],

  /**
   * The drawing kind that `inferDocumentKind` returns for „Schnitt" AND
   * „Ansicht". The Archiv said only „Schnitt", so an elevation filed there was
   * labelled as something it is not, and the two libraries disagreed.
   */
  'document kind: section or elevation': ['files.filters.kind.section', 'archiv.library.kind.section'],
}

const LOCALES = { en, de } as const

describe('one fact, one word', () => {
  for (const [fact, keys] of Object.entries(ONE_FACT_ONE_WORD)) {
    for (const [locale, dictionary] of Object.entries(LOCALES)) {
      it(`${locale} — ${fact}`, () => {
        const words = keys.map((key) => ({
          key,
          word: getByPath(dictionary as unknown as Record<string, unknown>, key),
        }))

        // A key that resolves to nothing is `key-coverage`'s failure, but it
        // would pass silently here as "every surface says undefined".
        const missing = words.filter((entry) => typeof entry.word !== 'string' || entry.word === '')
        expect(missing.map((entry) => entry.key)).toEqual([])

        const distinct = [...new Set(words.map((entry) => entry.word as string))]
        expect(
          distinct,
          `These keys state one fact and must carry one word:\n${words
            .map((entry) => `  ${entry.key} → ${JSON.stringify(entry.word)}`)
            .join('\n')}`,
        ).toHaveLength(1)
      })
    }
  }
})
