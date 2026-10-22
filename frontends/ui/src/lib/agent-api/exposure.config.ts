/**
 * Who sees each capability (ADR-0122, amendment of 2026-10-21): the one file
 * that decides it.
 *
 * One entry per operation, the catalog's (`catalog/`) and the agent's read
 * tools (`backend-operations.ts`). Three audiences, one column each:
 *
 *  - `external`: an outside agent on an office door (`/api/mcp`, the A2A door)
 *    and the OpenAPI document.
 *  - `piloti`: in-product Piloti on its workspace door. `true` offers it;
 *    `'native:<tool>'` says Piloti does this with that native tool (its name in
 *    `configs/config_oib_openrouter.yml`, a group's as `<group>__<function>`),
 *    so the door hides the operation from Piloti; `false` hides it for the
 *    `reason` the entry gives.
 *  - `platform`: platform staff on the platform door (ADR-0126). Only the
 *    `platform` domain, and that domain on no other door.
 *
 * `withheld` keeps an operation in the catalog and on no door, with its
 * category and reason (the amendment's four categories); offering it again is
 * replacing the entry. Every entry that is not plainly offered to both office
 * audiences says why in `reason`.
 *
 * This decides VISIBILITY: what is listed, found, described and called.
 * `policy.ts` (`canSee`) reads it for every door. It does not decide whether a
 * proposal Piloti already filed may apply: the applier keeps its own reasons
 * (`lib/proposals/operation-applier.ts`), so hiding an operation behind a
 * native tool never fails a card the person is about to accept.
 *
 * `sensitivity` stays on the operation: it is a property of the act (it widens
 * access, touches a secret, turns a control down), and whether a caller may see
 * one is decided per call from the organization's opt-in flags and the token's
 * step-up scope, which no static file can know. The entries of sensitive
 * operations say the ceiling: never Piloti (`exposure.config.spec.ts` holds
 * that), an external agent only behind those guards.
 *
 * Changing an entry changes `tests/fixtures/exposure.json` (the docs' and
 * Python's copy): `UPDATE_FIXTURES=1 bunx vitest run src/lib/agent-api/exposure.config.spec.ts`.
 */

import type { BackendOperationName } from './backend-operations'
import type { OperationName } from './catalog'

/**
 * Why an operation is withheld from agents. `external-service`: a service we
 * only proxy or switch, which a calling agent already has its own tool for.
 * `product-config`: how Piloti itself works for the office (models, keys,
 * budgets, policies, settings). `model-compute`: model work the caller can do
 * itself whose result is no office artifact. `ui-state`: this person's own
 * screen or device state.
 */
export const WITHHELD_CATEGORIES = ['external-service', 'product-config', 'model-compute', 'ui-state'] as const
export type WithheldCategory = (typeof WITHHELD_CATEGORIES)[number]

export interface Withholding {
  readonly category: WithheldCategory
  /** One line a reviewer can disagree with. */
  readonly reason: string
}

/** A native tool of Piloti's, as the model binds it: `native:remember`, `native:canvas__mark`. */
export type NativeTool = `native:${string}`

export interface Exposure {
  /** Offered to an outside agent on an office door, and in the OpenAPI document. */
  readonly external: boolean
  /** Offered to in-product Piloti, or done by Piloti with the named native tool instead. */
  readonly piloti: boolean | NativeTool
  /** Offered on the platform door (the `platform` domain only). */
  readonly platform?: true
  /** On no door at all, with why. */
  readonly withheld?: Withholding
  /** Why the entry is not simply offered to both office audiences. */
  readonly reason?: string
}

/** Offered to an outside agent and to Piloti. */
const OFFERED = { external: true, piloti: true } as const satisfies Exposure

/** GRID's operator console: the platform door only (ADR-0126). */
const PLATFORM = {
  external: false,
  piloti: false,
  platform: true,
  reason: 'the operator console is GRID’s, not an office’s: every write there reaches every tenant',
} as const satisfies Exposure

const SENSITIVE = {
  external: true,
  piloti: false,
  reason:
    'its `sensitivity` widens access, touches a secret or turns a control down: an outside agent sees it only under ' +
    'the organization’s opt-in and the step-up scope, and accepting a card Piloti worded is not the confirmation it needs',
} as const satisfies Exposure

const DECISION = {
  external: true,
  piloti: false,
  reason: 'the person decides a proposal, or undoes a change, on its own card; Piloti never decides it for them',
} as const satisfies Exposure

