/**
 * Fixtures of the E-Mail-Eingang, typed from the wire (`inbound-mail-wire.ts`),
 * for the `/dev/inbound-mail*` previews and the component specs: one per state
 * DECISION §9 names, each built from the same few builders so a change to the
 * wire breaks them at compile time, not on screen.
 *
 * `fixtureClient` serves them behind the same interface the components take
 * (`InboundMailClient`), so a preview renders the real organism over data
 * that stands still. Filing in a preview „works“: the parts go to `filing`,
 * and the next read answers them `filed`.
 */

import type {
  InboundMailAddressView,
  InboundMailListView,
  InboundMailPartView,
  InboundMailSummaryView,
  InboundMailTextView,
  InboundMailThreadCandidateView,
  InboundMailView,
} from '@/lib/inbound-mail/inbound-mail-wire'
import type { DocumentTypeTag } from '@/lib/documents/tag-vocabulary'
import type { InboundMailSuggestion } from '@/lib/inbound-mail/suggest'
import type { InboundMailAddressClient, InboundMailClient } from '@/features/inbound-mail/lib/client'
import type { FolderOption } from '@/features/inbound-mail/lib/draft'

export const PROJECT_ID = 'p-dev-1'
export const PROJECT_NAME = 'Bauplatz 12 – Wohnbau Seestadt'
/** Now, for every fixture: the times below are minutes and days before it. */
export const FIXTURE_NOW = Date.parse('2026-10-22T09:30:00.000Z')

const minutesAgo = (minutes: number): string => new Date(FIXTURE_NOW - minutes * 60_000).toISOString()
const daysAhead = (days: number): string => new Date(FIXTURE_NOW + days * 86_400_000).toISOString()

let sequence = 0
/** A stable, uuid-shaped id per name, so a preview reloads to the same URLs. */
export function fixtureId(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const hex = hash.toString(16).padStart(8, '0')
  return `${hex}-0000-4000-8000-${hex}${hex.slice(0, 4)}`
}

export const FOLDERS: FolderOption[] = [
  { id: fixtureId('folder:behoerde'), parentId: null, name: 'Behörde', path: 'Behörde', writable: true },
  { id: fixtureId('folder:bescheide'), parentId: fixtureId('folder:behoerde'), name: 'Bescheide', path: 'Behörde/Bescheide', writable: true },
  { id: fixtureId('folder:tragwerk'), parentId: null, name: 'Tragwerk', path: 'Tragwerk', writable: true },
  { id: fixtureId('folder:korrespondenz'), parentId: null, name: 'Korrespondenz', path: 'Korrespondenz', writable: true },
  { id: fixtureId('folder:vertraege'), parentId: null, name: 'Verträge', path: 'Verträge', writable: false },
]

// ------------------------------------------------------------ builders

export function part(overrides: Partial<InboundMailPartView> & { name?: string } = {}): InboundMailPartView {
  sequence += 1
  const { name, ...rest } = overrides
  return {
    id: fixtureId(`part:${name ?? sequence}`),
    kind: 'attachment',
    position: sequence,
    filename: name ?? 'Unterlage.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1_284_000,
    state: 'waiting',
    scan: 'clean',
    scannedAt: minutesAgo(9),
    riskFlags: [],
    nameStopTerms: [],
    contentFindings: [],
    offered: true,
    lastFailure: null,
    documentId: null,
    duplicateOf: null,
    revisionCandidate: null,
    revisionCandidateHidden: false,
    suggestion: null,
    restorableUntil: null,
    ...rest,
  }
}

export function messagePart(overrides: Partial<InboundMailPartView> = {}): InboundMailPartView {
  return part({ name: undefined, filename: null, kind: 'message', contentType: 'text/plain', sizeBytes: 4_200, scan: 'not_applicable', position: 0, ...overrides })
}

export function thread(overrides: Partial<InboundMailThreadCandidateView> = {}): InboundMailThreadCandidateView {
  return {
    threadId: fixtureId('thread:stellplatz'),
    documentId: fixtureId('doc:stellplatz'),
    name: 'Stellplatznachweis',
    folderPath: 'Korrespondenz',
    nextVersion: 4,
    strength: 'reference',
    preselected: true,
    blocks: [],
    full: false,
    ...overrides,
  }
}

export function mail(overrides: Partial<InboundMailView> & { key?: string } = {}): InboundMailView {
  const { key, ...rest } = overrides
  return {
    id: fixtureId(`mail:${key ?? 'default'}`),
    projectId: PROJECT_ID,
    status: 'waiting',
    projectClosed: false,
    ifMatch: `if-${key ?? 'default'}`,
    subject: 'AW: Stellplatznachweis – Nachreichung Statik',
    sender: {
      name: 'DI Petra Weber',
      address: 'p.weber@statik-weber.at',
      domain: 'statik-weber.at',
      signerDomain: 'statik-weber.at',
      trust: 'external_verified',
      reason: 'dkim_pass',
      flags: [],
    },
    participants: [
      { role: 'from', name: 'DI Petra Weber', address: 'p.weber@statik-weber.at' },
      { role: 'to', name: 'Miriam Huber', address: 'm.huber@huber-architektur.at' },
      { role: 'cc', name: 'MA 37 – Baupolizei', address: 'post@ma37.wien.gv.at' },
    ],
    sentAt: minutesAgo(14),
    receivedAt: minutesAgo(12),
    expiresAt: daysAhead(30),
    automatic: false,
    rawScan: 'clean',
    originalHeld: true,
    notStaged: [],
    parts: [messagePart({ id: fixtureId(`message:${key ?? 'default'}`) })],
    threadCandidates: [thread()],
    hiddenThreadCandidates: 0,
    followedBy: null,
    updatedAt: minutesAgo(9),
    ...rest,
  }
}

