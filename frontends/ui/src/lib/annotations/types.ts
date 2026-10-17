/**
 * Anmerkungen as data: the vocabulary and the wire schemas every client of the
 * HTTP API validates against (CONTEXT.md „Anmerkung", ADR-0055).
 *
 * An Anmerkung is a mark set at a place on a page of a document, a point or a
 * region, with what is to be done about it (a Hinweis, a Rückfrage or a
 * Mangel), a thread of replies under it, and optionally someone who is to act
 * on it by a date. A person sets one, or Piloti proposes one for a person to
 * take over (migration 0138).
 *
 * No `server-only` and no drizzle: the browser, the typed client (`./client`),
 * the route handlers and, through the JSON Schema fixture, the Python tier read
 * this. `db/schema/document-annotations.ts` imports the tuples from here so the
 * CHECKs and the types cannot drift.
 */

import { z } from 'zod'

/** Hinweis, Rückfrage, Mangel. */
export const ANNOTATION_KINDS = ['hint', 'question', 'defect'] as const
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number]

/** A point on the page, or a region of it. */
export const ANNOTATION_SHAPES = ['point', 'region'] as const
export type AnnotationShape = (typeof ANNOTATION_SHAPES)[number]

/** Who set it. Piloti's marks are proposals until a person takes one over. */
export const ANNOTATION_AUTHORS = ['person', 'piloti'] as const
export type AnnotationAuthor = (typeof ANNOTATION_AUTHORS)[number]

/** Vorschlag, Offen, Erledigt, Verworfen. */
export const ANNOTATION_STATUSES = ['proposed', 'open', 'resolved', 'dismissed'] as const
export type AnnotationStatus = (typeof ANNOTATION_STATUSES)[number]

/**
 * What woke Piloti on a mark (ADR-0106): a reply that addresses it
 * (`thread_mention`), a reply on its own open question (`thread_reply`), or
 * being made the mark's delegate (`assigned`). The wire's `TurnTrigger.kind`.
 */
export const PILOTI_WAKE_TRIGGERS = ['thread_mention', 'thread_reply', 'assigned'] as const
export type PilotiWakeTrigger = (typeof PILOTI_WAKE_TRIGGERS)[number]

/**
 * What a wake came to (`piloti_wakes.status`, migrations 0139 and 0141).
 * `queued` until the job runs; `started` while its turn runs; then the turn's
 * end: `answered`, `stopped` (a person stopped it, or took the mark back), or
 * `failed`. `suppressed` and `refused` never started a turn; `failed` can be
 * either (the job gave up, or the turn errored).
 */
export const PILOTI_WAKE_STATUSES = [
  'queued',
  'started',
  'answered',
  'stopped',
  'suppressed',
  'refused',
  'failed',
] as const
export type PilotiWakeStatus = (typeof PILOTI_WAKE_STATUSES)[number]

/**
 * What the BFF did with an event that could wake Piloti, as the writer's
 * response says it: `none` (no wake rule met), `off` (the organization's
 * switch is off: the browser asks Piloti itself, as before), `queued` (the
 * server will wake it; the browser must not), `suppressed` (a cap held it).
 */
export const WAKE_OUTCOMES = ['none', 'off', 'queued', 'suppressed'] as const
export type WakeOutcome = (typeof WAKE_OUTCOMES)[number]

/** The CHECKs `…_body_length` (trimmed) and `…_basis_length`. */
export const MAX_ANNOTATION_BODY = 2000
export const MAX_ANNOTATION_BASIS = 300

/** Anmerkungen one document may carry. A list read returns them all, so it is bounded here. */
export const MAX_ANNOTATIONS_PER_DOCUMENT = 500
/** Replies one Anmerkung may carry. */
export const MAX_REPLIES_PER_ANNOTATION = 200
/** Proposals one call of Piloti may make: a review of a sheet, not a flood. */
export const MAX_PROPOSALS_PER_CALL = 20

/** A calendar day, `YYYY-MM-DD`, as Postgres `date` stores it. */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'not a calendar day')

/** A share of the page, top-left origin: the `PageRegion` frame. */
const unit = z.number().finite().min(0).max(1)

