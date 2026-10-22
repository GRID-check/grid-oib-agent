/**
 * Proposed changes: a change to the workspace Piloti proposes and a person
 * applies, kept as a server object (ADR-0105). The first kind is the file
 * operation (move, rename, create a folder, assign); the card that used to
 * carry it and execute it from the browser (`file_operation_proposal`) now
 * shows this object and asks the server to apply it in the deciding person's
 * session.
 *
 * This file is the CONTRACT the slices build against: the BFF service and
 * routes, the typed client, the agent's internal route, and the card. Change it
 * deliberately, in one commit with every caller.
 */

import { z } from 'zod'
import { ProjectProfilePatchOperationSchema } from '@/lib/project-profile/types'
import { PROJECT_MEMORY_CONFIDENCES, PROJECT_MEMORY_KINDS } from '@/lib/projects/memory-vocabulary'

/**
 * `file_operation`: move, rename, create a folder, assign (0140).
 * `memory`: a note for the project's or the office's memory (0143).
 * `project_profile`: a change to the project's facts, goals, unknowns or
 * assumptions, as a JSON patch on the profile (0143).
 * `operation`: any WRITE operation of the agent catalog (`lib/agent-api`),
 * proposed by Piloti through the MCP surface and run, when a person accepts,
 * as that person (0175, ADR-0122).
 */
export const PROPOSED_CHANGE_KINDS = ['file_operation', 'memory', 'project_profile', 'operation'] as const
export type ProposedChangeKind = (typeof PROPOSED_CHANGE_KINDS)[number]

/**
 * `applied`: every item went through. `partially_applied`: at least one did and
 * at least one did not; `results` says which. `failed`: none did.
 */
export const PROPOSED_CHANGE_STATUSES = ['proposed', 'applied', 'partially_applied', 'failed', 'dismissed'] as const
export type ProposedChangeStatus = (typeof PROPOSED_CHANGE_STATUSES)[number]

/**
 * The shelf a proposal is on (0146, 0176). `project`: a project's. `office_shelf`
 * (the Büroablage, `project_folders.scope`'s vocabulary): no project, and it can
 * only move Büroablage documents (`proposed_changes_office_shelf_move`).
 * `organization`: no project either, and only an `operation` (a write that is
 * the organization's, not a project's: its memory, its skills;
 * `proposed_changes_organization_operation`).
 */
export const PROPOSAL_SCOPES = ['project', 'office_shelf', 'organization'] as const
export type ProposalScope = (typeof PROPOSAL_SCOPES)[number]

export const FILE_OPERATIONS = ['move', 'rename', 'create_folder', 'assign'] as const
export type FileOperation = (typeof FILE_OPERATIONS)[number]

/**
 * What a proposal changes, as the inbox row words it
 * (`collaboration.inbox.types.pilotiProposalWaiting.variants.<variant>`): a
 * file operation by its verb, every other kind by its kind. Stored on the
 * `piloti.proposal_waiting` item as its `variant` (`./attention.ts`).
 */
export const PROPOSAL_NOTICE_VARIANTS = [...FILE_OPERATIONS, 'memory', 'project_profile', 'operation'] as const
export type ProposalNoticeVariant = (typeof PROPOSAL_NOTICE_VARIANTS)[number]

/** Most items one proposal carries; mirrors `MAX_FILE_OPERATIONS` in `src/aiq_agent/cards/models.py`. */
export const MAX_FILE_OPERATION_ITEMS = 8

const text = (max: number) => z.string().trim().min(1).max(max)

/**
 * One item, in the vocabulary of the card it replaces (`FileOperationItem` in
 * `cards/models.py`): documents and folders by NAME and PATH, never by id. The
 * agent's inventory has no ids; the deciding person's session resolves the
 * names when the change is applied.
 */
export const fileOperationItemSchema = z
  .object({
    document: text(512).nullish(),
    // A proposal stored (or a card an older pod emitted) before the English
    // names says `project` / `office`; read-only, nothing writes these.
    source: z.preprocess(
      (value) => (value === 'project' ? 'project' : value === 'office' ? 'office' : value),
      z.enum(['project', 'office']).nullish()
    ),
    current: z.string().max(512).nullish(),
    target_folder: z.string().max(1024).nullish(),
    new_display_name: text(512).nullish(),
    folder_name: text(256).nullish(),
    parent_folder: z.string().max(1024).nullish(),
    member: text(256).nullish(),
    /** Why this item, in one line for the person deciding: a filing suggestion's reason per file. */
    reason: z.string().trim().max(300).nullish(),
  })
  .strict()