export function text(overrides: Partial<InboundMailTextView> = {}): InboundMailTextView {
  return {
    ownText:
      'Sehr geehrte Frau Huber,\n\nanbei die überarbeitete Statik S-101 in Index C. Die Stellplätze im Hof sind jetzt mit der neuen Lastannahme gerechnet.\n\nBitte um kurze Rückmeldung bis Freitag, ob die Fassung so an die MA 37 gehen kann.\n\nDie Unterlagen liegen auch unter https://cloud.statik-weber.at/s/9fK2 bereit.\n\nMit freundlichen Grüßen\nPetra Weber',
    ownTextTruncated: false,
    quoted: [
      {
        header: 'Am 14.10.2026 um 09:12 schrieb Miriam Huber <m.huber@huber-architektur.at>:',
        text: 'Liebe Frau Weber,\n\nkönnen Sie uns die Statik mit den geänderten Stellplätzen bis Ende der Woche schicken?\n\nDanke und lg\nMiriam Huber',
      },
    ],
    calendar: [],
    masked: false,
    unreadable: false,
    ...overrides,
  }
}

export function summaryOf(view: InboundMailView, overrides: Partial<InboundMailSummaryView> = {}): InboundMailSummaryView {
  const attachments = view.parts.filter((candidate) => candidate.kind === 'attachment')
  const preferred = view.threadCandidates.find((candidate) => candidate.preselected) ?? view.threadCandidates[0] ?? null
  return {
    id: view.id,
    projectId: view.projectId,
    status: view.status,
    subject: view.subject,
    senderName: view.sender?.name ?? null,
    senderDomain: view.sender?.domain ?? null,
    senderTrust: view.sender?.trust ?? null,
    senderFlags: view.sender?.flags ?? [],
    automatic: view.automatic,
    receivedAt: view.receivedAt,
    expiresAt: view.expiresAt,
    attachments: attachments.length,
    waitingParts: view.parts.filter((candidate) => candidate.state === 'waiting').length,
    outcomes: {
      filed: view.parts.filter((candidate) => candidate.state === 'filed').length,
      dismissed: view.parts.filter((candidate) => candidate.state === 'dismissed').length,
      expired: view.parts.filter((candidate) => candidate.state === 'expired').length,
    },
    restorableUntil: view.parts.map((candidate) => candidate.restorableUntil).find((until): until is string => !!until) ?? null,
    thread: preferred ? { threadId: preferred.threadId, name: preferred.name, nextVersion: preferred.nextVersion, preselected: preferred.preselected } : null,
    updatedAt: view.updatedAt,
    ...overrides,
  }
}

// ------------------------------------------------------------ attachments

/** A suggestion in the shape the suggest job stores (`lib/inbound-mail/suggest.ts`). */
const suggestion = (
  folderPath: string,
  documentType: DocumentTypeTag | null,
  reason: string,
  { newFolder = false }: { newFolder?: boolean } = {},
): InboundMailSuggestion => ({ folderId: null, folderPath, newFolder, documentType, reason })

const statik = (overrides: Partial<InboundMailPartView> = {}) =>
  part({
    name: 'S-101_C.pdf',
    sizeBytes: 2_480_000,
    revisionCandidate: { documentId: fixtureId('doc:s101'), name: 'S-101_B.pdf', folderPath: 'Tragwerk', nextVersion: 3 },
    suggestion: suggestion('Tragwerk', 'Gutachten', 'Gleiche Bezeichnung wie S-101_B.pdf in Tragwerk.'),
    ...overrides,
  })

const permitDecision = (overrides: Partial<InboundMailPartView> = {}) =>
  part({
    name: 'Bescheid_MA37_2026-10-14.pdf',
    sizeBytes: 412_000,
    suggestion: suggestion('Behörde/Bescheide', 'Bescheid', 'Absender ist die MA 37; Bescheide liegen in Behörde/Bescheide.'),
    ...overrides,
  })

// ------------------------------------------------------------ detail variants

export interface DetailFixture {
  view: InboundMailView
  text: InboundMailTextView
  decidedByOther?: boolean
  /** Keep the mail loading (the skeleton), or fail its read. */
  load?: 'loading' | 'error'
}

