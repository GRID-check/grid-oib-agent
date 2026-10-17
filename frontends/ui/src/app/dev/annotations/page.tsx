'use client'

/**
 * Dev preview for Anmerkungen and the review, in the Files preview pane where
 * they ship, against the REAL pane, viewer, room hook and typed client.
 *
 * Three shims at module scope make it backend-free and alive:
 *   - `fetch` answers the annotations API from memory (setting, taking over,
 *     resolving, replying and deleting work exactly as against the API), the
 *     document's bytes (a Grundriss sheet drawn with vector paths below), the
 *     live channel's POST (`/api/realtime/send`), and the two requests the
 *     canvas's turn client makes before its socket opens (the conversation and
 *     the question as its row);
 *   - `EventSource` plays the `doc:<id>` live channel (`/api/realtime`): Anna
 *     Berger moving her pointer across the corridor with a cursor chat now and
 *     then, Jakob Huber dragging out a region over the stair (the others see
 *     the draft grow), their presence claims, and, with `&piloti=1`, Piloti
 *     joining as a peer (pointer with a label, what it reads, a highlight) and
 *     proposing three findings two seconds in;
 *   - `WebSocket`, for `/websocket` only, scripts a Piloti turn on wire v2
 *     (`FakeTurnSocket`): a hello, then for each question an ack, a few steps,
 *     a streamed German answer with one OIB source, and `RUN_FINISHED`. Asked
 *     about a box, Piloti also shows up in the room meanwhile (what it reads,
 *     its pointer, a highlight); asked to review the whole document, it sets
 *     its three proposals; asked in a thread, it answers there as a reply.
 *
 * Routes:
 *   /dev/annotations                         the pane: pins, regions, pointers inline
 *   /dev/annotations?doc=dev-doc-annotations&review=1            the focused review
 *   …&review=1&mark=ann-1                    the review, open at Anmerkung 1
 *   …&review=1&piloti=1                      the review, while Piloti proposes
 *   …&review=1, then `p` and a box           ask Piloti about the box (any route)
 *
 * Not linked from anywhere and 404s outside development (`../layout.tsx`).
 */

import type { JSX } from 'react'
import type { z } from 'zod'
import type { wireEventSchema } from '@/adapters/api/wire-v2'
import { FilePreviewPane } from '@/features/documents/components/file-preview-pane'
import type { FileItem } from '@/features/documents/components/project-file-workspace'
import type { RoomEvent, RoomPeer } from '@/lib/annotations/room-types'
import type { RealtimeFrame } from '@/lib/realtime/types'
import type { AnnotationReplyView, AnnotationView } from '@/lib/annotations/types'
import { assemblePdf, pdfString } from '../_fixtures/sample-pdf'

const SHEET_WIDTH = 842
const SHEET_HEIGHT = 595

/** One A3-landscape sheet: a Grundriss with a corridor, rooms, doors and a stair, and a title block. */
const sheetContent = (): string => {
  const ops: string[] = ['0 0 0 RG']
  const rect = (x: number, y: number, w: number, h: number, width = 0.8) =>
    ops.push(`${width} w ${x} ${y} ${w} ${h} re S`)
  const line = (x1: number, y1: number, x2: number, y2: number, width = 0.5) =>
    ops.push(`${width} w ${x1} ${y1} m ${x2} ${y2} l S`)
  const text = (x: number, y: number, size: number, value: string, bold = false) =>
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfString(value)}) Tj ET`)

  rect(50, 80, 520, 420, 2.4)
  line(50, 270, 570, 270, 1.2)
  line(50, 320, 570, 320, 1.2)
  for (const x of [190, 330, 450]) {
    line(x, 320, x, 500, 1.2)
    line(x, 80, x, 270, 1.2)
  }
  for (const x of [110, 250, 380, 500]) {
    ops.push(`1 1 1 RG 3 w ${x} 320 m ${x + 26} 320 l S 0 0 0 RG`)
    line(x, 320, x, 346, 0.4)
  }
  rect(470, 110, 80, 140, 0.8)
  for (let step = 0; step <= 9; step += 1) line(470, 110 + step * 14, 550, 110 + step * 14, 0.5)
  for (const [x, y] of [
    [90, 500],
    [230, 500],
    [90, 80],
    [230, 80],
  ]) {
    ops.push(`1 1 1 RG 3 w ${x} ${y} m ${x + 60} ${y} l S 0 0 0 RG`)
    line(x, y - 2, x + 60, y - 2, 0.4)
    line(x, y + 2, x + 60, y + 2, 0.4)
  }
  text(90, 420, 10, 'Wohnen 1')
  text(230, 420, 10, 'Wohnen 2')
  text(370, 420, 10, 'Bad')
  text(480, 420, 10, 'Technik')
  text(90, 180, 10, 'Zimmer 1')
  text(230, 180, 10, 'Zimmer 2')
  text(360, 180, 10, 'Abstellraum')
  text(478, 258, 9, 'Stiege')
  text(240, 292, 10, 'Gang (Fluchtweg)')
  text(50, 515, 12, 'Grundriss Regelgeschoss  1:100', true)
  rect(600, 40, 220, 70, 0.8)
  text(612, 88, 10, 'Wohnbau Nord', true)
  text(612, 70, 9, 'Grundriss RG, Index C')
  text(612, 54, 9, 'Architektur Muster ZT GmbH')
  return ops.join('\n') + '\n'
}

const buildSheet = (): Uint8Array<ArrayBuffer> => {
  const content = sheetContent()
  return assemblePdf([
    '<</Type/Catalog/Pages 2 0 R>>',
    // Two sheets of the same drawing: a colleague on the second shows at the edge of the first.
    '<</Type/Pages/Kids[3 0 R 7 0 R]/Count 2>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${SHEET_WIDTH} ${SHEET_HEIGHT}]` +
      '/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${content.length}>>\nstream\n${content}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${SHEET_WIDTH} ${SHEET_HEIGHT}]` +
      '/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>',
  ])
}