export type FileOperationItem = z.infer<typeof fileOperationItemSchema>

/** What a filing suggestion was judged from: the file name and the folders' descriptions, or what ingestion read. */
export const FILING_BASES = ['name', 'content'] as const
export type FilingBasis = (typeof FILING_BASES)[number]

/**
 * The folder a move files into, when it does not exist yet. Applying the
 * proposal creates it (with its description) before the first move, so
 * „create this folder and move these files into it" is one confirm. Only on a
 * `move`, and every item's `target_folder` is this path (refused otherwise).
 */
export const newFolderSchema = z
  .object({
    path: text(1024),
    description: z.string().trim().max(500).nullish(),
  })
  .strict()
export type NewFolder = z.infer<typeof newFolderSchema>

export const fileOperationPayloadSchema = z
  .object({
    operation: z.enum(FILE_OPERATIONS),
    operations: z.array(fileOperationItemSchema).min(1).max(MAX_FILE_OPERATION_ITEMS),
    note: z.string().max(500).nullish(),
    new_folder: newFolderSchema.nullish(),
    /** Set on a filing suggestion (`lib/filing`), absent on a chat's proposal. */
    basis: z.enum(FILING_BASES).nullish(),
  })
  .strict()
export type FileOperationPayload = z.infer<typeof fileOperationPayloadSchema>