const memberVerified = mail({
  key: 'member-verified',
  subject: 'WG: Bescheid MA 37 – Stellplatznachweis',
  sender: {
    name: 'Miriam Huber',
    address: 'm.huber@huber-architektur.at',
    domain: 'huber-architektur.at',
    signerDomain: 'huber-architektur.at',
    trust: 'member_verified',
    reason: 'dkim_pass',
    flags: [],
  },
  parts: [messagePart({ id: fixtureId('message:member') }), permitDecision()],
  threadCandidates: [thread()],
})

const longName =
  'Einreichplanung_Stellplatznachweis_Tiefgarage_Ebene_-2_Brandabschnitte_und_Fluchtwege_überarbeitet_nach_Verhandlung_vom_14_10_2026_Index_F_final_final2.pdf'

export const DETAIL_VARIANTS: Record<string, DetailFixture> = {
  'member-verified': { view: memberVerified, text: text() },
  'external-unverified': {
    view: mail({
      key: 'external-unverified',
      subject: 'Angebot Fassadenreinigung',
      sender: { name: 'Clean & Shine GmbH', address: 'office@clean-shine.example', domain: 'clean-shine.example', signerDomain: null, trust: 'external_unverified', reason: 'dkim_none', flags: [] },
      parts: [messagePart({ id: fixtureId('message:ext') }), part({ name: 'Angebot_2026.pdf' })],
      threadCandidates: [],
    }),
    text: text({ ownText: 'Sehr geehrte Damen und Herren,\n\nanbei unser Angebot für die Fassadenreinigung.\n\nMfG' , quoted: [] }),
  },
  impersonation: {
    view: mail({
      key: 'impersonation',
      subject: 'Dringend: Kontoänderung Honorarnote',
      sender: { name: 'Miriam Huber', address: 'm.huber@huber-architektur.at', domain: 'huber-architektur.at', signerDomain: null, trust: 'member_unverified', reason: 'dkim_fail', flags: [] },
      parts: [messagePart({ id: fixtureId('message:imp') }), part({ name: 'Honorarnote_neu.pdf', riskFlags: ['name_stop'], nameStopTerms: ['Honorar'] })],
      threadCandidates: [],
    }),
    text: text({ ownText: 'Bitte überweisen Sie die offene Honorarnote ab sofort auf das neue Konto.', quoted: [] }),
  },
  'bcc-own': {
    view: mail({
      key: 'bcc-own',
      subject: 'AW: Stellplatznachweis',
      sender: { name: 'Miriam Huber', address: 'm.huber@huber-architektur.at', domain: 'huber-architektur.at', signerDomain: 'huber-architektur.at', trust: 'member_verified', reason: 'dkim_pass', flags: ['not_addressed_to_project', 'bcc_own'] },
      parts: [messagePart({ id: fixtureId('message:bcc') })],
    }),
    text: text({ ownText: 'Liebe Frau Weber,\n\ndanke, das passt so. Wir reichen am Montag ein.\n\nlg Miriam', quoted: [] }),
  },
  'not-addressed': {
    view: mail({
      key: 'not-addressed',
      sender: { name: 'Miriam Huber', address: 'm.huber@huber-architektur.at', domain: 'huber-architektur.at', signerDomain: 'huber-architektur.at', trust: 'member_verified', reason: 'dkim_pass', flags: ['not_addressed_to_project', 'stale_date'] },
      sentAt: minutesAgo(60 * 24 * 12),
      threadCandidates: [thread({ preselected: false, blocks: ['not_addressed_to_project', 'stale_date'] })],
    }),
    text: text(),
  },
  forwarded: {
    view: mail({
      key: 'forwarded',
      subject: 'WG: Verhandlungsschrift Bauverhandlung 04.11.',
      sender: { name: 'Miriam Huber', address: 'm.huber@huber-architektur.at', domain: 'huber-architektur.at', signerDomain: 'huber-architektur.at', trust: 'member_verified', reason: 'dkim_pass', flags: [] },
      parts: [messagePart({ id: fixtureId('message:fwd') }), permitDecision({ filename: 'Verhandlungsschrift_2026-11-04.pdf' })],
      threadCandidates: [],
    }),
    text: text({
      ownText: 'Zur Ablage.',
      quoted: [
        {
          header: '-----Ursprüngliche Nachricht-----',
          text: 'Von: MA 37 – Baupolizei <post@ma37.wien.gv.at>\nGesendet: Montag, 20. Oktober 2026 14:02\nAn: Huber Architektur\nBetreff: Verhandlungsschrift Bauverhandlung 04.11.\n\nSehr geehrte Damen und Herren,\n\nanbei die Verhandlungsschrift.',
        },
      ],
    }),
  },
  'mixed-attachments': {
    view: mail({
      key: 'mixed',
      parts: [
        messagePart({ id: fixtureId('message:mixed') }),
        statik(),
        part({ name: 'Grundriss_EG.dwg', contentType: 'application/acad', sizeBytes: 5_800_000, suggestion: suggestion('Tragwerk', 'Grundriss', 'DWG mit Bezeichnung EG.') }),
        part({ name: 'Foto_Baustelle.jpg', contentType: 'image/jpeg', sizeBytes: 3_100_000, suggestion: suggestion('Fotos', 'Foto', 'Foto vom Bauplatz.', { newFolder: true }) }),
        part({ name: 'Bescheid_alt.pdf', duplicateOf: { documentId: fixtureId('doc:bescheid'), name: 'Bescheid_alt.pdf', folderPath: 'Behörde/Bescheide' } }),
        part({ name: 'Statik_verschluesselt.pdf', riskFlags: ['encrypted'], suggestion: suggestion('Tragwerk', null, 'Nur nach dem Namen.') }),
        part({ filename: null, contentType: 'image/png', sizeBytes: 182_000 }),
      ],
      notStaged: [
        { filename: 'winmail.dat', reason: 'tnef' },
        { filename: 'Pläne_Archiv.zip', reason: 'archive' },
        { filename: 'logo.png', reason: 'embedded' },
        { filename: 'linkedin.png', reason: 'embedded' },
        { filename: 'smime.p7s', reason: 'signature' },
        { filename: 'Einladung.ics', reason: 'calendar' },
      ],
    }),
    text: text({
      calendar: [{ summary: 'Bauverhandlung Bauplatz 12', start: '2026-11-04T08:00:00.000Z', end: '2026-11-04T10:00:00.000Z', allDay: false, location: 'MA 37, Dresdner Straße 73–75, 1200 Wien', status: 'CONFIRMED' }],
    }),
  },
  'type-not-accepted': {
    view: mail({
      key: 'type-not-accepted',
      parts: [
        messagePart({ id: fixtureId('message:tna') }),
        part({ name: 'Kostenschaetzung.xlsm', contentType: 'application/vnd.ms-excel.sheet.macroEnabled.12', offered: false, riskFlags: ['type_not_accepted'] }),
        statik(),
      ],
    }),
    text: text(),
  },
  'name-stop': {
    view: mail({
      key: 'name-stop',
      parts: [messagePart({ id: fixtureId('message:ns') }), part({ name: 'Honorarnote_Statik_10-2026.pdf', riskFlags: ['name_stop'], nameStopTerms: ['Honorar'], suggestion: suggestion('Verträge', 'Vertrag', 'Rechnungen des Statikers.') })],
    }),
    text: text(),
  },
  macro: {
    view: mail({
      key: 'macro',
      parts: [
        messagePart({ id: fixtureId('message:macro') }),
        part({ name: 'Massenermittlung.docm', contentType: 'application/vnd.ms-word.document.macroEnabled.12', riskFlags: ['macro'], suggestion: suggestion('Tragwerk', 'Sonstiges', 'Massenermittlung zur Statik.') }),
        part({ name: 'Lageplan.pdf', contentType: 'application/pdf', riskFlags: ['type_mismatch'], suggestion: suggestion('Behörde', 'Bebauungsplan', 'Lageplan zur Einreichung.') }),
      ],
    }),
    text: text(),
  },
  'scan-pending': {
    view: mail({ key: 'scan-pending', parts: [messagePart({ id: fixtureId('message:sp') }), statik({ scan: 'pending', scannedAt: null }), permitDecision({ scan: 'failed' })] }),
    text: text(),
  },
  infected: {
    view: mail({ key: 'infected', parts: [messagePart({ id: fixtureId('message:inf') }), part({ name: 'Rechnung_Oktober.pdf.exe', contentType: 'application/x-msdownload', scan: 'infected' }), permitDecision()] }),
    text: text(),
  },
  'original-infected': {
    view: mail({ key: 'original-infected', rawScan: 'infected', parts: [messagePart({ id: fixtureId('message:oi') }), part({ name: 'Anhang.pdf', scan: 'infected' })] }),
    text: text(),
  },
  'content-finding': {
    view: mail({
      key: 'content-finding',
      subject: 'AW: Honorarvereinbarung – Kontodaten',
      parts: [messagePart({ id: fixtureId('message:cf'), contentFindings: ['iban', 'term'] })],
    }),
    text: text({ ownText: 'Liebe Frau Huber,\n\nbitte überweisen Sie auf AT•• •••• •••• •••• ••••.\n\nlg Petra Weber', masked: true, quoted: [] }),
  },
  'thread-append': { view: mail({ key: 'thread-append', parts: [messagePart({ id: fixtureId('message:ta') })] }), text: text() },
  'unverified-thread': {
    view: mail({
      key: 'unverified-thread',
      sender: { name: 'Ing. Karl Bauer', address: 'k.bauer@bauer-bau.at', domain: 'bauer-bau.at', signerDomain: 'bauer-bau.at', trust: 'external_verified', reason: 'dkim_pass', flags: [] },
      parts: [messagePart({ id: fixtureId('message:ut') }), statik({ riskFlags: ['unverified_thread'] })],
      threadCandidates: [
        thread({ preselected: false, blocks: ['header_not_signed'] }),
        thread({ threadId: fixtureId('thread:tg'), documentId: fixtureId('doc:tg'), name: 'Tiefgarage Lüftung', nextVersion: 2, strength: 'subject', preselected: false, blocks: ['weak_match'] }),
      ],
      hiddenThreadCandidates: 1,
    }),
    text: text(),
  },
  'new-thread': {
    view: mail({ key: 'new-thread', subject: 'Baustellenbegehung 28.10.', parts: [messagePart({ id: fixtureId('message:nt') })], threadCandidates: [] }),
    text: text({ ownText: 'Hallo zusammen,\n\nTreffpunkt am 28.10. um 8:00 am Bauplatz.\n\nlg', quoted: [] }),
  },
  'full-thread': {
    view: mail({ key: 'full-thread', parts: [messagePart({ id: fixtureId('message:ft') })], threadCandidates: [thread({ full: true, preselected: false, nextVersion: 201 })] }),
    text: text(),
  },
  revision: { view: mail({ key: 'revision', parts: [messagePart({ id: fixtureId('message:rev') }), statik()] }), text: text() },
  duplicate: {
    view: mail({
      key: 'duplicate',
      parts: [
        messagePart({ id: fixtureId('message:dup') }),
        part({ name: 'S-101_B.pdf', duplicateOf: { documentId: fixtureId('doc:s101'), name: 'S-101_B.pdf', folderPath: 'Tragwerk' } }),
        part({ name: 'Detail_Attika.pdf', revisionCandidateHidden: true, suggestion: suggestion('Tragwerk', 'Detail', 'Detail zur Statik.') }),
      ],
    }),
    text: text(),
  },
  'already-filed': {
    view: mail({
      key: 'already-filed',
      sender: { name: 'DI Petra Weber', address: 'p.weber@statik-weber.at', domain: 'statik-weber.at', signerDomain: 'statik-weber.at', trust: 'external_verified', reason: 'dkim_pass', flags: ['message_id_reused', 'already_filed'] },
      parts: [messagePart({ id: fixtureId('message:af') }), statik()],
    }),
    text: text(),
  },
  'still-reading': {
    view: mail({ key: 'still-reading', receivedAt: minutesAgo(2), parts: [messagePart({ id: fixtureId('message:sr') }), part({ name: 'Protokoll_JF_12.pdf' })] }),
    text: text(),
  },
  'no-suggestion': {
    view: mail({ key: 'no-suggestion', receivedAt: minutesAgo(180), parts: [messagePart({ id: fixtureId('message:nos') }), part({ name: 'Unterlage_ohne_Namen.pdf' })] }),
    text: text(),
  },
  'decided-by-other': {
    view: mail({
      key: 'decided-by-other',
      status: 'handled',
      parts: [messagePart({ id: fixtureId('message:dbo'), state: 'filed', documentId: fixtureId('doc:stellplatz') }), permitDecision({ state: 'filed', documentId: fixtureId('doc:bescheid-neu') })],
    }),
    text: text(),
    decidedByOther: true,
  },
  'partial-failure': {
    view: mail({
      key: 'partial-failure',
      parts: [
        messagePart({ id: fixtureId('message:pf'), state: 'filed', documentId: fixtureId('doc:stellplatz') }),
        statik({ state: 'filed', documentId: fixtureId('doc:s101') }),
        permitDecision({ lastFailure: 'name_taken' }),
      ],
    }),
    text: text(),
  },
  'quota-full': {
    view: mail({ key: 'quota-full', parts: [messagePart({ id: fixtureId('message:qf') }), statik({ lastFailure: 'quota' }), permitDecision({ lastFailure: 'quota' })] }),
    text: text(),
  },
  'filed-outcome': {
    view: mail({
      key: 'filed-outcome',
      status: 'handled',
      sender: { name: 'Mag. Huber', address: 'k.huber@ma37.wien.gv.at', domain: 'ma37.wien.gv.at', signerDomain: 'wien.gv.at', trust: 'external_verified', reason: 'dkim_pass', flags: [] },
      originalHeld: false,
      parts: [messagePart({ id: fixtureId('message:fo'), state: 'filed', documentId: fixtureId('doc:stellplatz') }), permitDecision({ state: 'filed', documentId: fixtureId('doc:bescheid-neu') }), part({ name: 'Beilage_alt.pdf', state: 'dismissed', restorableUntil: daysAhead(7) })],
    }),
    text: text(),
  },
  'follow-offer': {
    view: mail({
      key: 'follow-offer',
      status: 'handled',
      originalHeld: false,
      parts: [messagePart({ id: fixtureId('message:fof'), state: 'filed', documentId: fixtureId('doc:stellplatz') })],
    }),
    text: text(),
  },
  followed: {
    view: mail({
      key: 'followed',
      followedBy: 'user_01JFOLLOWER0000000000000000',
      parts: [messagePart({ id: fixtureId('message:fol'), state: 'filed', documentId: fixtureId('doc:stellplatz') }), statik()],
    }),
    text: text(),
  },
  closed: { view: mail({ key: 'closed', projectClosed: true, parts: [messagePart({ id: fixtureId('message:cl') }), permitDecision()] }), text: text() },
  expired: {
    view: mail({ key: 'expired', status: 'handled', parts: [messagePart({ id: fixtureId('message:exp'), state: 'expired', restorableUntil: daysAhead(5) }), permitDecision({ state: 'expired', restorableUntil: daysAhead(5) })] }),
    text: text(),
  },
  dismissed: {
    view: mail({ key: 'dismissed', status: 'handled', parts: [messagePart({ id: fixtureId('message:dis'), state: 'dismissed', restorableUntil: daysAhead(6) }), permitDecision({ state: 'dismissed', restorableUntil: daysAhead(6) })] }),
    text: text(),
  },
  'unreadable-text': {
    view: mail({ key: 'unreadable', parts: [messagePart({ id: fixtureId('message:unr'), riskFlags: ['unreadable'] }), permitDecision()] }),
    text: text({ ownText: '', quoted: [], unreadable: true }),
  },
  loading: { view: memberVerified, text: text(), load: 'loading' },
  error: { view: memberVerified, text: text(), load: 'error' },
  'worst-case': {
    view: mail({
      key: 'worst-case',
      subject: 'AW: AW: WG: [EXTERN] RE: Fwd: Stellplatznachweis Tiefgarage Ebene -2 – Nachreichung der überarbeiteten Brandabschnitte, Fluchtwege und Lüftungsquerschnitte nach der Bauverhandlung vom 14.10.2026 (Index F)',
      sender: {
        name: 'Aleksandra Wiśniewska-Kowalczyk, MSc. BSc. (Projektleitung Tragwerksplanung Ost)',
        address: 'aleksandra.wisniewska-kowalczyk@northwind-industries-holdings-ingenieurbuero.example.com',
        domain: 'northwind-industries-holdings-ingenieurbuero.example.com',
        signerDomain: 'northwind-industries-holdings-ingenieurbuero.example.com',
        trust: 'external_verified',
        reason: 'dkim_pass',
        flags: ['date_out_of_range'],
      },
      participants: Array.from({ length: 14 }, (_, index) => ({
        role: index === 0 ? ('from' as const) : index < 6 ? ('to' as const) : ('cc' as const),
        name: index % 3 === 0 ? null : `Bartholomew Fitzgerald-${index}`,
        address: `bartholomew.fitzgerald.${index}@northwind-industries-holdings.example.com`,
      })),
      parts: [
        messagePart({ id: fixtureId('message:wc'), contentFindings: ['iban', 'at_svnr', 'credit_card', 'term'] }),
        part({ name: longName, sizeBytes: 98_765_432, suggestion: suggestion('Einreichung/Behörde/Bescheide und Stellungnahmen/Tiefgarage/Ebene -2/Brandschutz', 'correspondence', 'Ein sehr langer Grund, warum Piloti genau diesen tief verschachtelten Ordner vorschlägt, der in drei Zeilen kaum Platz findet und trotzdem gelesen werden will.', { newFolder: true }) }),
        part({ name: 'a.pdf', sizeBytes: 12, revisionCandidate: { documentId: fixtureId('doc:a'), name: longName, folderPath: 'Tragwerk', nextVersion: 128 }, riskFlags: ['unverified_thread', 'name_stop', 'macro'], nameStopTerms: ['Honorar', 'Rechnung', 'Gehalt', 'Kontoauszug'] }),
        part({ name: '工程图纸_第二版_最终.pdf', sizeBytes: 3_000_000, lastFailure: 'digest_mismatch' }),
        ...Array.from({ length: 9 }, (_, index) => part({ name: `Detail_${index + 1}_${'Fassadenschnitt'.repeat(2)}.pdf` })),
      ],
      threadCandidates: [
        thread({ name: 'Stellplatznachweis Tiefgarage Ebene -2 – Korrespondenz mit MA 37, MA 46 und Bezirksvertretung 22 (2025–2026)', nextVersion: 199 }),
        thread({ threadId: fixtureId('thread:w2'), documentId: fixtureId('doc:w2'), name: 'X', nextVersion: 1, strength: 'subject', preselected: false, blocks: ['weak_match', 'date_out_of_range'] }),
      ],
      hiddenThreadCandidates: 12,
      notStaged: Array.from({ length: 4 }, (_, index) => ({ filename: `${'Archiv_Einreichunterlagen_'.repeat(3)}${index}.zip`, reason: 'archive' as const })),
    }),
    text: text({
      ownText: `${'Diesesisteinsehrlangeswortohneumbruchdaskeinbrowsergernumbricht'.repeat(3)}\n\n${'Sehr geehrte Damen und Herren, '.repeat(40)}\n\nhttps://northwind-industries-holdings.example.com/${'sehr/lange/pfade/'.repeat(12)}datei.pdf\n\n${Array.from({ length: 30 }, (_, index) => `Zeile ${index + 1}`).join('\n')}`,
      ownTextTruncated: true,
      masked: true,
      quoted: Array.from({ length: 6 }, (_, index) => ({ header: `Am ${index + 1}.10.2026 schrieb jemand mit einem sehr langen Namen <jemand@example.com>:`, text: 'Zitat '.repeat(80) })),
    }),
  },
}