const FILE: FileItem = {
  id: 'dev-doc-annotations',
  filename: 'Grundriss_RG_Index-C.pdf',
  displayName: null,
  fileSize: 412_000,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-10-01T09:00:00Z',
  errorMessage: null,
  summary: 'Grundriss des Regelgeschosses im Maßstab 1:100 mit Gang, fünf Räumen, Bad, Technik und Stiege.',
  pageCount: 2,
  chunkCount: 3,
  contentTypes: ['drawing', 'text'],
  tags: ['Grundriss'],
  topics: null,
  capture: null,
  versionCount: 3,
  assignees: [{ userId: 'u-1', name: 'Miriam Hofer', email: 'm.hofer@example.at', profilePictureUrl: null }],
}

const ME = { userId: 'u-1', name: 'Miriam Hofer' }
const ANNA = { userId: 'u-2', name: 'Anna Berger' }
const JAKOB = { userId: 'u-3', name: 'Jakob Huber' }
const LENA = { userId: 'u-4', name: 'Lena Gruber' }
const NAMES: Record<string, string> = { 'u-1': ME.name, 'u-2': ANNA.name, 'u-3': JAKOB.name, 'u-4': LENA.name }

/** A point on the sheet in PDF points (bottom-left origin), as a share of the page (top-left). */
const pt = (x: number, y: number) => ({ x: +(x / SHEET_WIDTH).toFixed(4), y: +(1 - y / SHEET_HEIGHT).toFixed(4) })
/** A region from two corners in PDF points. */
const region = (x0: number, y0: number, x1: number, y1: number) => {
  const a = pt(x0, y1)
  return { x: a.x, y: a.y, w: +((x1 - x0) / SHEET_WIDTH).toFixed(4), h: +((y1 - y0) / SHEET_HEIGHT).toFixed(4) }
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const base = {
  documentId: FILE.id,
  page: 1,
  w: null,
  h: null,
  basis: null,
  fassungNumber: 3,
  onCurrentFassung: true,
  createdBy: 'u-1',
  createdByName: ME.name,
  createdAt: minutesAgo(140),
  updatedAt: minutesAgo(140),
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  authorKind: 'person' as const,
  status: 'open' as const,
  acceptedBy: null,
  acceptedByName: null,
  closedBy: null,
  closedByName: null,
  closedAt: null,
  delegatedBy: null,
  delegatedByName: null,
  delegatedAt: null,
  replies: [] as AnnotationReplyView[],
  canEdit: true,
  canDelete: true,
}

const reply = (annotationId: string, by: { userId: string; name: string }, minutes: number, body: string): AnnotationReplyView => ({
  id: `${annotationId}-r${minutes}`,
  annotationId,
  authorKind: 'person',
  body,
  createdBy: by.userId,
  createdByName: by.name,
  createdAt: minutesAgo(minutes),
  addressesPiloti: false,
})

let annotations: AnnotationView[] = [
  {
    ...base,
    id: 'ann-1',
    number: 1,
    shape: 'point',
    ...pt(263, 333),
    kind: 'defect',
    body: 'Tür von Wohnen 2 in den Fluchtweg ohne Angabe der Feuerwiderstandsklasse. EI2 30-C eintragen.',
    assigneeUserId: 'u-2',
    assigneeName: ANNA.name,
    dueOn: '2026-10-10',
    replies: [
      reply('ann-1', ANNA, 95, 'Kommt mit Index D. Gilt das auch für die Tür vom Bad?'),
      reply('ann-1', ME, 80, 'Nein, Bad geht nicht in den Gang. Nur Wohnen 1 und 2.'),
    ],
  },
  {
    ...base,
    id: 'ann-2',
    number: 2,
    shape: 'region',
    ...region(470, 110, 550, 250),
    kind: 'question',
    body: 'Laufbreite der Stiege an die Statik: 1,20 m oder 1,10 m zwischen den Wangen?',
    createdBy: 'u-3',
    createdByName: JAKOB.name,
    canDelete: false,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
    // Piloti works it for Jakob (ADR-0105): the delegate chip in the thread.
    delegatedBy: 'u-3',
    delegatedByName: JAKOB.name,
    delegatedAt: minutesAgo(20),
  },
  {
    ...base,
    id: 'ann-3',
    number: 3,
    shape: 'point',
    ...pt(380, 440),
    kind: 'hint',
    body: 'Bad: Lüftung über Dach, Schacht im Technikraum.',
    status: 'resolved',
    closedBy: 'u-2',
    closedByName: ANNA.name,
    closedAt: minutesAgo(30),
  },
  {
    ...base,
    id: 'ann-4',
    number: 4,
    shape: 'point',
    ...pt(120, 200),
    kind: 'defect',
    body: 'Fensterbrüstung Zimmer 1 unter 1,00 m.',
    fassungNumber: 2,
    onCurrentFassung: false,
  },
]
let nextNumber = 5

const PILOTI_PROPOSALS: AnnotationView[] = [
  {
    ...base,
    id: 'ann-p1',
    number: 0,
    shape: 'region',
    ...region(50, 270, 570, 320),
    kind: 'question',
    body: 'Gang als Fluchtweg: lichte Breite ist nicht kotiert. Mindestens 1,20 m nachweisen.',
    basis: 'OIB-RL 4, Pkt. 2.2.1',
    authorKind: 'piloti',
    status: 'proposed',
    canDelete: false,
  },
  {
    ...base,
    id: 'ann-p2',
    number: 0,
    shape: 'point',
    ...pt(500, 333),
    kind: 'defect',
    body: 'Tür Technik in den Fluchtweg: Feuerwiderstand fehlt, Technikraum gilt als Raum mit erhöhter Brandgefahr.',
    basis: 'OIB-RL 2, Pkt. 3.4',
    authorKind: 'piloti',
    status: 'proposed',
    canDelete: false,
  },
  {
    ...base,
    id: 'ann-p3',
    number: 0,
    shape: 'region',
    ...region(90, 76, 150, 84),
    kind: 'hint',
    body: 'Belichtung Zimmer 1: Fensterfläche gegen 1/10 der Bodenfläche prüfen.',
    basis: 'OIB-RL 3, Pkt. 9.1.1',
    authorKind: 'piloti',
    status: 'proposed',
    canDelete: false,
  },
]

// ── the room ────────────────────────────────────────────────────────────────

/** The document's live channel, as `/api/realtime?ch=` names it. */
const CHANNEL = `doc:${FILE.id}`
type Listener = (frame: RealtimeFrame) => void
const sources = new Set<Listener>()
const broadcast = (event: RoomEvent) => sources.forEach((listener) => listener({ kind: 'event', ch: CHANNEL, event }))
const peer = (who: { userId: string; name: string }, peerId: string): RoomPeer => ({ ...who, peerId, kind: 'person' })
const annaPeer = peer(ANNA, 'peer-anna-0001')
const jakobPeer = peer(JAKOB, 'peer-jakob-001')
const lenaPeer = peer(LENA, 'peer-lena-0001')
/** Piloti in the room, as `publishAsAgent` names it: on behalf of the person who asked. */
const pilotiPeer: RoomPeer = { peerId: 'piloti-dev-conv', userId: ME.userId, name: 'Piloti', kind: 'piloti' }

/** `?wakes=1`: the organization lets events wake Piloti, so the server answers an @Piloti reply. */
const WAKES = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('wakes')

/** The server's wake, answered: Piloti's reply arrives through the room, as it would from the job. */
const wakeReply = (annotationId: string) => {
  const answer: AnnotationReplyView = {
    ...reply(annotationId, ME, 0, 'Im Schnitt B-B sind 1,20 m zwischen den Wangen kotiert; die Statik rechnet mit 1,10 m.'),
    id: `${annotationId}-wake-${Date.now()}`,
    authorKind: 'piloti',
    createdByName: 'Piloti',
  }
  annotations = annotations.map((one) => (one.id === annotationId ? { ...one, replies: [...one.replies, answer] } : one))
  broadcast({
    kind: 'annotations.changed',
    annotationIds: [annotationId],
    change: 'replied',
    actor: { peerId: null, userId: ME.userId, name: 'Piloti', kind: 'piloti' },
  })
}

/** Piloti's three findings, once: the `?piloti=1` script and a whole-document review both set them. */
const proposeFindings = () => {
  const fresh = PILOTI_PROPOSALS.filter((proposal) => !annotations.some((annotation) => annotation.id === proposal.id))
  if (fresh.length === 0) return
  const proposed = fresh.map((proposal) => ({ ...proposal, number: nextNumber++, createdAt: new Date().toISOString() }))
  annotations = [...annotations, ...proposed]
  broadcast({
    kind: 'annotations.changed',
    annotationIds: proposed.map((proposal) => proposal.id),
    change: 'created',
    actor: { peerId: null, userId: ME.userId, name: 'Piloti', kind: 'piloti' },
  })
}

/** Jakob's drag: from the stair's corner, growing for three seconds, then let go for three. */
const jakobDraft = (s: number) => {
  const phase = s % 6
  if (phase > 3) return null
  const grow = Math.min(1, phase / 2.4)
  return { x: 0.558, y: 0.58, w: +(0.005 + 0.09 * grow).toFixed(4), h: +(0.005 + 0.23 * grow).toFixed(4) }
}

let started = false
function startRoom(withPiloti: boolean) {
  if (started) return
  started = true
  const t0 = performance.now()
  const everyone = [annaPeer, jakobPeer, lenaPeer]
  for (const who of everyone) broadcast({ kind: 'presence', peer: who, state: 'here', ttlMs: 25_000 })
  setInterval(() => {
    for (const who of everyone) broadcast({ kind: 'presence', peer: who, state: 'here', ttlMs: 25_000 })
  }, 8_000)
  // Anna has Anmerkung 1 open: the others see it ringed in her colour, with her name.
  broadcast({ kind: 'viewport', peer: annaPeer, viewport: { page: 1, y: 0.45 }, selected: 'ann-1' })
  // Lena reads the second sheet, still: an edge chip says where she is, and her pointer rests.
  broadcast({ kind: 'viewport', peer: lenaPeer, viewport: { page: 2, y: 0.4 } })
  broadcast({ kind: 'cursor', peer: lenaPeer, tool: 'select', cursor: { page: 2, x: 0.42, y: 0.38 } })
  setInterval(() => {
    const s = (performance.now() - t0) / 1000
    // Anna walks the corridor, pausing at the doors, and now and then says so beside her pointer.
    const along = 0.18 + 0.28 * (0.5 + 0.5 * Math.sin(s * 0.55))
    broadcast({
      kind: 'cursor',
      peer: annaPeer,
      tool: 'select',
      cursor: { page: 1, x: along, y: 0.44 + 0.015 * Math.sin(s * 2.1) },
      chat: s % 12 > 7 ? 'Hier fehlt die Kote' : null,
    })
    // Jakob drags out a region over the stair, and the others see it grow.
    const draft = jakobDraft(s)
    broadcast({
      kind: 'cursor',
      peer: jakobPeer,
      tool: 'region',
      cursor: draft
        ? { page: 1, x: draft.x + draft.w, y: draft.y + draft.h }
        : { page: 1, x: 0.62 + 0.03 * Math.cos(s * 0.9), y: 0.36 + 0.06 * Math.sin(s * 0.9) },
      draft,
    })
  }, 80)
  if (withPiloti) {
    // Piloti joins, reads the corridor (pointer, activity, a highlight), then proposes; as `publishAsAgent` would say it.
    const piloti = pilotiPeer
    const corridor = { page: 1, ...region(50, 270, 570, 320) }
    broadcast({ kind: 'presence', peer: piloti, state: 'here', ttlMs: 25_000 })
    broadcast({ kind: 'activity', peer: piloti, state: 'reading', box: corridor, label: 'sieht sich den Gang an' })
    broadcast({ kind: 'cursor', peer: piloti, cursor: { page: 1, ...pt(300, 295) }, tool: 'select', label: 'Fluchtweg' })
    setTimeout(() => broadcast({ kind: 'highlight', peer: piloti, box: corridor, label: 'Breite nicht kotiert', ttlMs: 6_000 }), 900)
    setTimeout(() => broadcast({ kind: 'activity', peer: piloti, state: 'idle' }), 2400)
    setInterval(() => broadcast({ kind: 'presence', peer: piloti, state: 'here', ttlMs: 25_000 }), 8_000)
    setTimeout(proposeFindings, 2200)
  }
}

/** Plays `GET /api/realtime?ch=…`: a welcome, then the room's frames when the document's channel is asked for. */
class RoomEventSource {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  private readonly listener: Listener = (frame) => this.onmessage?.({ data: JSON.stringify(frame) })
  constructor(readonly url: string) {
    setTimeout(() => {
      this.onopen?.()
      this.listener({ kind: 'welcome', self: { ...ME, kind: 'person' } })
      const channels = new URL(url, window.location.origin).searchParams.getAll('ch')
      if (!channels.includes(CHANNEL)) return
      sources.add(this.listener)
      startRoom(new URLSearchParams(window.location.search).has('piloti'))
    }, 50)
  }
  close() {
    sources.delete(this.listener)
  }
}

// ── Piloti's turn ───────────────────────────────────────────────────────────

/** A server-to-client event as the script writes it: `emit` adds the envelope (`v`, ids, `seq`, `ts`). */
type Unenveloped<F> = F extends unknown ? Omit<F, 'v' | 'seq' | 'ts' | 'turn_id' | 'conversation_id'> : never
type WireBody = Unenveloped<z.input<typeof wireEventSchema>>

/** The optional client fields this server reads, as its hello names them: all the canvas sends. */
const ACCEPTS = ['user_message.focus_region', 'user_message.reply_in_thread', 'cancel_turn.shown']
/** Between two deltas of the answer. */
const DELTA_MS = 120
const DELTAS = 10

/** The box a question is about (`user_message.focus_region`). */
interface FocusBox {
  page: number
  x: number
  y: number
  w: number
  h: number
  annotationId: string | null
}

interface ScriptedTurn {
  turnId: string
  conversationId: string
  messageId: string
  /** Every frame sent, for `attach`. */
  log: Record<string, unknown>[]
  /** The socket the turn streams to; a reopened one takes it over by attaching. */
  socket: FakeTurnSocket | null
  /** The script's next step, which a Stop clears. */
  timer: ReturnType<typeof setTimeout> | null
  text: string
  done: boolean
}

const turns = new Map<string, ScriptedTurn>()

/** The script must never throw into the client: a slip is logged and the turn goes on. */
const safely = (run: () => void) => {
  try {
    run()
  } catch (error) {
    console.warn('[dev/annotations] scripted turn', error)
  }
}

const CORRIDOR = region(50, 270, 570, 320)
/** The box is about the corridor when its middle sits in the corridor's band. */
const onCorridor = (box: FocusBox) => {
  const middle = box.y + box.h / 2
  return middle > CORRIDOR.y - 0.03 && middle < CORRIDOR.y + CORRIDOR.h + 0.03
}

const OIB_RL_4 = {
  content: 'Gänge im Verlauf von Fluchtwegen müssen eine lichte Breite von mindestens 1,20 m aufweisen.',
  file_name: 'OIB-Richtlinie 4 · Nutzungssicherheit und Barrierefreiheit',
  number: 1,
  page: 4,
}

const CORRIDOR_ANSWER =
  'Der Ausschnitt zeigt den Gang (Fluchtweg) zwischen Wohnen 1 und Zimmer 1. Die lichte Breite ist im Ausschnitt nicht kotiert; ' +
  'nach OIB-RL 4, Pkt. 2.2.1 braucht ein Fluchtweg hier mindestens 1,20 m [1]. Abgegriffen im Maßstab 1:100 sind es rund 1,75 m, ' +
  'das reicht. Die Kote sollte trotzdem in die Zeichnung, sonst ist der Nachweis nicht geführt.'
const BOX_ANSWER =
  'Der Ausschnitt zeigt einen Teil des Regelgeschosses im Maßstab 1:100. Maße sind darin nicht kotiert, deshalb lässt sich ' +
  'gegen OIB-RL 4 nichts nachweisen [1]. Mit einer Bemaßung im Ausschnitt prüfe ich Breiten und Durchgänge gern nach.'
/** In a thread, as a reply: plain text, about the Anmerkung it answers. */
const threadAnswer = (number: number) =>
  `Zu Anmerkung ${number}: Ich habe mir die Stelle angesehen. In dieser Fassung ist dazu noch nichts eingetragen; ` +
  'ich würde die Angabe mit der nächsten Fassung nachfordern und die Anmerkung bis dahin offen lassen.'
const REVIEW_ANSWER =
  'Ich habe den Grundriss durchgesehen und drei Vorschläge gesetzt: die nicht kotierte Breite des Gangs (Fluchtweg), ' +
  'den fehlenden Feuerwiderstand der Tür zum Technikraum und die Belichtung von Zimmer 1. ' +
  'Sie stehen als Vorschläge in der Liste; übernehmen oder verwerfen Sie sie dort.'

/** The answer in about {@link DELTAS} pieces, cut between words, as a model streams it. */
const deltasOf = (text: string): string[] => {
  const words = text.split(/(?<= )/)
  const size = Math.ceil(words.length / DELTAS)
  return Array.from({ length: Math.ceil(words.length / size) }, (_, index) => words.slice(index * size, (index + 1) * size).join(''))
}

const emit = (turn: ScriptedTurn, body: WireBody) => {
  const frame = { v: 2, conversation_id: turn.conversationId, turn_id: turn.turnId, seq: turn.log.length + 1, ts: Date.now(), ...body }
  turn.log.push(frame)
  turn.socket?.deliver(frame)
}

/**
 * Run `steps` one after another, each `after` ms behind the one before. Chained
 * rather than scheduled up front, so a busy main thread delays the rest instead
 * of bunching the deltas. A Stop clears what is left.
 */
const play = (turn: ScriptedTurn, steps: ReadonlyArray<readonly [after: number, run: () => void]>, index = 0) => {
  const step = steps[index]
  if (!step) return
  turn.timer = setTimeout(() => {
    if (turn.done) return
    safely(step[1])
    play(turn, steps, index + 1)
  }, step[0])
}

/** The answer streamed: start, deltas, end. */
const streamAnswer = (turn: ScriptedTurn, text: string): Array<readonly [number, () => void]> => [
  [400, () => emit(turn, { type: 'TEXT_MESSAGE_START', message_id: turn.messageId })],
  ...deltasOf(text).map(
    (delta) =>
      [
        DELTA_MS,
        () => {
          turn.text += delta
          emit(turn, { type: 'TEXT_MESSAGE_CONTENT', message_id: turn.messageId, delta })
        },
      ] as const
  ),
  [DELTA_MS, () => emit(turn, { type: 'TEXT_MESSAGE_END', message_id: turn.messageId })],
]

const finish = (turn: ScriptedTurn, text: string, sources: (typeof OIB_RL_4)[]) => {
  emit(turn, { type: 'RUN_FINISHED', outcome: 'answered', result: { message_id: turn.messageId, text, sources } })
  turn.done = true
  broadcast({ kind: 'activity', peer: pilotiPeer, state: 'idle' })
}

const synthesis = { id: 'step-synthesis', kind: 'status', slot: 'synthesis', key: 'status.synthesis' } as const

/**
 * A question about a box: Piloti reads the crop (the live line keeps the card's
 * own „Sieht sich den Ausschnitt an …", because a tool step says nothing), then
 * the OIB passage, then writes. In the room meanwhile: present, reading the
 * box, its pointer in the middle of it, and a highlight.
 */
const answerAboutBox = (turn: ScriptedTurn, box: FocusBox, replyInThread: boolean) => {
  const corridor = onCorridor(box)
  const thread = replyInThread && box.annotationId ? annotations.find((one) => one.id === box.annotationId) : undefined
  const text = thread ? threadAnswer(thread.number) : corridor ? CORRIDOR_ANSWER : BOX_ANSWER
  const mark = thread ? `Anmerkung ${thread.number}` : corridor ? 'Breite nicht kotiert' : 'Keine Maße im Ausschnitt'
  const roomBox = { page: box.page, x: box.x, y: box.y, w: box.w, h: box.h }
  const view = { id: 'step-view', kind: 'tool', tool: 'view_knowledge_image' } as const
  // In a thread it reads the Anmerkung and writes a reply; about a box, it reads the OIB passage and writes the answer.
  const reading = thread
    ? ({ id: 'step-read', kind: 'status', slot: 'annotations', key: 'status.action.annotationsRead' } as const)
    : ({
        id: 'step-punkt',
        kind: 'status',
        slot: 'retrieval',
        key: 'status.retrieval.punkt',
        values: { document: 'OIB-RL 4', punkt: '2.2.1' },
      } as const)
  const writing = thread
    ? ({ id: 'step-reply', kind: 'status', slot: 'annotations', key: 'status.action.annotationsReply' } as const)
    : synthesis
  play(turn, [
    [
      150,
      () => {
        emit(turn, { type: 'RUN_STARTED', message_id: turn.messageId })
        broadcast({ kind: 'presence', peer: pilotiPeer, state: 'here', ttlMs: 25_000 })
        broadcast({ kind: 'activity', peer: pilotiPeer, state: 'reading', box: roomBox, label: 'sieht sich den Ausschnitt an' })
        broadcast({
          kind: 'cursor',
          peer: pilotiPeer,
          tool: 'select',
          cursor: { page: box.page, x: box.x + box.w / 2, y: box.y + box.h / 2 },
          label: 'Hier',
        })
      },
    ],
    [100, () => emit(turn, { type: 'STEP_STARTED', step: { ...view, status: 'running' } })],
    [
      600,
      () =>
        broadcast({
          kind: 'highlight',
          peer: pilotiPeer,
          box: roomBox,
          label: mark,
          ttlMs: 8_000,
        }),
    ],
    [
      700,
      () => {
        emit(turn, { type: 'STEP_FINISHED', step: { ...view, status: 'ok' } })
        emit(turn, { type: 'STEP_STARTED', step: reading })
      },
    ],
    [
      800,
      () => {
        emit(turn, { type: 'STEP_FINISHED', step: reading })
        emit(turn, { type: 'STEP_STARTED', step: writing })
        if (thread) return
        emit(turn, {
          type: 'STEP_FINISHED',
          step: {
            id: 'step-sources',
            kind: 'sources',
            tool: 'search_knowledge',
            lanes: [
              {
                key: 'oib',
                kind: 'baurecht',
                label: 'OIB-Richtlinien',
                hit_count: 1,
                sources: [{ name: 'OIB-RL_4_2023.pdf', title: OIB_RL_4.file_name, detail: 'Pkt. 2.2.1 S. 4' }],
              },
            ],
          },
        })
      },
    ],
    ...streamAnswer(turn, text),
    [
      0,
      () => {
        emit(turn, { type: 'STEP_FINISHED', step: writing })
        if (thread) {
          const answer: AnnotationReplyView = {
            ...reply(thread.id, ME, 0, text),
            id: `${thread.id}-${turn.messageId}`,
            authorKind: 'piloti',
            createdByName: 'Piloti',
          }
          annotations = annotations.map((one) => (one.id === thread.id ? { ...one, replies: [...one.replies, answer] } : one))
          broadcast({
            kind: 'annotations.changed',
            annotationIds: [thread.id],
            change: 'replied',
            actor: { peerId: null, userId: ME.userId, name: 'Piloti', kind: 'piloti' },
          })
        }
        finish(turn, text, thread ? [] : [OIB_RL_4])
      },
    ],
  ])
}

/** „Piloti prüfen lassen": it reads the Anmerkungen, goes over the page, sets its three proposals and says so. */
const reviewDocument = (turn: ScriptedTurn) => {
  const read = { id: 'step-read', kind: 'status', slot: 'annotations', key: 'status.action.annotationsRead' } as const
  const propose = { id: 'step-propose', kind: 'status', slot: 'annotations', key: 'status.action.annotationsPropose' } as const
  play(turn, [
    [
      150,
      () => {
        emit(turn, { type: 'RUN_STARTED', message_id: turn.messageId })
        emit(turn, { type: 'STEP_STARTED', step: read })
        broadcast({ kind: 'presence', peer: pilotiPeer, state: 'here', ttlMs: 25_000 })
        broadcast({
          kind: 'activity',
          peer: pilotiPeer,
          state: 'reading',
          box: { page: 1, x: 0, y: 0, w: 1, h: 1 },
          label: 'geht das Dokument durch',
        })
      },
    ],
    [
      900,
      () => {
        emit(turn, { type: 'STEP_FINISHED', step: read })
        emit(turn, { type: 'STEP_STARTED', step: propose })
      },
    ],
    [
      900,
      () => {
        proposeFindings()
        emit(turn, { type: 'STEP_FINISHED', step: propose })
        emit(turn, { type: 'STEP_STARTED', step: synthesis })
      },
    ],
    ...streamAnswer(turn, REVIEW_ANSWER),
    [
      0,
      () => {
        emit(turn, { type: 'STEP_FINISHED', step: synthesis })
        finish(turn, REVIEW_ANSWER, [])
      },
    ],
  ])
}

/** A Stop: what is left of the script is dropped, and the turn ends cancelled with what it had written. */
const stopTurn = (turn: ScriptedTurn) => {
  if (turn.timer) clearTimeout(turn.timer)
  turn.timer = null
  if (turn.done) return
  emit(turn, { type: 'RUN_FINISHED', outcome: 'cancelled', result: { message_id: turn.messageId, text: turn.text } })
  turn.done = true
  broadcast({ kind: 'activity', peer: pilotiPeer, state: 'idle' })
}

const stringOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

const focusOf = (raw: unknown): FocusBox | null => {
  if (!raw || typeof raw !== 'object') return null
  const { page, x, y, w, h, annotation_id: annotationId } = raw as Record<string, unknown>
  const numbers = [page, x, y, w, h]
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
  const [p, bx, by, bw, bh] = numbers as number[]
  return { page: p, x: bx, y: by, w: bw, h: bh, annotationId: stringOf(annotationId) }
}

type RejectedCode = 'duplicate_turn' | 'turn_not_found' | 'invalid_message' | 'no_pending_interaction'
type RejectedOf = 'user_message' | 'interaction_response' | 'cancel_turn' | 'attach' | 'unknown'

/**
 * `/websocket?v=2` with nobody behind it but the script: a hello naming the
 * canvas's fields, then each `user_message` acked (`RUN_STARTED`) and answered;
 * `attach` replays a turn from its seq, `cancel_turn` stops one, anything else
 * is refused the way the server refuses it. Only the methods and handlers
 * `turn-socket.ts` uses.
 */
class FakeTurnSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(readonly url: string) {
    setTimeout(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.(new Event('open'))
      this.deliver({ type: 'CUSTOM', name: 'hello', v: 2, ts: Date.now(), value: { build: 'dev-annotations', accepts: ACCEPTS } })
    }, 40)
  }

  /** One frame down, after what is already on its way. */
  deliver(frame: unknown) {
    setTimeout(() => {
      if (this.readyState === 1) safely(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })))
    }, 0)
  }

  send(data: unknown) {
    safely(() => this.receive(String(data)))
  }

  close(code = 1000) {
    if (this.readyState >= 2) return
    this.readyState = 3
    for (const turn of turns.values()) if (turn.socket === this) turn.socket = null
    setTimeout(() => safely(() => this.onclose?.(new CloseEvent('close', { code, wasClean: true }))), 0)
  }

  addEventListener() {}
  removeEventListener() {}

  private reject(code: RejectedCode, of: RejectedOf, ids: { conversation_id?: unknown; turn_id?: unknown }) {
    this.deliver({
      type: 'CUSTOM',
      name: 'rejected',
      v: 2,
      seq: 0,
      ts: Date.now(),
      conversation_id: stringOf(ids.conversation_id) ?? 'unknown',
      turn_id: stringOf(ids.turn_id) ?? 'unknown',
      value: { code, of, message: null },
    })
  }

  private receive(data: string) {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(data) as Record<string, unknown>
    } catch {
      return this.reject('invalid_message', 'unknown', {})
    }
    switch (message.type) {
      case 'user_message':
        return this.ask(message)
      case 'attach':
        return this.attach(message)
      case 'cancel_turn': {
        const turn = turns.get(String(message.turn_id))
        return turn ? stopTurn(turn) : this.reject('turn_not_found', 'cancel_turn', message)
      }
      case 'interaction_response':
        return this.reject('no_pending_interaction', 'interaction_response', message)
      default:
        return this.reject('invalid_message', 'unknown', message)
    }
  }

  private ask(message: Record<string, unknown>) {
    const turnId = stringOf(message.message_id)
    const conversationId = stringOf(message.conversation_id)
    if (!turnId || !conversationId || !stringOf(message.text)) return this.reject('invalid_message', 'user_message', message)
    if (turns.has(turnId)) return this.reject('duplicate_turn', 'user_message', message)
    const turn: ScriptedTurn = {
      turnId,
      conversationId,
      messageId: `${turnId}-answer`,
      log: [],
      socket: this,
      timer: null,
      text: '',
      done: false,
    }
    turns.set(turnId, turn)
    const box = focusOf(message.focus_region)
    if (box) answerAboutBox(turn, box, message.reply_in_thread === true)
    else reviewDocument(turn)
  }

  private attach(message: Record<string, unknown>) {
    const turn = turns.get(String(message.turn_id))
    if (!turn) return this.reject('turn_not_found', 'attach', message)
    turn.socket = this
    const after = typeof message.after_seq === 'number' ? message.after_seq : 0
    for (const frame of turn.log) if (Number(frame.seq) > after) this.deliver(frame)
  }
}