/** Where a memory note lives: the project's memory, or the whole office's. */
export const MEMORY_SCOPES = ['project', 'organization'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/**
 * A note Piloti proposes to remember (`project_memory_remember`, when it may
 * not write it itself). `supersedes` quotes the earlier note it corrects,
 * verbatim, so accepting the correction retires that note
 * (`createProjectMemoryItem`'s `supersedesContent`).
 */
export const memoryPayloadSchema = z
  .object({
    scope: z.enum(MEMORY_SCOPES),
    kind: z.enum(PROJECT_MEMORY_KINDS),
    content: text(500),
    confidence: z.enum(PROJECT_MEMORY_CONFIDENCES),
    supersedes: z.string().trim().max(500).nullish(),
  })
  .strict()
export type MemoryPayload = z.infer<typeof memoryPayloadSchema>

/** Most operations one profile proposal carries. The card draws each one, before and after. */
export const MAX_PROFILE_PATCH_OPERATIONS = 20

/**
 * A change to the project's facts (`project_profile_patch`): the patch is what
 * is applied and what the record says was proposed; the title and rationale
 * are what the reader is told. No preview: the reader's view is derived from
 * the patch against the profile as it is when they look.
 */
export const projectProfilePayloadSchema = z
  .object({
    title: text(200),
    rationale: z.string().trim().max(600).nullish(),
    patch: z.array(ProjectProfilePatchOperationSchema).min(1).max(MAX_PROFILE_PATCH_OPERATIONS),
  })
  .strict()
export type ProjectProfilePayload = z.infer<typeof projectProfilePayloadSchema>

/** Most characters of the one-line summary an operation proposal carries. */
export const MAX_OPERATION_SUMMARY_LENGTH = 300

/**
 * What an operation proposal runs: the call's own input, in the shape
 * `callOperation` takes (`lib/agent-api/dispatch.ts`). The body is the
 * operation's own, validated against the catalog's schema when the proposal is
 * applied, not here: the catalog may change between the proposal and the click.
 */
export const operationInputSchema = z
  .object({
    params: z.record(z.string()).optional(),
    query: z.record(z.unknown()).optional(),
    body: z.unknown().optional(),
    /** The version the agent read, sent as If-Match when the proposal is applied: a newer one refuses it. */
    ifMatch: z.string().min(1).max(256).optional(),
  })
  .strict()
export type OperationProposalInput = z.infer<typeof operationInputSchema>

/**
 * Any write operation of the agent catalog (ADR-0122), proposed instead of
 * applied. Accepting runs it as the DECIDING person through `callOperation`, so
 * the route's own authorization decides; `summary` is the line the person reads.
 * Created only by `proposeOperation` (`lib/agent-api/operation-proposals.ts`),
 * which checks the operation exists and writes: there is no agent-facing
 * create for this kind in `internalProposalRequestSchema`. In a turn with no
 * project it is the organization's (scope `organization`, 0176).
 */
export const operationPayloadSchema = z
  .object({
    operation: text(80),
    input: operationInputSchema,
    summary: text(MAX_OPERATION_SUMMARY_LENGTH),
  })
  .strict()
export type OperationPayload = z.infer<typeof operationPayloadSchema>

/** What a proposed operation's input may name: the targets `lib/agent-api/operation-targets.ts` reads from it. */
export const OPERATION_TARGET_TYPES = [
  'project',
  'document',
  'folder',
  'conversation',
  'bim_model',
  'upload_batch',
  'proposal',
  'inbound_mail',
  'mail_thread',
] as const
export type OperationTargetType = (typeof OPERATION_TARGET_TYPES)[number]

/**
 * One target of a proposed operation as the card shows it to ITS reader: the
 * name when that reader may read it (a project, a document), else null and the
 * card shows the id. Resolved per reader when the proposal is read, never
 * stored, so a card in a conversation never names to one reader what only the
 * proposer could see.
 */
export const operationTargetViewSchema = z.object({
  type: z.enum(OPERATION_TARGET_TYPES),
  id: z.string(),
  name: z.string().nullable(),
})
export type OperationTargetView = z.infer<typeof operationTargetViewSchema>

/** What applying one item did, in words a person reads in the card. */
export const proposedChangeResultSchema = z.object({
  label: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
  /** What the apply created, when it created something addressable (a memory note's id). */
  itemId: z.string().optional(),
  /**
   * Memory notes only: the memory the note went into. It is the scope the
   * decider's click chose, which is not always the one Piloti asked for in the
   * payload („Nur im Projekt merken“). Absent on a row written before it was
   * recorded, and on every other kind.
   */
  scope: z.enum(MEMORY_SCOPES).optional(),
})
export type ProposedChangeResult = z.infer<typeof proposedChangeResultSchema>

/** The fields every proposed change has, whatever its kind. */
const proposedChangeBaseSchema = z.object({
  id: z.string().uuid(),
  /**
   * The project. Null only for a Büroablage file operation (0146) and an
   * organization-scoped operation (0176); a memory note and a profile change
   * are always made in a project.
   */
  projectId: z.string().nullable(),
  status: z.enum(PROPOSED_CHANGE_STATUSES),
  /** Always Piloti today; the column exists so a person's proposal needs no migration. */
  proposedByKind: z.enum(['piloti', 'person']),
  /** The person Piloti acted for: whose turn proposed it. */
  onBehalfOf: z.string(),
  onBehalfOfName: z.string().nullable(),
  originConversationId: z.string().nullable(),
  originMessageId: z.string().nullable(),
  createdAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: z.string().nullable(),
  results: z.array(proposedChangeResultSchema).nullable(),
  /**
   * Whether the reader may apply or dismiss it now: status `proposed`, and the
   * right the KIND needs (`project:documents:write` for a file operation,
   * `project:memory:write` for a memory note or a profile change; `project:edit`
   * covers all three).
   */
  canDecide: z.boolean(),
})

/** A proposed change as a person's client reads it, its payload typed by its kind. */
export const proposedChangeViewSchema = z.discriminatedUnion('kind', [
  proposedChangeBaseSchema.extend({ kind: z.literal('file_operation'), payload: fileOperationPayloadSchema }),
  proposedChangeBaseSchema.extend({ kind: z.literal('memory'), payload: memoryPayloadSchema }),
  proposedChangeBaseSchema.extend({ kind: z.literal('project_profile'), payload: projectProfilePayloadSchema }),
  proposedChangeBaseSchema.extend({
    kind: z.literal('operation'),
    payload: operationPayloadSchema,
    /** What the call names, for this reader (`operationTargetViewSchema`); absent from a client that predates it. */
    targets: z.array(operationTargetViewSchema).optional(),
  }),
])
export type ProposedChangeView = z.infer<typeof proposedChangeViewSchema>

/**
 * Person routes:
 *   GET  /api/proposals/[id]          -> { proposal }
 *   POST /api/proposals/[id]/apply    -> { proposal }  (409 unless `proposed`)
 *   POST /api/proposals/[id]/dismiss  -> { proposal }  (409 unless `proposed`)
 * Applying runs every item through the same services the Files pane uses, in
 * the DECIDING person's session, in order, and records `results`.
 */
export const proposalResponseSchema = z.object({ proposal: proposedChangeViewSchema })
export type ProposalResponse = z.infer<typeof proposalResponseSchema>

/**
 * Piloti's side: POST /api/internal/proposals, with the turn's signed envelope
 * echoed. The project is the turn's, never named in the request. Returns the
 * id the card carries.
 */
const internalCreateBase = {
  op: z.literal('create'),
  answerMessageId: z.string().uuid().optional(),
  /**
   * Which card of that answer this is. With `answerMessageId` it makes the
   * create idempotent: the same card twice returns the first proposal (0143).
   */
  originCardIndex: z.number().int().min(0).optional(),
}

export const internalProposalRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...internalCreateBase, kind: z.literal('file_operation'), payload: fileOperationPayloadSchema }).strict(),
  z.object({ ...internalCreateBase, kind: z.literal('memory'), payload: memoryPayloadSchema }).strict(),
  z.object({ ...internalCreateBase, kind: z.literal('project_profile'), payload: projectProfilePayloadSchema }).strict(),
])
export type InternalProposalRequest = z.input<typeof internalProposalRequestSchema>