const text = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(max))

/** The place fields every mark carries: a page, and a point or a region on it. */
const placeFields = {
  page: z.number().int().min(1).max(100_000),
  shape: z.enum(ANNOTATION_SHAPES),
  x: unit,
  y: unit,
  w: unit.nullable().optional(),
  h: unit.nullable().optional(),
}

type PlaceInput = {
  shape: AnnotationShape
  x: number
  y: number
  w?: number | null
  h?: number | null
}

/** A point has no size; a region has one and stays on its page (the CHECK `…_region_on_page`). */
export function placeProblem(place: PlaceInput): string | null {
  if (place.shape === 'point') return place.w != null || place.h != null ? 'a point has no size' : null
  if (!place.w || !place.h) return 'a region needs a size'
  if (place.x + place.w > 1.000001 || place.y + place.h > 1.000001) return 'a region stays on its page'
  return null
}

const checkPlace = (value: PlaceInput, context: z.RefinementCtx) => {
  const problem = placeProblem(value)
  if (problem) context.addIssue({ code: 'custom', message: problem })
}

const content = {
  kind: z.enum(ANNOTATION_KINDS),
  body: text(MAX_ANNOTATION_BODY),
  basis: text(MAX_ANNOTATION_BASIS).nullable().optional(),
  assigneeUserId: z.string().min(1).max(128).nullable().optional(),
  dueOn: calendarDay.nullable().optional(),
}

export const createAnnotationRequestSchema = z
  .object({ ...placeFields, ...content })
  .strict()
  .superRefine(checkPlace)
export type CreateAnnotationRequest = z.input<typeof createAnnotationRequestSchema>

/**
 * A change to one Anmerkung. At least one field; `null` clears an assignee, a
 * date or a basis. `status` moves it: a person takes a proposal over (`open`)
 * or dismisses it, resolves an open one, or opens a closed one again. Moving
 * the mark is not offered: a mark set in the wrong place is deleted and set
 * again, so a position never changes under someone who read it.
 */
export const updateAnnotationRequestSchema = z
  .object({
    kind: content.kind.optional(),
    body: content.body.optional(),
    basis: content.basis,
    status: z.enum(['open', 'resolved', 'dismissed']).optional(),
    assigneeUserId: content.assigneeUserId,
    dueOn: content.dueOn,
    /**
     * The status the caller saw. A change made from a copy (a chat card) names
     * it, so a mark a colleague moved meanwhile is a 409, never overwritten:
     * taking over a proposal must not reopen one somebody just dismissed.
     */
    expectedStatus: z.enum(ANNOTATION_STATUSES).optional(),
    /**
     * Make Piloti the delegate on this open mark (true), or take the work back
     * from it (false). The mark keeps its assignee; the caller becomes
     * `delegatedBy`, and Piloti is woken to work it on their behalf. A
     * person's act: Piloti never delegates to itself.
     */
    delegateToPiloti: z.boolean().optional(),
  })
  .strict()
  .refine(({ expectedStatus: _, ...changes }) => Object.keys(changes).length > 0, 'nothing to change')
export type UpdateAnnotationRequest = z.input<typeof updateAnnotationRequestSchema>

export const createReplyRequestSchema = z
  .object({
    body: text(MAX_ANNOTATION_BODY),
    /**
     * The reply addresses Piloti: the composer's @Piloti chip. A structured
     * flag the person set, never read from the text (ADR-0036).
     */
    addressesPiloti: z.boolean().optional(),
  })
  .strict()
export type CreateReplyRequest = z.input<typeof createReplyRequestSchema>

