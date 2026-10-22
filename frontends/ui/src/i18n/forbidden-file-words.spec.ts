/**
 * @vitest-environment node
 */

/**
 * The guard that keeps the copy from calling a file a plan.
 *
 * Nothing knows a file is a drawing until its Dokumentart says so: a name with
 * an index says the file has Fassungen, not what it is. The folder brief once
 * announced „Planstände“ for every file whose name carried an index, contracts
 * and Gutachten included, and the product owner made it a rule (CONTEXT.md,
 * „Fassung“; AGENTS.md, „Name a file“). This spec is that rule's ratchet for
 * the namespaces that talk about files.
 *
 * What stays allowed: a Dokumentart that IS a drawing type („Lageplan“,
 * „Floor plan“) is a compound or a fixed phrase and does not match, and the
 * research plan in `chat`/`runs` is not about files, so those namespaces are
 * not scanned.
 */

import { describe, expect, it } from 'vitest'
import { de } from './dictionaries/de'
import { en } from './dictionaries/en'

/**
 * The namespaces whose copy names files. `chat` is not here: its research-plan
 * copy („Plan genehmigen“, „Plan anzeigen“) is the approval of a research plan,
 * not a file, and it is a legitimate hit.
 */
const FILE_NAMESPACES = [
  'files',
  'officeShelf',
  'uploadBatches',
  'knowledge',
  'onboarding',
  'projects',
  'projectIntake',
  'intakeShell',
  'intakeProjectStep',
  'intakeFilingStep',
  'intakeReadingStep',
  'intakeQuestionsStep',
  'intakeProfileStep',
  'bim',
  'common',
  'nav',
  'errors',
  'inboundMail',
  'mailThread',
] as const

const FORBIDDEN: Record<'de' | 'en', RegExp> = {
  de: /(?<![\p{L}-])(Plan|Pläne|Plänen|Plans|Planstand|Planstände|Planständen)(?![\p{L}-])/u,
  // „floor plan“ and „site plan“ are Dokumentarten that are drawings by definition.
  en: /(?<!\b(?:floor|site)\s)\bplans?\b(?!-)/i,
}

function leaves(node: unknown, path: string, found: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof node === 'string') found.push([path, node])
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) leaves(value, path ? `${path}.${key}` : key, found)
  }
  return found
}

/**
 * The subtrees that name a Fassung or its approval status (CONTEXT.md,
 * „Fassung“ and „Freigabe“). One state of a document is a Fassung in German
 * and a revision in English: English said „version“ in thirty strings while
 * the newer ones said „revision“, so one reader saw „Revision 2“ on the card
 * and „Version 2“ in the approval box. A Fassung's number is never „Upload 3“.
 * The approval state that pairs with „Änderungen anfordern“ is „Änderungen
 * angefordert“, never „erbeten“, and Piloti answers from a published Fassung
 * instead of it being a „Grundlage für Antworten“.
 */
const REVISION_SUBTREES = [
  'files.lifecycle',
  'files.preview.revision',
  'files.revisionBadge',
  'files.compare',
  'chat.cards.documentDraft',
  'collaboration.inbox.review',
  'collaboration.inbox.types.documentReviewRequested',
  'collaboration.inbox.types.documentNewRevision',
  // The upload dialog asks which files come in as a new Fassung, and the upload
  // summary says which did.
  'files.folderUpload',
  'uploadBatches.summary.files',
  // A filed mail adds a Fassung to its E-Mail-Verlauf („wird Fassung 4“), and an
  // attachment may come in as the next Fassung of a document.
  'inboundMail',
] as const

const REVISION_FORBIDDEN: Record<'de' | 'en', RegExp> = {
  de: /\bVersion(en)?\b|\bUpload \{|erbeten|Grundlage für Antworten/u,
  en: /\bversions?\b|\bupload \{|\bsuperseded\b|basis for answers/i,
}

function subtree(dictionary: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], dictionary)
}

describe('a Fassung has one name and its status one word', () => {
  for (const [locale, dictionary] of [
    ['de', de],
    ['en', en],
  ] as const) {
    it(`${locale}: no „Version“, „Upload N“ or „erbeten“ where a Fassung is named`, () => {
      const offenders = REVISION_SUBTREES.flatMap((path) => {
        const node = subtree(dictionary, path)
        expect(node, `${path} moved; update REVISION_SUBTREES`).toBeTypeOf('object')
        return leaves(node, path)
      })
        // A placeholder name is code, not copy: `v{version}` says nothing to a reader.
        .filter(([, text]) => REVISION_FORBIDDEN[locale].test(text.replace(/\{\w+\}/g, '{}')))
        .map(([path, text]) => `${path}: ${text}`)
      expect(offenders).toEqual([])
    })
  }
})