export const internalProposalResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(PROPOSED_CHANGE_STATUSES),
})
export type InternalProposalResponse = z.infer<typeof internalProposalResponseSchema>

/**
 * `POST /api/proposals/[id]/apply` takes an optional body. For a memory note
 * the deciding person may file it in the project's memory instead of the
 * office's (never the other way: a project note does not become the office's
 * by a click on a proposal that did not ask for it). Ignored for other kinds.
 */
/**
 * `GET /api/proposals?projectId=<id>` (a project's shelf) or `?shelf=office_shelf`
 * (the Büroablage), optionally with `kind`: the OPEN proposals of that shelf
 * this reader may read, newest first, at most {@link MAX_LISTED_PROPOSALS}.
 * Each carries the documents its items name, resolved to ids as this reader
 * sees them (a file operation's; empty for the other kinds), so a file row and
 * an upload row find their suggestion by document id. A file operation naming
 * a document the reader cannot see is not listed.
 */
export const MAX_LISTED_PROPOSALS = 50

/** The shelves a list names without a project (a project's shelf is the `projectId`). */
export const PROPOSAL_LIST_SHELVES = ['office_shelf', 'organization'] as const

export const listedProposalSchema = z.object({
  proposal: proposedChangeViewSchema,
  documents: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type ListedProposal = z.infer<typeof listedProposalSchema>

export const proposalListResponseSchema = z.object({
  proposals: z.array(listedProposalSchema),
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: z.string().nullable().default(null),
})
export type ProposalListResponse = z.infer<typeof proposalListResponseSchema>

/** The list's own parameters (the catalog reads this object; the route adds the shelf rule below). */
export const proposalListQueryShape = z.object({
  projectId: z.string().uuid().optional().describe('The project whose open proposals to list, from project-list.'),
  // `archiv` is the value an open tab or an agent pod not yet rolled still sends. Remove after one release.
  shelf: z
    .preprocess((value) => (value === 'archiv' ? 'office_shelf' : value), z.enum(PROPOSAL_LIST_SHELVES).optional())
    .describe('`office_shelf` or `organization` instead of a project.'),
  kind: z.enum(PROPOSED_CHANGE_KINDS).optional().describe('Only proposals of this kind.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LISTED_PROPOSALS)
    .default(MAX_LISTED_PROPOSALS)
    .describe(`Page size (default and most ${MAX_LISTED_PROPOSALS}).`),
  cursor: z.string().uuid().optional().describe('The previous `nextCursor`.'),
})

export const proposalListQuerySchema = proposalListQueryShape.refine(
  (query) => Boolean(query.shelf) !== Boolean(query.projectId),
  { message: 'Name a project, or a shelf without one: shelf=office_shelf (the Büroablage) or shelf=organization' }
)
/** What a caller sends (`limit` may be left out). */
export type ProposalListQuery = z.input<typeof proposalListQuerySchema>
/** What the route hands the service, the limit filled in. */
export type ParsedProposalListQuery = z.infer<typeof proposalListQuerySchema>

export const applyProposalRequestSchema = z
  .object({ memoryScope: z.literal('project').optional() })
  .strict()
export type ApplyProposalRequest = z.infer<typeof applyProposalRequestSchema>