export const annotationReplyViewSchema = z.object({
  id: z.string(),
  annotationId: z.string(),
  authorKind: z.enum(ANNOTATION_AUTHORS),
  body: z.string(),
  createdBy: z.string(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  /** It addressed Piloti (the @Piloti chip). Absent from a server that predates wakes. */
  addressesPiloti: z.boolean().default(false),
  /**
   * What woke the turn that wrote this Piloti reply, or null for a reply nobody's
   * event woke (a person's, or Piloti asked in the canvas). Derived on read
   * (`./wake-attribution.ts`); absent from a server that predates it.
   */
  wokenBy: z.enum(PILOTI_WAKE_TRIGGERS).nullable().optional(),
})
export type AnnotationReplyView = z.infer<typeof annotationReplyViewSchema>

/**
 * Piloti at work on a mark, as the server knows it (`./piloti-work.ts`), so
 * every reader sees the same line: `queued` until its turn starts, `working`
 * while it runs, `failed` for a while after it ended without an answer (the
 * class of why: `wakeEndReasonKind`), `held` briefly when a cap held it.
 */
export const PILOTI_WORK_STATES = ['queued', 'working', 'failed', 'held'] as const
export type PilotiWorkState = (typeof PILOTI_WORK_STATES)[number]

export const pilotiWorkViewSchema = z.object({
  state: z.enum(PILOTI_WORK_STATES),
  trigger: z.enum(PILOTI_WAKE_TRIGGERS),
  /** The person whose act woke Piloti: it works for them. */
  forUserId: z.string(),
  forName: z.string().nullable(),
  /** Why it failed, as a class a person can act on; null unless `failed`. */
  reasonKind: z.enum(['budget', 'busy', 'access', 'error']).nullable(),
  /** When this state began: queued at, started at, or ended at. */
  since: z.string(),
})
export type PilotiWorkView = z.infer<typeof pilotiWorkViewSchema>

export const annotationViewSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  /** The document's running number, „Anmerkung 4". */
  number: z.number().int(),
  page: z.number().int(),
  shape: z.enum(ANNOTATION_SHAPES),
  x: z.number(),
  y: z.number(),
  w: z.number().nullable(),
  h: z.number().nullable(),
  kind: z.enum(ANNOTATION_KINDS),
  body: z.string(),
  basis: z.string().nullable(),
  authorKind: z.enum(ANNOTATION_AUTHORS),
  status: z.enum(ANNOTATION_STATUSES),
  assigneeUserId: z.string().nullable(),
  /** The assignee's name as the organization's directory has it; null when it does not know them. */
  assigneeName: z.string().nullable(),
  dueOn: z.string().nullable(),
  /** The Fassung number it was set on, when the document has a version row for it. */
  fassungNumber: z.number().int().nullable(),
  /**
   * Whether it was set on the Fassung the document shows now. False once a
   * newer Fassung replaced that one: it is listed, and not drawn over a sheet
   * whose geometry may have moved.
   */
  onCurrentFassung: z.boolean(),
  /** The person who set it, or on whose behalf Piloti proposed it. */
  createdBy: z.string(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  acceptedBy: z.string().nullable(),
  acceptedByName: z.string().nullable(),
  closedBy: z.string().nullable(),
  closedByName: z.string().nullable(),
  closedAt: z.string().nullable(),
  /**
   * Piloti works this mark on this person's behalf (the delegate), or null.
   * Absent from a server that predates delegation, which is none.
   */
  delegatedBy: z.string().nullable().default(null),
  delegatedByName: z.string().nullable().default(null),
  delegatedAt: z.string().nullable().default(null),
  replies: z.array(annotationReplyViewSchema),
  /** Piloti at work on it, as the server knows it; null when it is not. Absent from a server that predates it. */
  pilotiWork: pilotiWorkViewSchema.nullable().optional(),
  /** Whether THIS reader may change it: take it over, resolve it, reword it, assign it, reply. */
  canEdit: z.boolean(),
  /** Whether THIS reader may delete it: whoever set it, while they may still write here. */
  canDelete: z.boolean(),
})
export type AnnotationView = z.infer<typeof annotationViewSchema>

export const annotationListResponseSchema = z.object({
  annotations: z.array(annotationViewSchema),
  /** Whether this reader may set a new Anmerkung on the document. */
  canAnnotate: z.boolean(),
  /**
   * Whether the organization lets events wake Piloti (the `piloti-wakes`
   * switch): a mark can be delegated to Piloti, and an @Piloti reply is
   * answered by the server rather than by this tab. Absent from a server
   * that predates wakes, which is off.
   */
  pilotiWakes: z.boolean().default(false),
})
export type AnnotationListResponse = z.infer<typeof annotationListResponseSchema>