const ASK = {
  external: true,
  piloti: false,
  reason: 'how another agent consults Piloti; Piloti never asks Piloti (ADR-0124, the recursion lock)',
} as const satisfies Exposure

/**
 * The Outlook import's byte protocol (start, part upload, complete). Piloti has
 * no archive to send, and a part is 32 MiB, far past what a proposal may carry
 * (`MAX_PROPOSED_INPUT_CHARS`), so offering it costs Piloti a tool slot and a
 * proposal that is always refused. Watching and cancelling an import stay offered.
 */
const ARCHIVE_BYTES = {
  external: true,
  piloti: false,
  reason:
    'Piloti holds no Outlook archive: the bytes come from the person’s disk, and a part is larger than any proposal a person can read',
} as const satisfies Exposure

const NATIVE_READ = 'Piloti reads with this native tool itself; the door offers it to outside agents'
const MEMORY =
  'Piloti keeps a note with its own `remember`, which records where the finding came from and keeps a restricted one in its project'
const SEARCH = 'a hit of this search is no citable source; Piloti’s own `knowledge_search` returns quotable passages'
const TASK = 'Piloti proposes a task, or commissions a run, with its own `create_task`, whose card the person confirms'
const SKILL_READ =
  'Piloti is given the office’s skills at turn start and loads one with its own `use_skill`, which the turn records; the door offers them to outside agents'
const CANVAS ='Piloti marks a document, and answers in a mark’s thread, with its own canvas tools, anchored where it looked'

/**
 * Every operation, in catalog order (domain, then name), then the read tools.
 * A name that is no operation, or an operation without an entry, does not compile.
 */