/** The first page of a list variant. */
export interface ListFixture {
  items: InboundMailSummaryView[]
  nextCursor?: string | null
  closed?: boolean
  /** Mails checked on arrival. */
  checked?: string[]
  /** The open mail. */
  open?: string
  status?: 'waiting' | 'handled'
  outcome?: 'filed' | 'dismissed' | 'expired' | null
  load?: 'loading' | 'error'
  /** For the empty variants: whether the project ever received mail. */
  everReceived?: boolean
}

const v = (name: string): InboundMailView => DETAIL_VARIANTS[name].view

const groupMails = [0, 1, 2].map((index) =>
  mail({
    key: `group-${index}`,
    subject: index === 0 ? 'AW: Stellplatznachweis' : `AW: AW: Stellplatznachweis (${index})`,
    receivedAt: minutesAgo(20 + index * 7),
    parts: [messagePart({ id: fixtureId(`message:group-${index}`) })],
  })
)

const quietMails = [
  mail({ key: 'quiet-1', subject: 'Newsletter Oktober', automatic: true, threadCandidates: [], sender: { name: 'Baustoffe Direkt', address: 'news@baustoffe.example', domain: 'baustoffe.example', signerDomain: 'baustoffe.example', trust: 'external_verified', reason: 'dkim_pass', flags: [] } }),
  DETAIL_VARIANTS['external-unverified'].view,
]