export const annotationResponseSchema = z.object({
  annotation: annotationViewSchema,
  /** What the BFF did with the write as an event that could wake Piloti; absent on writes that cannot. */
  wake: z.enum(WAKE_OUTCOMES).optional(),
})
export type AnnotationResponse = z.infer<typeof annotationResponseSchema>

/** A reply: the mark with its thread, the new reply's id, and whether the server wakes Piloti for it. */
export const replyResponseSchema = z.object({
  annotation: annotationViewSchema,
  /** Absent only from a server that predates wakes. */
  replyId: z.string().optional(),
  /** `none` from a server that predates wakes: the browser asks Piloti itself, as before. */
  wake: z.enum(WAKE_OUTCOMES).default('none'),
})
export type ReplyResponse = z.infer<typeof replyResponseSchema>

/** `POST /api/documents/{id}/thread`: the caller's own thread about the document (ADR-0106). */
export const documentThreadResponseSchema = z.object({ conversationId: z.string().min(1) })

/** The statuses that still ask something of somebody: open, and Piloti's proposals nobody has decided on. */
export const LIVE_ANNOTATION_STATUSES = ['open', 'proposed'] as const satisfies readonly AnnotationStatus[]

/** Whether an Anmerkung still asks something of somebody. */
export const isLive = (annotation: Pick<AnnotationView, 'status'>): boolean =>
  (LIVE_ANNOTATION_STATUSES as readonly AnnotationStatus[]).includes(annotation.status)

/**
 * What a listing row says about a document's Anmerkungen, for the reader it
 * was read for: how many are live ({@link isLive}, on every Fassung), and how
 * many of those are open with the reader as Zuständige.
 */
export interface MarkTally {
  live: number
  forYou: number
}

/** Live ones first, then by page and number: the order a review walks them in. */
export function compareAnnotations(a: AnnotationView, b: AnnotationView): number {
  if (isLive(a) !== isLive(b)) return isLive(a) ? -1 : 1
  if (a.page !== b.page) return a.page - b.page
  return a.number - b.number
}

/** Whether an open Anmerkung's date has passed, on the reader's calendar day `today` (`YYYY-MM-DD`). */
export function isOverdue(annotation: Pick<AnnotationView, 'status' | 'dueOn'>, today: string): boolean {
  return annotation.status === 'open' && annotation.dueOn !== null && annotation.dueOn < today
}

/** A point asked about becomes a box this wide and tall around it (shares of the page). */
const POINT_BOX = 0.08

/**
 * The box a place stands for when Piloti is asked about it: a region as it
 * is, a point as a small box around it, kept on its page. The canvas asks
 * with it, and so does a wake (`lib/annotations/wake-job.ts`).
 */
export function regionAround(place: { page: number; x: number; y: number; w?: number | null; h?: number | null }): {
  page: number
  x: number
  y: number
  w: number
  h: number
} {
  if (place.w && place.h) return { page: place.page, x: place.x, y: place.y, w: place.w, h: place.h }
  const round = (value: number) => Math.round(value * 10_000) / 10_000
  const start = (value: number) => round(Math.min(1 - POINT_BOX, Math.max(0, value - POINT_BOX / 2)))
  return { page: place.page, x: start(place.x), y: start(place.y), w: POINT_BOX, h: POINT_BOX }
}

/** A mark's place as a box, `[x0, y0, x1, y1]`; a point is a box of no size. */
export function annotationBox(annotation: Pick<AnnotationView, 'x' | 'y' | 'w' | 'h'>): [number, number, number, number] {
  return [annotation.x, annotation.y, annotation.x + (annotation.w ?? 0), annotation.y + (annotation.h ?? 0)]
}

// ---------------------------------------------------------------------------
// Piloti's side: POST /api/internal/document-annotations. The agent's tools
// build these bodies; `annotation-schema.ts` exports them to the JSON Schema
// fixture the Python tier validates against.
// ---------------------------------------------------------------------------

/**
 * One mark Piloti sets: a place, a kind, what it says, and what it rests on.
 * Born a proposal (`propose`), or open when the asker asked for exactly this
 * mark (`create`).
 */