/** The chat socket's path; every other socket (the dev server's own) is the real one. */
const isTurnSocket = (url: string | URL) => {
  try {
    return new URL(String(url), window.location.href).pathname === '/websocket'
  } catch {
    return false
  }
}

// ── the API ─────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => Response.json(body, { status })

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __annotationsShim?: boolean; EventSource: unknown }
  if (!w.__annotationsShim) {
    w.__annotationsShim = true
    w.EventSource = RoomEventSource
    // The chat socket is the script; any other socket (the dev server's own) is the real one.
    window.WebSocket = new Proxy(window.WebSocket, {
      construct: (target, args: ConstructorParameters<typeof WebSocket>) =>
        isTurnSocket(args[0]) ? new FakeTurnSocket(String(args[0])) : Reflect.construct(target, args),
    })
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = () => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (url.endsWith('/api/realtime/send')) return new Response(null, { status: 204 })
      const replies = new RegExp(`/api/documents/${FILE.id}/annotations/([^/?]+)/replies$`).exec(url)
      if (replies) {
        const current = annotations.find((annotation) => annotation.id === replies[1])
        if (!current) return json({ error: 'Not found', code: 'NOT_FOUND' }, 404)
        const input = body()
        const added = { ...reply(current.id, ME, 0, String(input.body).trim()), addressesPiloti: input.addressesPiloti === true }
        const next = { ...current, replies: [...current.replies, added], updatedAt: new Date().toISOString() }
        annotations = annotations.map((annotation) => (annotation.id === next.id ? next : annotation))
        // `?wakes=1`: the organization's switch is on, so the server answers an
        // @Piloti reply itself (ADR-0106); here, a moment later, through the room.
        const wake = !added.addressesPiloti ? 'none' : WAKES ? 'queued' : 'off'
        if (wake === 'queued') setTimeout(() => wakeReply(current.id), 4_000)
        return json({ annotation: next, replyId: added.id, wake }, 201)
      }
      const one = new RegExp(`/api/documents/${FILE.id}/annotations/([^/?]+)$`).exec(url)
      if (one) {
        const current = annotations.find((annotation) => annotation.id === one[1])
        if (!current) return json({ error: 'Not found', code: 'NOT_FOUND' }, 404)
        // What a room hint names, read again on its own.
        if (method === 'GET') return json({ annotation: current })
        if (method === 'DELETE') {
          annotations = annotations.filter((annotation) => annotation.id !== current.id)
          return new Response(null, { status: 204 })
        }
        const { delegateToPiloti, ...change } = body() as Partial<AnnotationView> & { delegateToPiloti?: boolean }
        const now = new Date().toISOString()
        const delegation =
          delegateToPiloti === undefined
            ? {}
            : delegateToPiloti
              ? { delegatedBy: ME.userId, delegatedByName: ME.name, delegatedAt: now }
              : { delegatedBy: null, delegatedByName: null, delegatedAt: null }
        const status = change.status ?? current.status
        const moved = status !== current.status
        const next: AnnotationView = {
          ...current,
          ...change,
          ...delegation,
          status,
          ...(change.assigneeUserId !== undefined ? { assigneeName: change.assigneeUserId ? NAMES[change.assigneeUserId] ?? null : null } : {}),
          ...(moved && (status === 'resolved' || status === 'dismissed')
            ? { closedBy: ME.userId, closedByName: ME.name, closedAt: now }
            : {}),
          ...(moved && status === 'open' ? { closedBy: null, closedByName: null, closedAt: null } : {}),
          ...(moved && status === 'open' && current.authorKind === 'piloti' && !current.acceptedBy
            ? { acceptedBy: ME.userId, acceptedByName: ME.name }
            : {}),
          updatedAt: now,
        }
        annotations = annotations.map((annotation) => (annotation.id === next.id ? next : annotation))
        return json({ annotation: next, ...(delegateToPiloti ? { wake: 'queued' } : {}) })
      }
      if (url.endsWith(`/api/documents/${FILE.id}/annotations`)) {
        if (method === 'POST') {
          const input = body() as Pick<AnnotationView, 'page' | 'shape' | 'x' | 'y' | 'w' | 'h' | 'kind' | 'body' | 'assigneeUserId' | 'dueOn'>
          const created: AnnotationView = {
            ...base,
            ...input,
            w: input.w ?? null,
            h: input.h ?? null,
            body: input.body.trim(),
            assigneeUserId: input.assigneeUserId ?? null,
            assigneeName: input.assigneeUserId ? NAMES[input.assigneeUserId] ?? null : null,
            dueOn: input.dueOn ?? null,
            id: `ann-${nextNumber}`,
            number: nextNumber,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          nextNumber += 1
          annotations = [...annotations, created]
          return json({ annotation: created }, 201)
        }
        return json({ annotations, canAnnotate: true, pilotiWakes: WAKES })
      }
      // The person's own thread about the document, which the canvas asks in.
      if (method === 'POST' && url.endsWith(`/api/documents/${FILE.id}/thread`)) {
        return json({ conversationId: 's_dev_document_thread' })
      }
      if (url.endsWith(`/api/documents/${FILE.id}/file`)) {
        return new Response(buildSheet(), { headers: { 'Content-Type': 'application/pdf' } })
      }
      // The canvas's turn client, before its socket opens: the document's conversation, then the question as its row.
      if (method === 'POST' && /\/api\/conversations$/.test(url)) {
        const input = body()
        const now = new Date().toISOString()
        return json(
          {
            id: input.id,
            title: input.title ?? null,
            projectId: input.projectId ?? null,
            subjectResourceType: input.subjectResourceType ?? null,
            subjectResourceId: input.subjectResourceId ?? null,
            visibility: 'private',
            createdBy: ME.userId,
            createdAt: now,
            updatedAt: now,
          },
          201
        )
      }
      const stored = /\/api\/conversations\/([^/?]+)\/messages$/.exec(url)
      if (method === 'POST' && stored) {
        const input = body()
        return json(
          [
            {
              id: input.id,
              conversationId: decodeURIComponent(stored[1]),
              role: input.role,
              content: input.content,
              messageType: input.messageType,
              createdBy: ME.userId,
              createdAt: new Date().toISOString(),
            },
          ],
          201
        )
      }
      if (url.endsWith(`/api/documents/${FILE.id}/preview`)) return json({ url: `/api/documents/${FILE.id}/file` })
      if (/\/api\/documents\/.+\/visual-details$/.test(url)) return json({ details: [] })
      if (/\/api\/assignments\/document\/.+\/candidates$/.test(url)) {
        return json({
          candidates: [
            { userId: 'u-2', name: ANNA.name, email: 'a.berger@example.at', profilePictureUrl: null },
            { userId: 'u-3', name: JAKOB.name, email: 'j.huber@example.at', profilePictureUrl: null },
          ],
        })
      }
      return real(input, init)
    }
  }
}

export default function AnnotationsPreview(): JSX.Element {
  // The geometry `file-preview-host` gives the pane (see `/dev/file-preview?variant=review`).
  return (
    <main className="bg-muted/40 flex min-h-dvh items-center justify-center">
      <div className="bg-popover text-popover-foreground h-[85dvh] w-[min(1100px,calc(100%-2rem))] overflow-hidden rounded-2xl border shadow-lg phone:fixed phone:inset-0 phone:h-dvh phone:w-full phone:rounded-none phone:border-0">
        <FilePreviewPane
          file={FILE}
          projectId="proj-demo"
          projectName="Wohnbau Nord — Linz"
          canManage
          canCollaborate
          viewerUserId="u-1"
          onClose={() => {}}
        />
      </div>
    </main>
  )
}