const allMails = [
  v('member-verified'),
  v('mixed-attachments'),
  v('unverified-thread'),
  v('impersonation'),
  v('content-finding'),
  v('name-stop'),
  ...quietMails,
]

export const DETAIL_BY_ID = new Map<string, DetailFixture>(
  [...Object.values(DETAIL_VARIANTS), ...groupMails.map((view) => ({ view, text: text() })), ...quietMails.map((view) => ({ view, text: text() }))].map(
    (fixture) => [fixture.view.id, fixture]
  )
)

export const LIST_VARIANTS: Record<string, ListFixture> = {
  empty: { items: [], everReceived: false },
  done: { items: [], everReceived: true },
  loading: { items: [], load: 'loading' },
  error: { items: [], load: 'error' },
  one: { items: [summaryOf(v('member-verified'))] },
  many: { items: allMails.map((view) => summaryOf(view)), nextCursor: 'more', open: v('member-verified').id },
  'thread-group': { items: [...groupMails.map((view) => summaryOf(view)), summaryOf(v('mixed-attachments'))] },
  'unverified-group': { items: [summaryOf(v('member-verified')), ...quietMails.map((view) => summaryOf(view))] },
  selected: { items: [...groupMails.map((view) => summaryOf(view)), summaryOf(v('revision'))], checked: [groupMails[0].id, groupMails[1].id] },
  'bulk-blocked': { items: allMails.map((view) => summaryOf(view)), checked: [v('member-verified').id, v('impersonation').id] },
  settled: { status: 'handled', items: [summaryOf(v('filed-outcome')), summaryOf(v('decided-by-other')), summaryOf(v('expired')), summaryOf(v('dismissed'))] },
  dismissed: { status: 'handled', outcome: 'dismissed', items: [summaryOf(v('dismissed'))] },
  expired: { status: 'handled', outcome: 'expired', items: [summaryOf(v('expired'))] },
  closed: { closed: true, items: [summaryOf(v('closed')), summaryOf(v('member-verified'))], open: v('closed').id },
  followed: { items: [summaryOf(v('followed')), summaryOf(v('revision'))] },
  'worst-case': {
    items: [summaryOf(v('worst-case')), ...Array.from({ length: 24 }, (_, index) => summaryOf(mail({ key: `bulk-${index}`, subject: index % 2 ? null : `RE: ${'Sehr langer Betreff '.repeat(index % 5)}`, receivedAt: minutesAgo(60 * index) }), { attachments: index * 11, senderName: index % 4 ? null : 'Jo' }))],
    nextCursor: 'more',
    open: v('worst-case').id,
  },
}