export const annotationProposalSchema = z
  .object({
    ...placeFields,
    kind: content.kind,
    body: content.body,
    basis: content.basis,
  })
  .strict()
  .superRefine(checkPlace)
export type AnnotationProposal = z.input<typeof annotationProposalSchema>

/** A pointer's label is a few words; a highlight's one line. */
export const MAX_POINT_LABEL = 80
export const MAX_HIGHLIGHT_LABEL = 120

/**
 * Common to every op: the answer the turn writes (marked when a restricted
 * folder is admitted), and the document, when the turn names one rather than
 * acting on the conversation's subject (`lib/annotations/agent.ts` admits it).
 */
const internalOpBase = {
  answerMessageId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
}

/** A name or an e-mail address as the asker said it; the BFF resolves it against the organization. */
export const MAX_ASSIGNEE_QUERY = 200

export const internalAnnotationRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), ...internalOpBase }).strict(),
  z
    .object({
      op: z.literal('propose'),
      ...internalOpBase,
      proposals: z.array(annotationProposalSchema).min(1).max(MAX_PROPOSALS_PER_CALL),
    })
    .strict(),
  // A mark the asker asked for: born open, taken over by the asker in the same
  // move (`accepted_by`), so the CHECK „Piloti's mark is open only with a
  // person" holds because the person stood behind it by asking.
  z
    .object({
      op: z.literal('create'),
      ...internalOpBase,
      marks: z.array(annotationProposalSchema).min(1).max(MAX_PROPOSALS_PER_CALL),
    })
    .strict(),
  // A change the asker asked for, through the same `updateAnnotation` a
  // person's PATCH runs, then `note` posted as Piloti's reply in the mark's
  // thread. At least one change (`./agent` refuses an empty one).
  z
    .object({
      op: z.literal('update'),
      ...internalOpBase,
      annotationId: z.string().uuid(),
      status: z.enum(['open', 'resolved', 'dismissed']).optional(),
      /** Who is to act on it, by name or e-mail as the asker said it; null clears it. */
      assignee: z.string().trim().min(1).max(MAX_ASSIGNEE_QUERY).nullable().optional(),
      dueOn: content.dueOn,
      kind: content.kind.optional(),
      body: content.body.optional(),
      expectedStatus: z.enum(ANNOTATION_STATUSES).optional(),
      /** What Piloti did and why, in one sentence: its reply in the thread. */
      note: content.body,
    })
    .strict(),
  // Delete a mark, exactly as the asker could: only one they set themselves.
  z
    .object({
      op: z.literal('delete'),
      ...internalOpBase,
      annotationId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      op: z.literal('reply'),
      ...internalOpBase,
      annotationId: z.string().uuid(),
      body: content.body,
    })
    .strict(),
  // The room: who has the document open, and Piloti's own hand in it. A
  // pointer and a highlight are passing gestures, never stored.
  z.object({ op: z.literal('room'), ...internalOpBase }).strict(),
  z
    .object({
      op: z.literal('point'),
      ...internalOpBase,
      page: z.number().int().min(1),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      label: z.string().trim().min(1).max(MAX_POINT_LABEL).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('highlight'),
      ...internalOpBase,
      page: z.number().int().min(1),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().gt(0).max(1),
      h: z.number().gt(0).max(1),
      label: z.string().trim().min(1).max(MAX_HIGHLIGHT_LABEL),
    })
    .strict(),
  // What Piloti is reading, for everyone in the room: the page, or a box on it.
  // Presence, not content: it says where Piloti looks, never what it found.
  z
    .object({
      op: z.literal('look'),
      ...internalOpBase,
      page: z.number().int().min(1),
      x: z.number().min(0).max(1).optional(),
      y: z.number().min(0).max(1).optional(),
      w: z.number().gt(0).max(1).optional(),
      h: z.number().gt(0).max(1).optional(),
    })
    .strict(),
  z.object({ op: z.literal('leave'), ...internalOpBase }).strict(),
])
export type InternalAnnotationRequest = z.input<typeof internalAnnotationRequestSchema>