describe('file copy never calls a file a plan', () => {
  for (const [locale, dictionary] of [
    ['de', de],
    ['en', en],
  ] as const) {
    it(`${locale}: no „Plan“ wording in the file namespaces`, () => {
      // Every listed namespace must exist: a renamed one used to drop out of the
      // scan without a word (`archiv` became `officeShelf` and went unchecked).
      expect(FILE_NAMESPACES.filter((ns) => !(ns in dictionary))).toEqual([])
      const scanned = FILE_NAMESPACES
      const offenders = scanned
        .flatMap((ns) => leaves((dictionary as Record<string, unknown>)[ns], ns))
        .filter(([, text]) => FORBIDDEN[locale].test(text))
        .map(([path, text]) => `${path}: ${text}`)
      expect(offenders).toEqual([])
    })
  }
})

/**
 * The E-Mail-Eingang's words (DECISION §3, „Vocabulary“; CONTEXT.md,
 * „E-Mail-Eingang“). Each banned word names something else in this product,
 * which is why it was chosen against:
 *
 * - „Projektadresse“ is where the building stands; the mail address is
 *   „E-Mail-Adresse des Projekts“.
 * - „Posteingang“ is Outlook's folder, „Postfach“ and „Inbox“ the
 *   notifications, „Quarantäne“ the content check's hold.
 * - „Durchsicht“ was the consultant's word for deciding; the decision is
 *   „ablegen“ or „verwerfen“, never „annehmen“, „ablehnen“, „freigeben“ or
 *   „zulassen“ (Freigabe and Zurückgehalten own those).
 * - A mail is „E-Mail“, never „Nachricht“; the conversation is
 *   „E-Mail-Verlauf“, never a bare „Verlauf“ (the chat's), „Thread“ or
 *   „Unterhaltung“.
 * - „Abgelegt“ is the upload status `stored`; a mail never wears it as a
 *   state. It stays allowed as the handled list's facet, the one place the
 *   decision shows it, and inside sentences („2 Dateien abgelegt“).
 */
const MAIL_NAMESPACES = ['inboundMail', 'mailThread', 'files.inboundMail', 'nav.inboundMailWaiting', 'projects.card.mailWaiting'] as const

const MAIL_FORBIDDEN: Record<'de' | 'en', RegExp> = {
  de: /Projektadresse|Posteingang|Postfach|Quarantäne|Durchsicht|durchsehen|annehmen|ablehnen|freigeben|zulassen|\bNachrichte?n?\b|\bThreads?\b|Unterhaltung|\bInbox\b|Schriftverkehr|abonnieren|(?<!E-Mail-)\bVerl(?:auf|äufe)\b(?! folgen\))/u,
  en: /\binbox\b|\bintake\b|project address|\bmessages?\b|(?<!mail )\bthreads?\b|\bapprove|\bdecline|\baccept(?!ed)|\bquarantine/i,
}

/** Where „Abgelegt“ alone is the right value: the facet that filters what was filed. */
const MAIL_FACET_PATHS = new Set(['inboundMail.filters.outcome.filed'])

describe('the E-Mail-Eingang keeps its own words', () => {
  for (const [locale, dictionary] of [
    ['de', de],
    ['en', en],
  ] as const) {
    it(`${locale}: no word the vocabulary gave to something else`, () => {
      const offenders = MAIL_NAMESPACES.flatMap((path) => {
        const node = subtree(dictionary, path)
        expect(node, `${path} moved; update MAIL_NAMESPACES`).toBeDefined()
        return leaves(node, path)
      })
        .filter(([, text]) => MAIL_FORBIDDEN[locale].test(text))
        .map(([path, text]) => `${path}: ${text}`)
      expect(offenders).toEqual([])
    })
  }

  it('de: „Abgelegt“ is never a mail\'s state', () => {
    const offenders = MAIL_NAMESPACES.flatMap((path) => leaves(subtree(de, path), path))
      .filter(([path, text]) => /^\s*Abgelegt\s*$/u.test(text) && !MAIL_FACET_PATHS.has(path))
      .map(([path, text]) => `${path}: ${text}`)
    expect(offenders).toEqual([])
  })
})