// ------------------------------------------------------------ the address

export type AddressFixture = InboundMailAddressView | 'loading' | 'error'

const activeAddress: InboundMailAddressView = {
  state: 'active',
  address: 'bauplatz-12.k3x7q2m9p4ab@piloti.at',
  canManage: true,
  lastReceivedAt: minutesAgo(12),
  droppedLast30Days: 0,
  ownDomainVerifiedShare: 0.94,
}

export const ADDRESS_VARIANTS: Record<string, AddressFixture> = {
  manager: activeAddress,
  member: { ...activeAddress, canManage: false },
  off: { ...activeAddress, state: 'none', address: null, lastReceivedAt: null, ownDomainVerifiedShare: null },
  'off-member': { ...activeAddress, state: 'none', address: null, canManage: false, lastReceivedAt: null, ownDomainVerifiedShare: null },
  unavailable: { ...activeAddress, state: 'unavailable', address: null, canManage: false, lastReceivedAt: null, ownDomainVerifiedShare: null },
  'long-address': {
    ...activeAddress,
    address: 'stellplatznachweis-tiefgarage-ebene-2-wohnbau-seestadt-nord.k3x7q2m9p4ab@piloti.at',
  },
  loading: 'loading',
  error: 'error',
  refusals: { ...activeAddress, droppedLast30Days: 17, lastReceivedAt: minutesAgo(60 * 24 * 3) },
  'own-dkim-missing': { ...activeAddress, ownDomainVerifiedShare: 0 },
}