/** What the agent reads back: the marks in a shape a model can cite, without the reader's controls. */
export const internalAnnotationSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  page: z.number().int(),
  shape: z.enum(ANNOTATION_SHAPES),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  kind: z.enum(ANNOTATION_KINDS),
  status: z.enum(ANNOTATION_STATUSES),
  authorKind: z.enum(ANNOTATION_AUTHORS),
  body: z.string(),
  basis: z.string().nullable(),
  assigneeName: z.string().nullable(),
  dueOn: z.string().nullable(),
  onCurrentFassung: z.boolean(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  replies: z.array(
    z.object({
      authorKind: z.enum(ANNOTATION_AUTHORS),
      body: z.string(),
      createdByName: z.string().nullable(),
    })
  ),
})
export type InternalAnnotation = z.infer<typeof internalAnnotationSchema>

export const internalAnnotationListResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  annotations: z.array(internalAnnotationSchema),
})

/** A mark Piloti set, as the activity card draws it. */
const internalSetMarkSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  page: z.number().int(),
  shape: z.enum(ANNOTATION_SHAPES),
  x: z.number(),
  y: z.number(),
  w: z.number().nullable(),
  h: z.number().nullable(),
  kind: z.enum(ANNOTATION_KINDS),
  body: z.string(),
})

export const internalAnnotationProposeResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  proposed: z.array(internalSetMarkSchema),
})

export const internalAnnotationCreateResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  created: z.array(internalSetMarkSchema),
})

/** The fields a change moved, each as it stood: absent when the field did not change. */
const internalMarkFieldsSchema = z.object({
  status: z.enum(ANNOTATION_STATUSES).optional(),
  assigneeUserId: z.string().nullable().optional(),
  assigneeName: z.string().nullable().optional(),
  dueOn: z.string().nullable().optional(),
  kind: z.enum(ANNOTATION_KINDS).optional(),
  body: z.string().optional(),
})
export type InternalMarkFields = z.infer<typeof internalMarkFieldsSchema>

export const internalAnnotationUpdateResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  annotationId: z.string(),
  number: z.number().int(),
  /** The mark's status after the change: what an undo names as `expectedStatus`. */
  status: z.enum(ANNOTATION_STATUSES),
  before: internalMarkFieldsSchema,
  after: internalMarkFieldsSchema,
  /** Whether the note went into the thread; false when the change changed nothing. */
  noted: z.boolean(),
})

export const internalAnnotationDeleteResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  annotationId: z.string(),
  number: z.number().int(),
  body: z.string(),
})

export const internalAnnotationReplyResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  annotationId: z.string(),
  number: z.number().int(),
  replies: z.number().int(),
})

/** Who has the document open, as Piloti reads it to resolve „hier“. Never another tool's peer id. */
export const internalRoomResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  peers: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['person', 'piloti']),
      page: z.number().int().nullable(),
      viewport: z.object({ page: z.number().int(), y: z.number() }).nullable(),
      selectedMarkNumber: z.number().int().nullable(),
      draft: z
        .object({ page: z.number().int(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .nullable(),
    })
  ),
  marks: z.object({ open: z.number().int(), proposed: z.number().int() }),
})

/** A gesture in the room went out. */
export const internalRoomGestureResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  ok: z.literal(true),
})

/** The wire schemas the Python tier reads, by name. */
export const ANNOTATION_WIRE_SCHEMAS = {
  InternalAnnotationRequest: internalAnnotationRequestSchema,
  InternalAnnotationListResponse: internalAnnotationListResponseSchema,
  InternalAnnotationProposeResponse: internalAnnotationProposeResponseSchema,
  InternalAnnotationCreateResponse: internalAnnotationCreateResponseSchema,
  InternalAnnotationUpdateResponse: internalAnnotationUpdateResponseSchema,
  InternalAnnotationDeleteResponse: internalAnnotationDeleteResponseSchema,
  InternalAnnotationReplyResponse: internalAnnotationReplyResponseSchema,
  InternalRoomResponse: internalRoomResponseSchema,
  InternalRoomGestureResponse: internalRoomGestureResponseSchema,
} as const