export const EXPOSURE = {
  // projects
  'project-cleanup-confirm': OFFERED,
  'project-cleanup-propose': OFFERED,
  'project-consistency-check': OFFERED,
  'project-create': OFFERED,
  'project-delete': OFFERED,
  'project-experience-extract': OFFERED,
  'project-get': OFFERED,
  'project-intake-complete': OFFERED,
  'project-intake-decide': OFFERED,
  'project-intake-definition-get': OFFERED,
  'project-intake-get': OFFERED,
  'project-intake-start': OFFERED,
  'project-list': OFFERED,
  'project-member-add': SENSITIVE,
  'project-member-list': OFFERED,
  'project-member-remove': SENSITIVE,
  'project-memory-create': { external: true, piloti: 'native:remember', reason: MEMORY },
  'project-memory-delete': OFFERED,
  'project-memory-list': OFFERED,
  'project-memory-update': OFFERED,
  'project-overview-get': OFFERED,
  'project-period-set': OFFERED,
  'project-person-add': OFFERED,
  'project-person-delete': OFFERED,
  'project-person-update': OFFERED,
  'project-profile-get': OFFERED,
  'project-profile-patch': OFFERED,
  'project-profile-replace': OFFERED,
  'project-record-get': OFFERED,
  'project-reindex': OFFERED,
  'project-rename': OFFERED,
  'project-restore': OFFERED,
  'project-same-address-list': OFFERED,
  'project-standards-get': OFFERED,
  'project-status-set': OFFERED,
  'project-summary-generate': OFFERED,
  'project-upload-screening-get': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'a project’s upload screening override; how Piloti treats uploads, set by a person' },
  },
  'project-upload-screening-set': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'a project’s upload screening override; how Piloti treats uploads, set by a person' },
  },

  // documents
  'deletion-list': OFFERED,
  'document-archive': OFFERED,
  'document-bin': OFFERED,
  'document-by-name-resolve': OFFERED,
  'document-delete': OFFERED,
  'document-download': OFFERED,
  'document-file-get': OFFERED,
  'document-get': OFFERED,
  'document-list': OFFERED,
  'document-ingest-cancel': OFFERED,
  'document-model-get': OFFERED,
  'document-move': OFFERED,
  'document-name-match': OFFERED,
  'document-preview-get': OFFERED,
  'document-reingest': OFFERED,
  'document-rename': OFFERED,
  'document-restore': OFFERED,
  'document-role-clear': OFFERED,
  'document-role-declare': OFFERED,
  'document-role-list': OFFERED,
  'document-search': { external: true, piloti: 'native:knowledge_search', reason: SEARCH },
  'document-status': OFFERED,
  'document-summary-get': OFFERED,
  'document-tags-update': OFFERED,
  'document-text-get': OFFERED,
  'document-thumbnail-get': {
    external: false,
    piloti: false,
    withheld: {
      category: 'ui-state',
      reason: 'a link to the file grid’s thumbnail image, which an agent cannot look at; document-look shows a page',
    },
  },
  'document-unarchive': OFFERED,
  'document-upload': OFFERED,
  'document-visual-details-get': OFFERED,
  'hold-create': OFFERED,
  'hold-list': OFFERED,
  'hold-release': SENSITIVE,
  'mail-import-cancel': OFFERED,
  'mail-import-complete': ARCHIVE_BYTES,
  'mail-import-get': OFFERED,
  'mail-import-list': OFFERED,
  'mail-import-part-upload': ARCHIVE_BYTES,
  'mail-import-start': ARCHIVE_BYTES,
  'project-upload-list': OFFERED,
  'quarantine-list': OFFERED,
  'session-document-upload': OFFERED,
  'upload-batch-get': OFFERED,
  'upload-batch-open': OFFERED,
  'upload-batch-seal': OFFERED,

  // folders
  'office-shelf-folder-create': OFFERED,
  'office-shelf-folder-delete': OFFERED,
  'office-shelf-folder-ensure': OFFERED,
  'office-shelf-folder-list': OFFERED,
  'office-shelf-folder-update': OFFERED,
  'office-shelf-root-sort-get': OFFERED,
  'office-shelf-root-sort-start': OFFERED,
  'project-folder-access-get': OFFERED,
  'project-folder-access-set': SENSITIVE,
  'project-folder-bin-list': OFFERED,
  'project-folder-bin-purge': OFFERED,
  'project-folder-create': OFFERED,
  'project-folder-delete': OFFERED,
  'project-folder-ensure': OFFERED,
  'project-folder-list': OFFERED,
  'project-folder-restore': OFFERED,
  'project-folder-update': OFFERED,
  'project-root-sort-get': OFFERED,
  'project-root-sort-start': OFFERED,
  'root-sort-run-apply': OFFERED,
  'root-sort-run-cancel': OFFERED,
  'root-sort-run-get': OFFERED,
  'root-sort-run-undo': OFFERED,

  // review
  'annotation-create': { external: true, piloti: 'native:canvas__mark', reason: CANVAS },
  'annotation-delete': { external: true, piloti: 'native:canvas__delete', reason: CANVAS },
  'annotation-get': OFFERED,
  'annotation-list': OFFERED,
  'annotation-reply-create': { external: true, piloti: 'native:canvas__reply', reason: CANVAS },
  'annotation-reply-delete': OFFERED,
  'annotation-reply-update': OFFERED,
  'annotation-update': { external: true, piloti: 'native:canvas__update', reason: CANVAS },
  'document-annotations-export': OFFERED,
  'document-quarantine-allow': SENSITIVE,
  'document-quarantine-allow-request': OFFERED,
  'document-quarantine-get': OFFERED,
  'document-revision-candidates': OFFERED,
  'document-review-list': OFFERED,
  'document-revision-compare': OFFERED,
  'document-revision-link-set': OFFERED,
  'document-thread-ensure': OFFERED,
  'document-version-approve': OFFERED,
  'document-version-content-get': OFFERED,
  'document-version-content-replace': OFFERED,
  'document-version-diff': OFFERED,
  'document-version-fork': OFFERED,
  'document-version-get': OFFERED,
  'document-version-list': OFFERED,
  'document-version-publish': OFFERED,
  'document-version-reject': OFFERED,
  'document-version-request-changes': OFFERED,
  'document-version-reviewer-list': OFFERED,
  'document-version-submit': OFFERED,
  'project-annotation-list': OFFERED,
  'project-annotations-export': OFFERED,

  // conversations
  'answer-feedback-list': OFFERED,
  'answer-feedback-retract': OFFERED,
  'answer-feedback-submit': OFFERED,
  'citation-format': {
    external: false,
    piloti: false,
    withheld: { category: 'model-compute', reason: 'formats the sources it is sent as APA, BibTeX or RIS; any agent can do that itself' },
  },
  'conversation-create': OFFERED,
  'conversation-delete': OFFERED,
  'conversation-draft-file': OFFERED,
  'conversation-draft-get': OFFERED,
  'conversation-get': OFFERED,
  'conversation-list': OFFERED,
  'conversation-message-add': OFFERED,
  'conversation-message-changes': OFFERED,
  'conversation-message-export': OFFERED,
  'conversation-message-list': OFFERED,
  'conversation-message-update': OFFERED,
  'conversation-message-usage': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'what one Piloti answer cost; billing, not office work' },
  },
  'conversation-read-mark': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'what the person has seen; an agent marking it read hides news from them' },
  },
  'conversation-title-generate': {
    external: false,
    piloti: false,
    withheld: { category: 'model-compute', reason: 'a model names the conversation; the caller can name it and save it with conversation-update' },
  },
  'conversation-update': OFFERED,
  'feedback-office-report-list': OFFERED,
  'feedback-report-list': OFFERED,
  'feedback-report-submit': OFFERED,
  'feedback-thread-get': OFFERED,
  'feedback-thread-reply': OFFERED,
  'passage-similar-search': OFFERED,
  'piloti-ask-cancel': ASK,
  'piloti-ask-create': ASK,
  'piloti-ask-get': ASK,

  // collaboration
  'assignment-add': OFFERED,
  'assignment-candidate-list': OFFERED,
  'assignment-list': OFFERED,
  'assignment-remove': OFFERED,
  'conversation-awaiting-get': OFFERED,
  'conversation-mention-candidate-list': OFFERED,
  'inbox-item-archive': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'puts a request away from the person, who has not seen it; the same reason mark-read is withheld' },
  },
  'inbox-item-mark-read': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'what the person has seen; an agent marking it read hides news from them' },
  },
  'inbox-item-mark-unread': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'what the person has seen; theirs to mark' },
  },
  'inbox-item-restore': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'the reverse of archive, which an agent cannot do; what the person put away is theirs to bring back' },
  },
  'inbox-list': OFFERED,
  'inbox-summary-get': OFFERED,
  'inbox-unread-anchor-list': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'the unread markers the document viewer draws; screen state' },
  },
  'mention-request-release': OFFERED,
  'piloti-change-undo': DECISION,
  'proposal-apply': DECISION,
  'proposal-dismiss': DECISION,
  'proposal-get': OFFERED,
  'proposal-list': OFFERED,
  'push-device-list': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'the person’s own browsers registered for push; device state' },
  },
  'push-device-remove': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'the person’s own browsers registered for push; device state' },
  },
  'push-preference-get': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'which notifications reach the person’s devices; theirs to set' },
  },
  'push-preference-update': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'which notifications reach the person’s devices; theirs to set' },
  },
  'session-document-delete': OFFERED,
  'session-document-list': OFFERED,
  'sharing-candidate-list': OFFERED,
  'sharing-get': OFFERED,
  'sharing-grant-add': SENSITIVE,
  'sharing-grant-revoke': SENSITIVE,
  'sharing-grant-update': SENSITIVE,
  'sharing-visibility-set': SENSITIVE,
  'user-preference-get': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'the person’s interface preferences (language, active project); screen state' },
  },
  'user-preference-update': {
    external: false,
    piloti: false,
    withheld: { category: 'ui-state', reason: 'the person’s interface preferences (language, active project); screen state' },
  },

  // tasks
  'project-task-run-list': OFFERED,
  'task-create': { external: true, piloti: 'native:create_task', reason: TASK },
  'task-delete': OFFERED,
  'task-get': OFFERED,
  'task-list': OFFERED,
  'task-run-cancel': OFFERED,
  'task-run-commission': { external: true, piloti: 'native:create_task', reason: TASK },
  'task-run-document-add': OFFERED,
  'task-run-get': OFFERED,
  'task-run-review': OFFERED,
  'task-run-start': OFFERED,
  'task-run-write-now': OFFERED,
  'task-update': OFFERED,

  // skills
  'skill-category-create': OFFERED,
  'skill-category-delete': OFFERED,
  'skill-category-list': OFFERED,
  'skill-category-update': OFFERED,
  'skill-create': OFFERED,
  'skill-curated-set-enabled': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'switches a platform-curated skill of Piloti’s on or off; product configuration' },
  },
  'skill-delete': OFFERED,
  'skill-get': { external: true, piloti: false, reason: SKILL_READ },
  'skill-invocable-list': OFFERED,
  'skill-list': OFFERED,
  'skill-search': { external: true, piloti: false, reason: SKILL_READ },
  'skill-review': {
    external: false,
    piloti: false,
    withheld: { category: 'model-compute', reason: 'a model critiques a skill draft and stores nothing; the calling agent can review its own draft' },
  },
  'skill-update': OFFERED,

  // knowledge
  'address-search': {
    external: false,
    piloti: false,
    withheld: { category: 'external-service', reason: 'proxies a public geocoder; a calling agent has its own map and web tools' },
  },
  'knowledge-base-get': OFFERED,
  'norm-list': OFFERED,
  'knowledge-document-get': OFFERED,
  'widget-token-get': {
    external: false,
    piloti: false,
    withheld: { category: 'external-service', reason: 'mints a token for the WorkOS widgets the browser renders; the identity provider’s UI, not office work' },
  },

  // bim
  'bim-check-confirm': OFFERED,
  'bim-check-list': OFFERED,
  'bim-check-withdraw': OFFERED,
  'bim-checks-export': OFFERED,
  'bim-model-get': OFFERED,
  'bim-model-list': OFFERED,
  'bim-model-query': {
    external: true,
    piloti: 'native:ifc_query',
    reason: 'Piloti counts and reads the model with its own `ifc_query`, which says what the export cannot answer',
  },
  'bim-model-source-get': OFFERED,
  'diagram-file': OFFERED,

  // organization
  'organization-audit-portal-link-create': {
    external: false,
    piloti: false,
    withheld: { category: 'external-service', reason: 'a link into the identity provider’s audit-log portal, not the office’s workspace' },
  },
  'organization-budget-get': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'spend limits on Piloti itself; a refused call says when one stops work' },
  },
  'organization-budget-remove': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'spend limits on Piloti itself; product configuration' },
  },
  'organization-budget-set': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'spend limits on Piloti itself; product configuration' },
  },
  'organization-deleted-folder-content-get': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'what Piloti keeps of a purged folder; a retention policy a person sets' },
  },
  'organization-deleted-folder-content-set': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'what Piloti keeps of a purged folder; a retention policy a person sets' },
  },
  'organization-download-log-list': OFFERED,
  'organization-download-log-retention-set': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'how long Piloti keeps the download log; a retention policy a person sets' },
  },
  'office-conventions-decide': OFFERED,
  'office-conventions-list': OFFERED,
  'organization-failed-document-reingest': OFFERED,
  'organization-instructions-get': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'the standing instructions shape every Piloti answer; they configure the product, and Piloti already reads them' },
  },
  'organization-instructions-set': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'the standing instructions shape every Piloti answer; configuring the product is a person’s act' },
  },
  'organization-llm-credential-create': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'the LLM provider keys Piloti runs on; product configuration and a credential' },
  },
  'organization-llm-credential-list': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'the LLM provider keys Piloti runs on; product configuration and a credential' },
  },
  'organization-llm-credential-revoke': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'the LLM provider keys Piloti runs on; product configuration and a credential' },
  },
  'organization-llm-credential-verify': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'the LLM provider keys Piloti runs on; product configuration and a credential' },
  },
  'organization-llm-provider-mode-set': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'whether Piloti runs on the platform’s or the office’s provider key; product configuration' },
  },
  'organization-member-list': OFFERED,
  'organization-memory-create': { external: true, piloti: 'native:remember', reason: MEMORY },
  'organization-memory-delete': OFFERED,
  'organization-memory-list': OFFERED,
  'organization-memory-update': OFFERED,
  'organization-model-config-get': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'which models Piloti runs on; product configuration' },
  },
  'organization-model-config-set': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'which models Piloti runs on; product configuration' },
  },
  'organization-model-config-version-activate': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'which models Piloti runs on; product configuration' },
  },
  'organization-model-config-version-list': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'the history of which models Piloti ran on; product configuration' },
  },
  'organization-model-search': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'the model catalog the model configuration picks from; product configuration' },
  },
  'organization-role-create': SENSITIVE,
  'organization-role-delete': SENSITIVE,
  'organization-role-list': OFFERED,
  'organization-role-update': SENSITIVE,
  'organization-settings-get': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'how Piloti works for the office (language, effort and other defaults); a person sets it in Settings' },
  },
  'organization-settings-update': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'how Piloti works for the office (language, effort and other defaults); a person sets it in Settings' },
  },
  'organization-storage-get': OFFERED,
  'organization-upload-screening-get': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'the office’s upload screening policy; how Piloti treats uploads, set by a person' },
  },
  'organization-upload-screening-set': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'the office’s upload screening policy; how Piloti treats uploads, set by a person' },
  },
  'organization-usage-get': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'what the office spent on Piloti itself, by model and day; billing, not office work' },
  },
  'organization-usage-notice-get': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'the budget window close to stopping the person; a refused call says so itself' },
  },
  'organization-web-search-set': {
    external: false,
    piloti: false,
    withheld: { category: 'external-service', reason: 'switches the web search provider Piloti answers with; a calling agent has its own web search' },
  },
  'organization-zdr-set': {
    external: false,
    piloti: false,
    withheld: { category: 'product-config', reason: 'whether model providers may keep data; a product privacy setting a person decides' },
  },

  // platform
  'platform-answer-feedback-digest-get': PLATFORM,
  'platform-answer-feedback-export': PLATFORM,
  'platform-answer-feedback-get': PLATFORM,
  'platform-answer-feedback-options-get': PLATFORM,
  'platform-audit-portal-link': PLATFORM,
  'platform-card-list': PLATFORM,
  'platform-citation-health-export': PLATFORM,
  'platform-citation-health-get': PLATFORM,
  'platform-feedback-claim': PLATFORM,
  'platform-feedback-get': PLATFORM,
  'platform-feedback-list': PLATFORM,
  'platform-feedback-triage': PLATFORM,
  'platform-kill-runs': PLATFORM,
  'platform-knowledge-doc-class-update': PLATFORM,
  'platform-knowledge-document-delete': PLATFORM,
  'platform-knowledge-document-upload': PLATFORM,
  'platform-knowledge-reingest': PLATFORM,
  'platform-knowledge-sync': PLATFORM,
  'platform-knowledge-title-update': PLATFORM,
  'platform-lesson-get': PLATFORM,
  'platform-lesson-list': PLATFORM,
  'platform-lesson-sweep-run': PLATFORM,
  'platform-lesson-update': PLATFORM,
  'platform-model-defaults-get': PLATFORM,
  'platform-model-defaults-update': PLATFORM,
  'platform-model-search': PLATFORM,
  'platform-norm-registry-get': PLATFORM,
  'platform-norm-registry-update': PLATFORM,
  'platform-norm-verify': PLATFORM,
  'platform-org-budget-get': PLATFORM,
  'platform-org-budget-update': PLATFORM,
  'platform-org-storage-get': PLATFORM,
  'platform-org-storage-update': PLATFORM,
  'platform-org-upload-limit-update': PLATFORM,
  'platform-org-usage-get': PLATFORM,
  'platform-overview-get': PLATFORM,
  'platform-pricing-get': PLATFORM,
  'platform-pricing-update': PLATFORM,
  'platform-profiler-conversation-get': PLATFORM,
  'platform-profiler-conversation-list': PLATFORM,
  'platform-quality-scope-options': PLATFORM,
  'platform-reasoning-efforts-get': PLATFORM,
  'platform-reasoning-efforts-update': PLATFORM,
  'platform-retrieval-settings-get': PLATFORM,
  'platform-retrieval-settings-update': PLATFORM,
  'platform-skill-category-create': PLATFORM,
  'platform-skill-category-delete': PLATFORM,
  'platform-skill-category-list': PLATFORM,
  'platform-skill-category-update': PLATFORM,
  'platform-skill-create': PLATFORM,
  'platform-skill-delete': PLATFORM,
  'platform-skill-list': PLATFORM,
  'platform-skill-update': PLATFORM,
  'platform-storage-overview': PLATFORM,
  'platform-vectors-reconcile': PLATFORM,

  // the agent’s read tools (`backend-operations.ts`)
  'knowledge-search': { external: true, piloti: 'native:knowledge_search', reason: NATIVE_READ },
  'passage-read': { external: true, piloti: 'native:read_passage', reason: NATIVE_READ },
  'files-list': { external: true, piloti: 'native:list_files', reason: NATIVE_READ },
  'document-look': { external: true, piloti: 'native:look', reason: NATIVE_READ },
  'ifc-query': { external: true, piloti: 'native:ifc_query', reason: NATIVE_READ },
  'ifc-measure': { external: true, piloti: 'native:ifc_measure', reason: NATIVE_READ },
  'law-lookup': { external: true, piloti: 'native:ris_lookup_tool', reason: NATIVE_READ },
} as const satisfies Record<OperationName | BackendOperationName, Exposure>

export type ExposedName = keyof typeof EXPOSURE