// ------------------------------------------------------------ clients

const pending = <T,>(): Promise<T> => new Promise<T>(() => {})
const failing = <T,>(): Promise<T> => Promise.reject(new Error('fixture: refused'))

/** A client over the fixtures: reads answer at once, decisions change the fixture in memory. */
export function fixtureClient(options: { list?: ListFixture; detail?: DetailFixture } = {}): InboundMailClient {
  const views = new Map<string, InboundMailView>()
  for (const [id, fixture] of DETAIL_BY_ID) views.set(id, fixture.view)
  if (options.detail) views.set(options.detail.view.id, options.detail.view)
  const texts = (id: string): InboundMailTextView => DETAIL_BY_ID.get(id)?.text ?? options.detail?.text ?? text()
  const settle = (view: InboundMailView): InboundMailView => ({
    ...view,
    parts: view.parts.map((candidate) => (candidate.state === 'filing' ? { ...candidate, state: 'filed', documentId: candidate.documentId ?? fixtureId(`doc:${candidate.id}`) } : candidate)),
  })
  return {
    list: (_projectId, query = {}) => {
      if (options.list?.load === 'loading') return pending()
      if (options.list?.load === 'error') return failing()
      const items = (options.list?.items ?? []).filter((item) => (query.status ?? 'waiting') === item.status)
      const page: InboundMailListView = { items, nextCursor: query.cursor ? null : (options.list?.nextCursor ?? null) }
      return Promise.resolve(page)
    },
    get: (_projectId, mailId) => {
      if (options.detail?.load === 'loading') return pending()
      if (options.detail?.load === 'error') return failing()
      const view = views.get(mailId)
      if (!view) return failing()
      const settled = settle(view)
      views.set(mailId, settled)
      return Promise.resolve(view)
    },
    text: (_projectId, mailId) => (options.detail?.load ? pending() : Promise.resolve(texts(mailId))),
    file: (_projectId, body) => {
      const mails = body.mails.map((decision) => {
        const view = views.get(decision.mailId) as InboundMailView
        const filed = new Set([...decision.parts.map((candidate) => candidate.partId), ...(decision.message ? [decision.message.partId] : [])])
        const next: InboundMailView = {
          ...view,
          ifMatch: `${view.ifMatch}+`,
          parts: view.parts.map((candidate) =>
            candidate.state !== 'waiting' ? candidate : filed.has(candidate.id) ? { ...candidate, state: 'filing' } : { ...candidate, state: 'dismissed', restorableUntil: daysAhead(7) }
          ),
        }
        views.set(view.id, next)
        return next
      })
      return Promise.resolve({ mails, filingJobId: 'job-fixture' })
    },
    dismiss: (_projectId, body) =>
      Promise.resolve({
        mails: body.mailIds.map((id) => {
          const view = views.get(id) as InboundMailView
          const next: InboundMailView = {
            ...view,
            status: 'handled',
            parts: view.parts.map((candidate) => (candidate.state === 'waiting' ? { ...candidate, state: 'dismissed', restorableUntil: daysAhead(7) } : candidate)),
          }
          views.set(id, next)
          return next
        }),
      }),
    restore: (_projectId, mailId) => {
      const view = views.get(mailId) as InboundMailView
      const next: InboundMailView = {
        ...view,
        status: 'waiting',
        parts: view.parts.map((candidate) => (candidate.state === 'dismissed' || candidate.state === 'expired' ? { ...candidate, state: 'waiting', restorableUntil: null } : candidate)),
      }
      views.set(mailId, next)
      return Promise.resolve(next)
    },
    follow: () => Promise.resolve(),
    unfollow: () => Promise.resolve(),
    threadOfDocument: (_projectId, documentId) =>
      Promise.resolve({ id: fixtureId(`thread-of:${documentId}`), documentId, name: 'Stellplatznachweis', entryCount: 3, lastEntryAt: minutesAgo(9), followed: false }),
    // No bytes in a preview: the thumbnails stand as their tiles.
    partContentUrl: () => '',
    originalUrl: () => '',
  }
}

export function fixtureAddressClient(fixture: AddressFixture): InboundMailAddressClient {
  let current = fixture
  const answer = (): Promise<InboundMailAddressView> =>
    current === 'loading' ? pending() : current === 'error' ? failing() : Promise.resolve(current)
  return {
    get: answer,
    create: () => {
      current = activeAddress
      return answer()
    },
    rotate: () => {
      if (typeof current === 'object') current = { ...current, address: 'bauplatz-12.w8n2c4r7t1qz@piloti.at' }
      return answer()
    },
    remove: () => {
      if (typeof current === 'object') current = { ...current, state: 'none', address: null }
      return answer()
    },
  }
}
