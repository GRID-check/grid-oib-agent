/**
 * The audit registry: every action the app may emit, WITH the WorkOS Audit Log
 * schema that action's events are validated against.
 *
 * ONE list, on purpose. WorkOS rejects an event whose action has no schema in
 * the environment ("event 'resource.shared', version '1' has not been
 * configured in this environment", issues #255/#256), and this list used to
 * exist twice: `AUDIT_ACTIONS` in `service.ts` and a hand-maintained `SCHEMAS`
 * array in `scripts/provision-workos-audit-schemas.mjs`. They drifted by nine
 * actions — the whole `resource.*` sharing family among them — and the only
 * symptom was one ERROR log per privileged mutation, on the side of the
 * emitter that deliberately never throws. Here `AUDIT_ACTIONS` is DERIVED from
 * the keys below, so an action without a schema is unrepresentable rather than
 * merely detectable.
 *
 * Plain ESM rather than TypeScript because both consumers must read this file
 * as-is: `service.ts` through the Next.js bundler, and the provisioning script
 * under bare `node` in the deploy Job (the runtime image ships no TypeScript
 * loader). Importing `service.ts` from the script is doubly impossible — it is
 * `import 'server-only'`.
 *
 * **Metadata values are TYPE NAMES, not examples.** The WorkOS API takes a
 * JSON-Schema-shaped `properties` map and `@workos-inc/node` passes each value
 * straight through as `{ type: <value> }`, so `'Example Org'` registers a
 * property whose type is the string "Example Org". And the KEYS must match
 * what the `recordAuditEvent` call site really sends: a schema with the wrong
 * keys rejects events exactly like a missing one. Every entry below was read
 * off its call site — when you change a `metadata:` object there, change it
 * here in the same commit.
 *
 * **Registering metadata makes it REQUIRED, actor metadata included.** WorkOS
 * generates the validator from what is registered here, and an entry with a
 * `metadata` map yields `required: [action, actor, context, occurred_at,
 * targets, metadata]` AND `actor: {required: [id, type, metadata]}` — the actor
 * clause appearing even though nothing here declares an actor schema. That is
 * why `recordAuditEvent` always sends both keys, `{}` when it has nothing to
 * put in them (issues #274/#277); do not "simplify" either one back to
 * `undefined`. Entries with no `metadata` map at all (`project.restored`) get
 * the permissive generic schema instead, and accept the empty objects too.
 */

/**
 * @typedef {'string' | 'number' | 'boolean'} AuditMetadataType
 * @typedef {{
 *   readonly targets: readonly { readonly type: string }[],
 *   readonly metadata?: Readonly<Record<string, AuditMetadataType>>,
 * }} AuditSchemaSpec
 */

/**
 * Per-agent-group model ids (`lib/model-config/agent-groups.ts`). Both model
 * surfaces audit the flattened group→model map they just saved, so both carry
 * the same optional keys; `reset`/`rollback` mark the two activate shortcuts
 * that carry no model map at all.
 */
const MODEL_GROUP_METADATA = /** @type {const} */ ({
  intent: 'string',
  clarifier: 'string',
  shallow_research: 'string',
  deep_research: 'string',
  deep_research_router: 'string',
  memory_reflection: 'string',
  ingest_vlm: 'string',
})

/**
 * `created` and `rotated` come off ONE call site
 * (`lib/llm-credentials/service.ts` picks the action by whether `rotatedFrom`
 * is set), so they carry the same metadata by construction.
 */
const LLM_CREDENTIAL_WRITE_METADATA = /** @type {const} */ ({
  provider: 'string',
  secretBackend: 'string', // pragma: allowlist secret (a metadata KEY and its type name, not a credential)
  keyFingerprint: 'string',
  supersededCredentialId: 'string',
  rotatedFrom: 'string',
})

export const AUDIT_SCHEMAS = /** @type {const} */ ({
  'org.created': {
    targets: [{ type: 'organization' }],
    metadata: { name: 'string' },
  },
  'org.settings.updated': {
    targets: [{ type: 'organization' }],
    metadata: { fields: 'string' },
  },
  // Storage quota (ADR-0042). Separate from `org.settings.updated` because it
  // is the one org setting that can stop every upload in the tenant, so "who
  // shrank the disk, and to what" has to be answerable on its own. `0` is the
  // wire form of "unlimited" — the metadata map admits primitives only.
  'org.storage_quota.updated': {
    targets: [{ type: 'organization' }],
    metadata: { quotaBytes: 'number' },
  },
  // Per-organization upload limit: the largest single non-model file the
  // tenant may upload. Its own action for the reason the quota has one: it
  // refuses uploads, so "who lowered it, and to what" must stand alone. `0` is
  // the wire form of "back to the deployment default".
  'org.upload_limit.updated': {
    targets: [{ type: 'organization' }],
    metadata: { maxUploadFileBytes: 'number' },
  },
  // An org-wide retry of every ingestion that failed to read (behind
  // "Rescan failed ingestions" in Organization > Enterprise). The counts
  // are the outcome, so the trail can answer who re-read the tenant's
  // estate and what came of it.
  'org.documents.reingested': {
    targets: [{ type: 'organization' }],
    metadata: { total: 'number', queued: 'number', skipped: 'number', failed: 'number', truncated: 'boolean' },
  },
  'budget.policy.set': {
    targets: [{ type: 'budget_policy' }],
    metadata: {
      scope: 'string',
      subjectId: 'string',
      // The limit's unit since 0080 (ADR-0053): 'credit' or 'token'. Before
      // 0079 the keys were dailyLimitEur/monthlyLimitEur.
      unit: 'string',
      dailyLimit: 'number',
      monthlyLimit: 'number',
    },
  },
  'budget.policy.cleared': {
    targets: [{ type: 'budget_policy' }],
    metadata: { scope: 'string', subjectId: 'string' },
  },
  'model_config.version.activated': {
    targets: [{ type: 'model_config_version' }],
    metadata: { ...MODEL_GROUP_METADATA, reset: 'boolean', rollback: 'boolean' },
  },
  // An office's own roles, kept in WorkOS (ADR-0087). The slug and the
  // permission list the role holds after the change; a role is a bundle of
  // permissions, so "who composed which bundle" is the trail that matters.
  'org.role.created': {
    targets: [{ type: 'organization' }],
    metadata: { role: 'string', permissions: 'string' },
  },
  'org.role.updated': {
    targets: [{ type: 'organization' }],
    metadata: { role: 'string', permissions: 'string' },
  },
  'org.role.deleted': {
    targets: [{ type: 'organization' }],
    metadata: { role: 'string', permissions: 'string' },
  },
  // A project folder restricted to roles, or opened again (ADR-0087). The
  // roles after the change, comma-separated; empty means open. Also emitted
  // when a folder move changes the restrictions over a subtree
  // (`folder-service.ts`): then `grants` is every folder with its own list now
  // over the moved folder, outermost first, each folder's `role:level` entries
  // comma-separated and the folders `;`-separated, and `roles` the same lists'
  // roles alone (the field the first, role-only design wrote, so a reader of the
  // trail finds it).
  'project.folder.access_changed': {
    targets: [{ type: 'project' }],
    metadata: { folderId: 'string', grants: 'string', roles: 'string', documentsMoved: 'number' },
  },
  // A folder moved to the Papierkorb with its subfolders and documents
  // (`lib/projects/folder-bin.ts`). Counts and the purge date; names stay out.
  'project.folder.binned': {
    targets: [{ type: 'project' }],
    metadata: { folderId: 'string', documents: 'number', folders: 'number', purgeAfter: 'string' },
  },
  // A folder put back from the Papierkorb. `restoredTo` is `original` or
  // `root` (its parent was gone).
  'project.folder.restored': {
    targets: [{ type: 'project' }],
    metadata: { folderId: 'string', documents: 'number', folders: 'number', restoredTo: 'string' },
  },
  // „Endgültig löschen" from the Papierkorb: the purge run at once.
  'project.folder.purged': {
    targets: [{ type: 'project' }],
    metadata: { folderId: 'string', documents: 'number', folders: 'number' },
  },
  // Organisation → Sensible Daten → „Inhalte aus gelöschten Ordnern".
  'org.deleted_folder_content.updated': {
    targets: [{ type: 'organization' }],
    metadata: { policy: 'string' },
  },
  // Upload screening (ADR-0086). Its own action rather than
  // `org.settings.updated`, because "who widened what may be uploaded" has to
  // be answerable on its own. Counts, not the lists: a term list can name
  // what an office considers sensitive, which is itself sensitive.
  'org.upload_screening.updated': {
    targets: [{ type: 'organization' }],
    metadata: {
      enabled: 'string',
      nameTerms: 'number',
      nameExceptions: 'number',
      contentTerms: 'number',
      detectors: 'string',
    },
  },
  // One project's changes to the office's sensitive-data name terms (ADR-0086,
  // 2026-10-20; migration 0154): terms added for the project and office terms
  // set aside there. Counts, never the terms, as for the office's list.
  'project.upload_screening.updated': {
    targets: [{ type: 'project' }],
    metadata: { addedNameTerms: 'number', removedNameTerms: 'number' },
  },
  // The download log (ADR-0088): who took which document's bytes. It is
  // personal data about staff, so READING it is recorded, one event per request
  // (every page, every filter). The filters are named, not their values' hits:
  // the event says who looked for whom, never what they found. The emitter is
  // `recordAuditEventOrThrow`: a read that cannot be recorded is not served.
  // A typed name filter is recorded as `nameFiltered`, not its text, which may
  // be a restricted document's name. `documentName` is no longer sent; it stays
  // registered so a pod of the previous release is not rejected mid-rollout.
  'download_log.viewed': {
    targets: [{ type: 'organization' }],
    metadata: {
      userId: 'string',
      documentId: 'string',
      documentName: 'string',
      nameFiltered: 'boolean',
      kind: 'string',
      from: 'string',
      to: 'string',
      continued: 'boolean',
    },
  },
  // How long the log is kept, in days (30-365). Its own action: it is the
  // setting that decides when staff records are destroyed.
  'download_log.retention.updated': {
    targets: [{ type: 'organization' }],
    metadata: { days: 'number', previous: 'number' },
  },
  'model_config.zdr.updated': {
    targets: [{ type: 'organization' }],
    // Emitted as String(enabled) — a string, not a boolean.
    metadata: { zdrOnly: 'string' },
  },
  'llm_credential.created': {
    targets: [{ type: 'llm_credential' }],
    metadata: LLM_CREDENTIAL_WRITE_METADATA,
  },
  'llm_credential.rotated': {
    targets: [{ type: 'llm_credential' }],
    metadata: LLM_CREDENTIAL_WRITE_METADATA,
  },
  'llm_credential.revoked': {
    targets: [{ type: 'llm_credential' }],
    metadata: { provider: 'string', keyFingerprint: 'string' },
  },
  'llm_credential.verified': {
    targets: [{ type: 'llm_credential' }],
    metadata: { provider: 'string', modelCount: 'number' },
  },
  'llm_credential.mode_changed': {
    targets: [{ type: 'organization' }],
    metadata: { mode: 'string' },
  },
  'compliance.hold.created': {
    targets: [{ type: 'legal_hold' }],
    metadata: { entityType: 'string', entityId: 'string' },
  },
  'compliance.hold.released': {
    targets: [{ type: 'legal_hold' }],
    metadata: { entityType: 'string', entityId: 'string' },
  },
  'platform.access.break_glass': {
    targets: [{ type: 'platform' }],
    metadata: { activeOrganizationId: 'string' },
  },
  // A fleet-wide default-model change: it re-points every organization that
  // has not chosen its own model, so it belongs in the platform org's trail.
  'platform.model_defaults.updated': {
    targets: [{ type: 'platform_model_defaults' }],
    metadata: MODEL_GROUP_METADATA,
  },
  // The same fleet-wide decision, taken by the app on first boot rather than by
  // an owner (`lib/model-config/bootstrap-defaults.ts`). A distinct action so the
  // trail distinguishes "nobody chose this yet, the system did" from a
  // deliberate save — the actor is `system:bootstrap`, not a WorkOS user.
  'platform.model_defaults.bootstrapped': {
    targets: [{ type: 'platform_model_defaults' }],
    metadata: MODEL_GROUP_METADATA,
  },
  // A fleet-wide reasoning-effort change: it re-tunes how many hidden thinking
  // tokens every organization spends per turn, so it belongs in the platform
  // org's trail next to the model decision it sits beside in the UI.
  'platform.reasoning_efforts.updated': {
    targets: [{ type: 'platform_reasoning_efforts' }],
    metadata: MODEL_GROUP_METADATA,
  },
  // A curation decision on the fleet-wide lesson register (Platform → Lessons):
  // activating, retiring or editing a lesson changes what every organization's
  // agent is told on its next turn, so it belongs in the platform org's trail.
  // The pipeline's own automatic transitions are NOT WorkOS events — they have
  // no human actor and live in the append-only platform_lesson_events table,
  // which is the system-side half of the same trail.
  'platform.lesson.updated': {
    targets: [{ type: 'platform_lesson' }],
    metadata: {
      status: 'string',
      contentChanged: 'boolean',
      rootCauseStatus: 'string',
      reason: 'string',
    },
  },
  'platform.norm_registry.updated': {
    targets: [{ type: 'norm_registry' }],
    metadata: { entries: 'number', version: 'number' },
  },
  // A fleet-wide retrieval-count change: every organization's retrieval depth
  // shifts on the next turn, so it belongs in the platform org's trail. The
  // whole `{key: value}` settings map is serialized into `settings`.
  'platform.retrieval_settings.updated': {
    targets: [{ type: 'platform_retrieval_settings' }],
    metadata: { settings: 'string', changed: 'number', note: 'string' },
  },
  // The price list (ADR-0053): a save reprices every organization's next
  // generation, so it belongs in the platform org's trail with the numbers
  // that changed and the version it replaced.
  'platform.pricing.updated': {
    targets: [{ type: 'platform_pricing_version' }],
    metadata: {
      marginMultiplier: 'number',
      usdPerCredit: 'number',
      defaultOrgDailyCredits: 'number',
      defaultOrgMonthlyCredits: 'number',
      supersedesId: 'string',
      note: 'string',
    },
  },
  'project.created': {
    targets: [{ type: 'project' }],
    metadata: { name: 'string' },
  },
  'project.deleted': {
    targets: [{ type: 'project' }],
    metadata: { name: 'string', purgeAfter: 'string' },
  },
  // Deliberately metadata-free: the target id says which project came back.
  'project.restored': {
    targets: [{ type: 'project' }],
  },
  // The project lifecycle (ADR-0098): every move under its own name, with the
  // state it left. Closing (read-only, open to every member, ADR-0090) also
  // says how the project ended and its Abschluss month.
  'project.paused': {
    targets: [{ type: 'project' }],
    metadata: { name: 'string', from: 'string' },
  },
  'project.resumed': {
    targets: [{ type: 'project' }],
    metadata: { name: 'string', from: 'string' },
  },
  'project.closed': {
    targets: [{ type: 'project' }],
    metadata: { name: 'string', from: 'string', outcome: 'string', endedOn: 'string' },
  },
  'project.reopened': {
    targets: [{ type: 'project' }],
    metadata: { name: 'string', from: 'string' },
  },
  // The Steckbrief (ADR-0091). A person is named by id only: the audit log
  // outlives an erasure, and a name in it would not.
  'project.period.changed': {
    targets: [{ type: 'project' }],
    metadata: { startedOn: 'string' },
  },
  'project.person.added': {
    targets: [{ type: 'project' }],
    metadata: { personId: 'string' },
  },
  'project.person.updated': {
    targets: [{ type: 'project' }],
    metadata: { personId: 'string' },
  },
  'project.person.deleted': {
    targets: [{ type: 'project' }],
    metadata: { personId: 'string' },
  },
  // „Ausmisten" at a close (ADR-0092): what the person confirmed into the
  // Papierkorb, and how far they went against Piloti's proposal.
  'project.cleanup.confirmed': {
    targets: [{ type: 'project' }],
    metadata: {
      removed: 'number',
      proposed: 'number',
      removedUnproposed: 'number',
      keptProposed: 'number',
      aiUsed: 'boolean',
      documentIds: 'string',
    },
  },
  'project.role.assigned': {
    targets: [{ type: 'project' }],
    metadata: { organizationMembershipId: 'string', roleSlug: 'string' },
  },
  'project.role.removed': {
    targets: [{ type: 'project' }],
    metadata: { organizationMembershipId: 'string', roleSlug: 'string' },
  },
  // `nameWithheld` (every action in `DOCUMENT_NAME_ACTIONS`, `service.ts`):
  // the document is filed under a folder not every project member may read,
  // so its name keys were left out (ADR-0087). The target id still says which.
  'document.uploaded': {
    targets: [{ type: 'document' }],
    metadata: { projectId: 'string', filename: 'string', fileSize: 'number', nameWithheld: 'boolean' },
  },
  // A file the name gate would have excluded, uploaded anyway because its
  // uploader released it in the upload dialog (ADR-0086): the Bauvertrag in a
  // folder called „Verträge". The terms say which rule was overridden; they
  // matched a piece of the name, so they are withheld with it.
  'document.screening_overridden': {
    targets: [{ type: 'document' }],
    metadata: { projectId: 'string', filename: 'string', terms: 'string', nameWithheld: 'boolean' },
  },
  // The content gate's own decision to hold a document back (ADR-0086): rule
  // based, before any model reads it. Its actor is `system:upload_screening`,
  // not a person, and `uploadedBy` names whose upload it was. The reasons are
  // kinds and terms (`term:Lohnzettel,iban`), never a matched sample or text,
  // ending `,…` when cut at 200 characters; `reasonsOmitted` counts the reasons
  // the job found and left out of its verdict, so a list is partial whenever
  // it is not zero (migration 0148); `checked` is `full` or `partial` (some
  // pages had no text layer). `jobId`
  // is the dispatch that decided: one job, one decision, one event. Sent at
  // least once from `document_quarantine_decisions`, under an idempotency key,
  // with the time of the decision rather than of the send. Like every action
  // that names a document, it leaves the name out under a folder not every
  // project member may read (`nameWithheld`).
  'document.quarantined': {
    targets: [{ type: 'document' }],
    metadata: {
      projectId: 'string',
      filename: 'string',
      scope: 'string',
      reasons: 'string',
      reasonsOmitted: 'number',
      checked: 'string',
      uploadedBy: 'string',
      jobId: 'string',
      nameWithheld: 'boolean',
    },
  },
  // A quarantined document a reviewer released for indexing (ADR-0086). The
  // reasons are the kinds of the content gate's verdict as stored on the row;
  // the terms are the office's words it found in the text, which say what the
  // document holds, so they are withheld with the name.
  'document.quarantine_released': {
    targets: [{ type: 'document' }],
    metadata: { projectId: 'string', filename: 'string', reasons: 'string', terms: 'string', nameWithheld: 'boolean' },
  },
  'document.deleted': {
    targets: [{ type: 'document' }],
    metadata: { projectId: 'string', filename: 'string', collectionName: 'string', nameWithheld: 'boolean' },
  },
  // A deliverable Piloti wrote, filed into the project on a human's authority
  // (agent-authored-documents design, decision 4 — the BFF writes it in the
  // commissioning user's session; the agent never writes).
  //
  // Its own action rather than a `document.uploaded` carrying a flag, for the
  // reason `session.document.*` are their own pair: the provenance question
  // these answer is different. `uploaded` answers "who put these bytes here";
  // `generated` answers "which human authorized a machine to write them, and
  // which run did it" — and that second half is not an optional embellishment
  // of an upload, it is the whole record. Folded into `document.uploaded` it
  // would be a key that is absent on almost every event of that action, which
  // is exactly the shape that cannot be queried or attested to.
  //
  // What produced it is NOT metadata: it rides as the second target, `{type:
  // <the reference's kind>, id: <the reference>}`, which `recordAuditEvent`
  // appends for an agent actor (see `AuditActorType` in `service.ts`). Hence
  // both kinds below — an emitted target type that is not registered is
  // rejected like an unregistered action, so any future action emitted with an
  // agent actor owes these same entries.
  //
  // There are TWO because there are two kinds of identity a machine-authored
  // document is filed under, and until migration 0066 both were emitted as
  // `agent_run`: a research report's reference is a backend async job id, and a
  // diagram's is the chat answer it was drawn in plus a hash of its source. One
  // target type for both meant an auditor resolving a diagram's provenance
  // looked up a job that does not exist. The list must stay in step with
  // `AUTHORED_REF_KINDS` in `lib/documents/document-authors.ts`, and
  // `schemas.spec.ts` is what notices when it does not — a kind added there and
  // missing here does not lose an audit line, it unfiles the document the line
  // was about, because this action's emit throws.
  // A task is the durable unit of delegated work (ADR-0051): created when a
  // job fires, completed when the worker reports, reviewed when a person judges
  // the result. The actor is the pinned requester on the first two — the
  // person whose permission the unattended work acts under — and the reviewer
  // on the third.
  'task.created': {
    targets: [{ type: 'task' }],
    metadata: { projectId: 'string', kind: 'string', jobId: 'string', trigger: 'string' },
  },
  'task.completed': {
    targets: [{ type: 'task' }],
    metadata: { projectId: 'string', kind: 'string', status: 'string' },
  },
  'task.reviewed': {
    targets: [{ type: 'task' }],
    metadata: { projectId: 'string', kind: 'string', decision: 'string', withReason: 'boolean' },
  },
  // A running task's worker was handed a fresh signed envelope, so its tools
  // keep acting as the requester (ADR-0108, `lib/runs/run-envelope.ts`). The
  // actor is that requester, re-checked at that moment; the target is the run.
  // The envelope itself is never in the trail.
  'task.envelope_renewed': {
    targets: [{ type: 'task' }],
    metadata: { projectId: 'string', kind: 'string', trigger: 'string' },
  },
  // The document lifecycle (ADR-0054). Six version transitions plus the item's
  // own archive. The actor is the person who decided — for the agent's internal
  // route that is the pinned requester, resolved from the signed envelope, never
  // a service token.
  //
  // `versionId` and `versionNumber` are both carried on purpose: the id is what
  // the deep link and the API use, the number is what a person says out loud
  // („Fassung 3 wurde freigegeben") and what survives in an export where the
  // uuid means nothing. `withComment` is a boolean rather than the comment
  // itself: the reviewer's words are tenant content and belong on the row, not
  // in a trail that leaves the tenant.
  'document.version.drafted': {
    targets: [{ type: 'document' }],
    metadata: {
      versionId: 'string',
      versionNumber: 'number',
      state: 'string',
      projectId: 'string',
      withComment: 'boolean',
    },
  },
  'document.version.submitted': {
    targets: [{ type: 'document' }],
    metadata: {
      versionId: 'string',
      versionNumber: 'number',
      state: 'string',
      projectId: 'string',
      withComment: 'boolean',
    },
  },
  'document.version.approved': {
    targets: [{ type: 'document' }],
    metadata: {
      versionId: 'string',
      versionNumber: 'number',
      state: 'string',
      projectId: 'string',
      withComment: 'boolean',
    },
  },
  'document.version.changes_requested': {
    targets: [{ type: 'document' }],
    metadata: {
      versionId: 'string',
      versionNumber: 'number',
      state: 'string',
      projectId: 'string',
      withComment: 'boolean',
    },
  },
  'document.version.rejected': {
    targets: [{ type: 'document' }],
    metadata: {
      versionId: 'string',
      versionNumber: 'number',
      state: 'string',
      projectId: 'string',
      withComment: 'boolean',
    },
  },
  // The publish door. Emitted for a human upload as well as for a Freigabe that
  // was reviewed: both are "these bytes are now the live version", and a trail
  // that recorded only one of them could not answer "when did this file last
  // change" without also reading `document.uploaded`.
  'document.version.published': {
    targets: [{ type: 'document' }],
    metadata: {
      versionId: 'string',
      versionNumber: 'number',
      state: 'string',
      projectId: 'string',
      withComment: 'boolean',
    },
  },
  // Item-level, not a version state: „archiviert" is a statement about the FILE.
  // The bytes and every version stay; the chunks go.
  'document.archived': {
    targets: [{ type: 'document' }],
    metadata: { projectId: 'string', filename: 'string', collectionName: 'string', nameWithheld: 'boolean' },
  },
  // Its reverse: back in the working set, and read into the index again
  // (`ingest`: queued, held or failed).
  'document.unarchived': {
    targets: [{ type: 'document' }],
    metadata: { projectId: 'string', filename: 'string', collectionName: 'string', ingest: 'string', nameWithheld: 'boolean' },
  },
  'document.generated': {
    targets: [{ type: 'document' }, { type: 'agent_run' }, { type: 'answer_artifact' }],
    // `producer` is emitted by `fileGeneratedDocument` and MUST be declared
    // here: a schema with the wrong keys rejects events exactly like a missing
    // one, and the emit for this action throws rather than swallowing — so an
    // unregistered key does not lose an audit line, it unfiles the document the
    // line was about.
    metadata: {
      projectId: 'string',
      producer: 'string',
      filename: 'string',
      fileSize: 'number',
      nameWithheld: 'boolean',
    },
  },
  // A rename changes what a document is CALLED, never which file it is, so the
  // trail records both: `filename` is the unchanged identity, the other two are
  // the label before and after.
  'document.renamed': {
    targets: [{ type: 'document' }],
    metadata: {
      filename: 'string',
      previousName: 'string',
      displayName: 'string',
      collectionName: 'string',
      nameWithheld: 'boolean',
    },
  },
  // A person confirmed, or took back, that one document replaces another
  // (CONTEXT.md, „Fassung"). Ids only, no file name: both documents are named
  // by their target and `olderDocumentId`, so the event needs no `filedIn` and a
  // restricted folder's names never reach the trail (ADR-0087). Archiv documents
  // use it too; `collectionName` says which shelf.
  'document.revision_changed': {
    targets: [{ type: 'document' }],
    metadata: { olderDocumentId: 'string', linked: 'boolean', collectionName: 'string' },
  },
  // A person exported a document's Anmerkungen as a Protokoll file
  // (`lib/annotations/export.ts`): office review content leaving the product.
  // What was asked for and how many marks it carried, never a name or a word
  // of the marks, so it needs no `filedIn`.
  'document.annotations.exported': {
    targets: [{ type: 'document' }],
    metadata: {
      format: 'string',
      scope: 'string',
      revision: 'string',
      includeProposals: 'boolean',
      markCount: 'number',
      proposalCount: 'number',
    },
  },
  // A person exported a project's Offene Punkte as one Protokoll across its
  // documents (`lib/annotations/project-export.ts`). The filters and the
  // counts, never a name or a word of the marks; `assignee` says only whether
  // the reader, one person or anyone was asked for (`me`, `person`, `any`).
  'project.annotations.exported': {
    targets: [{ type: 'project' }],
    metadata: {
      format: 'string',
      status: 'string',
      assignee: 'string',
      due: 'string',
      documentCount: 'number',
      markCount: 'number',
      proposalCount: 'number',
    },
  },
  'office_shelf.document.uploaded': {
    targets: [{ type: 'document' }],
    metadata: { filename: 'string', fileSize: 'number', collectionName: 'string' },
  },
  'office_shelf.document.deleted': {
    targets: [{ type: 'document' }],
    metadata: { filename: 'string', collectionName: 'string' },
  },
  // The three `archiv.document.*` actions below are what the office shelf's trail
  // was called before it had an English name. Nothing writes them any more; the
  // history keeps them, so they stay in the catalogue for every reader, filter
  // and label. Never remove them while rows with the old name exist.
  'archiv.document.uploaded': {
    targets: [{ type: 'document' }],
    metadata: { filename: 'string', fileSize: 'number', collectionName: 'string' },
  },
  'archiv.document.deleted': {
    targets: [{ type: 'document' }],
    metadata: { filename: 'string', collectionName: 'string' },
  },
  // A file attached privately to one chat (ADR-0047 Phase 2). Its own pair
  // rather than reusing `document.*`: the provenance question these answer is
  // "which conversation", and a null `projectId` in a `document.uploaded` event
  // could not distinguish a session attachment from an Archiv one.
  'session.document.uploaded': {
    targets: [{ type: 'document' }],
    metadata: { conversationId: 'string', filename: 'string', fileSize: 'number' },
  },
  'session.document.deleted': {
    targets: [{ type: 'document' }],
    metadata: { conversationId: 'string', filename: 'string', collectionName: 'string' },
  },
  'office_shelf.document.renamed': {
    targets: [{ type: 'document' }],
    metadata: {
      filename: 'string',
      previousName: 'string',
      displayName: 'string',
      collectionName: 'string',
    },
  },
  // Retired name of `office_shelf.document.renamed`; history only (see above).
  'archiv.document.renamed': {
    targets: [{ type: 'document' }],
    metadata: {
      filename: 'string',
      previousName: 'string',
      displayName: 'string',
      collectionName: 'string',
    },
  },
  // The restricted-memory judge's verdict on one note (ADR-0087), a language
  // model deciding who may read it: `drawn` (it named folders the note draws
  // on), `none` (it named none, so they add no restriction) or `failed` (no
  // usable answer; restricted to every folder in scope). Actor
  // `system:memory_judge`. The note by id, never its text. `judgedFolders` were
  // shown to the judge, `drawnFolders` it named, `restrictedFolders` the note
  // was stored with; each a folder id, or the collection name when it no
  // longer resolves to one, comma-separated, cut at 500 characters (the counts
  // say when). `projectId` is empty for organization memory. `outcome` is
  // `stored`, the target the note, or `refused`, the target the organization:
  // an organization-wide finding this deployment does not let the agent store
  // (the default), which the agent then offers the user as a card.
  'project.memory.restriction_judged': {
    targets: [{ type: 'project_memory_item' }, { type: 'organization' }],
    metadata: {
      projectId: 'string',
      verdict: 'string',
      outcome: 'string',
      judgedFolders: 'string',
      judgedCount: 'number',
      drawnFolders: 'string',
      drawnCount: 'number',
      restrictedFolders: 'string',
      provenance: 'string',
      conversationId: 'string',
    },
  },
  // Sharing (ADR-0032). Access-control changes on a resource are privileged
  // mutations and get the same trail as project role grants. The target type is
  // the shared resource's own type (`SHAREABLE_RESOURCE_TYPES`) — today only
  // `conversation`; adding a member there means adding it here too.
  'resource.shared': {
    targets: [{ type: 'conversation' }],
    metadata: { subject: 'string', role: 'string', visibility: 'string' },
  },
  'resource.share.revoked': {
    targets: [{ type: 'conversation' }],
    metadata: { subject: 'string', self: 'boolean' },
  },
  'resource.share.role_changed': {
    targets: [{ type: 'conversation' }],
    metadata: { subject: 'string', from: 'string', role: 'string' },
  },
  'resource.visibility.changed': {
    targets: [{ type: 'conversation' }],
    metadata: { from: 'string', to: 'string' },
  },
  // A project admin taking ownership of a resource they were not party to.
  // Distinct from `resource.shared` on purpose: it is the one path by which
  // someone gains access to a PRIVATE resource without being invited, so it must
  // be visible as such in the trail (spec SH-10, SH-14).
  'resource.ownership.escalated': {
    targets: [{ type: 'conversation' }],
    metadata: { previousRole: 'string', via: 'string' },
  },
  // A wake of Piloti held before Piloti was asked (ADR-0106): a cap held it,
  // the organization's switch was off by the time it ran, the person lost the
  // right to write the document or left, the mark or the reply is gone, or the
  // delegation was taken back (`stage` enqueue or claim, `status` suppressed;
  // no model call, no Langfuse trace). This and its `piloti_wakes` row are its
  // record. The actor is the person whose act would have woken Piloti. Until
  // 2026-10-14 a turn that ran and failed (`stage: 'turn'`), and a wake the job
  // ended `refused` (a spent budget) or `failed` (gave up waiting, a rejected
  // message) were recorded here too; they are now `piloti.wake.ended`.
  'piloti.wake.suppressed': {
    targets: [{ type: 'document_annotation' }],
    metadata: { documentId: 'string', trigger: 'string', status: 'string', reason: 'string', stage: 'string' },
  },
  // ---------------------------------------------------------------------------
  // What Piloti did in the office, and what people did about it. Every action
  // is `piloti.*`, so the viewer's action filter is "everything Piloti did".
  //
  // The actor is always a PERSON, never Piloti (`AuditActorType`, `service.ts`):
  // Piloti acts in a person's session as that person (ADR-0105, ADR-0108), so
  // the person it acted for is the actor of what it did, and the person who
  // undid or decided is the actor of that. The audit-log filters by actor, so
  // "what did Piloti do for Anna" is Anna's actor filter plus the `piloti.*`
  // actions. The turn rides as the `conversation` target and `messageId` (the
  // answer the turn wrote, the id its Langfuse trace and its change card carry).
  //
  // Ids, numbers, kinds and counts only: never a word of a mark, a note, a
  // reply, a proposal or a document. So no action here names a document, and
  // none needs `filedIn`.
  // ---------------------------------------------------------------------------
  // One change Piloti applied in the asker's name (ADR-0109): set (`create`,
  // `status` proposed or open), changed (`update`, `fields` the names that
  // moved), deleted a mark, or answered in its thread (`reply`). One event per
  // `piloti_changes` row; `changeId` is the row, absent when it could not be
  // written. Actor: the person the turn acted for.
  'piloti.change.applied': {
    targets: [{ type: 'document_annotation' }, { type: 'document' }, { type: 'project' }, { type: 'conversation' }],
    metadata: {
      op: 'string',
      markNumber: 'number',
      markKind: 'string',
      status: 'string',
      fields: 'string',
      messageId: 'string',
      changeId: 'string',
    },
  },
  // A person undid one of those changes (`POST /api/piloti-changes/[id]/undo`).
  // Actor: the person who undid it; `onBehalfOf` whom Piloti had made it for.
  // `inverse` is what undoing did: dismiss, revert, recreate, delete,
  // delete-reply.
  'piloti.change.undone': {
    targets: [{ type: 'document_annotation' }, { type: 'document' }, { type: 'conversation' }],
    metadata: {
      op: 'string',
      inverse: 'string',
      markNumber: 'number',
      onBehalfOf: 'string',
      messageId: 'string',
      changeId: 'string',
    },
  },
  // A person answered an outside agent's destructive call in their own chat
  // (MCP elicitation, ADR-0122 amendment; `lib/agent-api/confirmation.ts`).
  // Actor: the person. `decision` applied, failed (the route refused it) or
  // declined; `decisionSource` elicitation; `operation` the catalog name;
  // `clientId` the OAuth client that asked. Targets: the organization, and the
  // projects and documents the call names.
  'agent.operation.decided': {
    targets: [{ type: 'organization' }, { type: 'project' }, { type: 'document' }],
    metadata: { operation: 'string', decision: 'string', decisionSource: 'string', clientId: 'string' },
  },
  // Piloti filed a proposed change (ADR-0105) in a person's name. Once per
  // card: the same card again files nothing new and emits nothing. `kind` is
  // file_operation, memory, project_profile or operation; `operation` the file
  // verb, or the catalog operation's name for an `operation` proposal;
  // `items` how many; `memoryScope` where a note would go.
  'piloti.proposal.created': {
    targets: [{ type: 'proposed_change' }, { type: 'project' }, { type: 'conversation' }],
    metadata: { kind: 'string', operation: 'string', items: 'number', memoryScope: 'string', messageId: 'string' },
  },
  // A person decided it: `decision` applied, partially_applied, failed or
  // dismissed. Actor: the decider; `onBehalfOf` whose turn proposed it.
  // `memoryScope` is where an applied note went (the decider may have narrowed
  // it to the project), else where Piloti proposed it.
  'piloti.proposal.decided': {
    targets: [{ type: 'proposed_change' }, { type: 'project' }, { type: 'conversation' }],
    metadata: {
      kind: 'string',
      decision: 'string',
      operation: 'string',
      items: 'number',
      appliedItems: 'number',
      memoryScope: 'string',
      onBehalfOf: 'string',
      messageId: 'string',
    },
  },
  // A person decided on a mark Piloti proposed, on the canvas: took it over
  // (`decision` taken_over, the mark is open and theirs) or dismissed it
  // (`dismissed`). One event per mark, for the move that left `proposed`; a
  // colleague's earlier move (409) records nothing. Actor: the person who
  // decided; `onBehalfOf` the person Piloti proposed it for (the mark's
  // `created_by`). `markKind` defect, question, note…
  'piloti.mark.decided': {
    targets: [{ type: 'document_annotation' }, { type: 'document' }, { type: 'project' }],
    metadata: { decision: 'string', markNumber: 'number', markKind: 'string', onBehalfOf: 'string' },
  },
  // A wake started a turn (ADR-0106): the socket took it. Actor: the person
  // whose act woke Piloti, as whom the turn runs; the conversation is their
  // thread about the document. `waits` is how often it waited for a busy
  // thread first.
  'piloti.wake.started': {
    targets: [{ type: 'document_annotation' }, { type: 'document' }, { type: 'project' }, { type: 'conversation' }],
    metadata: { trigger: 'string', wakeId: 'string', markNumber: 'number', waits: 'number' },
  },
  // How a wake ended, once: its turn's end (`lib/turns/outcome.ts`; `outcome`
  // answered, stopped or failed, `turnOutcome` what the socket reported), or
  // the wake job's before a turn answered (`lib/annotations/wake-job.ts`;
  // `outcome` refused for a spent budget or a refusal at the socket, failed for
  // a give-up or a rejected message; no `turnOutcome`). `reason` is the stored
  // reason (cut at 200), `reasonKind` its class as the person's inbox notice
  // words it: budget, busy, access or error. `handedBack`: the delegation ended
  // with it.
  'piloti.wake.ended': {
    targets: [{ type: 'document_annotation' }, { type: 'document' }, { type: 'project' }, { type: 'conversation' }],
    metadata: {
      trigger: 'string',
      wakeId: 'string',
      outcome: 'string',
      turnOutcome: 'string',
      reason: 'string',
      reasonKind: 'string',
      handedBack: 'boolean',
      markNumber: 'number',
    },
  },
  // A person took the mark back from Piloti, or deleted it, and that stopped
  // its wake: still `queued` (it will start no turn) or `started` (its turn is
  // being stopped, and ends with `piloti.wake.ended`, `outcome: 'stopped'`).
  // Actor: who took it back; `wokenBy` whose delegation it was. `by` is
  // `piloti` when Piloti closed the mark in a person's name.
  'piloti.wake.stopped': {
    targets: [{ type: 'document_annotation' }, { type: 'document' }, { type: 'project' }, { type: 'conversation' }],
    metadata: { trigger: 'string', wakeId: 'string', wakeStatus: 'string', wokenBy: 'string', by: 'string' },
  },
  // Assignment is not access (ADR-0047). Who is on the hook for a file.
  'resource.assigned': {
    targets: [{ type: 'document' }],
    metadata: { subjectUserId: 'string' },
  },
  'resource.unassigned': {
    targets: [{ type: 'document' }],
    metadata: { subjectUserId: 'string' },
  },
  // --- The E-Mail-Eingang (ADR-0134) -----------------------------------------
  // Mail a stranger may write. Every key below is an id, a code, a count or a
  // flag, never a sender, a subject, a file name, an address or a token: the
  // trail outlives the scrub of a settled mail (migration 0186), and the PII
  // canary (`receive-job.spec.ts`) feeds distinctive values through the receive
  // path and asserts none reaches this metadata. Codes are the vocabularies'
  // own tokens (`inbound-mail-vocabulary.ts`); a list is comma-joined.
  //
  // A mail reached its project's E-Mail-Eingang (or was dropped as automatic
  // mail: then only `dropped` is set). Actor `system:inbound_mail`: the receive
  // job decides nothing a person would, it labels and holds. `senderFlags` and
  // `riskFlags` are comma-joined codes; `rawScan` is the whole message's scan.
  'inbound_mail.received': {
    targets: [{ type: 'inbound_mail' }, { type: 'project' }],
    metadata: {
      projectId: 'string',
      senderTrust: 'string',
      senderReason: 'string',
      senderFlags: 'string',
      automatic: 'boolean',
      dropped: 'string',
      attachments: 'number',
      notStaged: 'number',
      riskFlags: 'string',
      rawScan: 'string',
      unreadable: 'boolean',
      threadMatches: 'number',
      followQueued: 'boolean',
    },
  },
  // Nobody decided within the window (sweep 3): its parts are `expired`,
  // restorable for seven days. Actor `system:inbound_mail`.
  'inbound_mail.expired': {
    targets: [{ type: 'inbound_mail' }, { type: 'project' }],
    metadata: { projectId: 'string', parts: 'number' },
  },
  // A person read the bytes of a held attachment (`inbound-mail-part-content-get`).
  'inbound_mail.part_read': {
    targets: [{ type: 'inbound_mail' }, { type: 'project' }],
    metadata: { projectId: 'string', partId: 'string', scan: 'string' },
  },
  // A person downloaded a held mail's original `.eml` (`inbound-mail-original-get`),
  // scanned whole on the request; `scan` is that scan's status.
  'inbound_mail.original_read': {
    targets: [{ type: 'inbound_mail' }, { type: 'project' }],
    metadata: { projectId: 'string', scan: 'string' },
  },
  // One decision row (`inbound_mail_decisions`), sent at least once from the
  // table under an idempotency key (sweep 11 drains `audited_at IS NULL`), with
  // the time of the decision. Actor: the person who decided; `via` says whether
  // in the app, as an outside agent, through a Piloti card or as their follow.
  // The acknowledgements are what the person explicitly accepted.
  'inbound_mail.decided': {
    targets: [{ type: 'inbound_mail' }, { type: 'project' }],
    metadata: {
      projectId: 'string',
      decisionId: 'string',
      partId: 'string',
      partKind: 'string',
      action: 'string',
      via: 'string',
      threadAction: 'string',
      mailThreadId: 'string',
      documentType: 'string',
      targetDocumentId: 'string',
      followId: 'string',
      proposalId: 'string',
      screeningRelease: 'boolean',
      acknowledgedSender: 'boolean',
      acknowledgedRisk: 'boolean',
    },
  },
  // A project got its address, a new one replaced it (the old one stops at
  // once and every follow on the project ends, `followsEnded`), or the project
  // stopped taking mail. Actor: the project manager who did it.
  'inbound_mail_address.created': {
    targets: [{ type: 'inbound_mail_address' }, { type: 'project' }],
    metadata: { projectId: 'string' },
  },
  'inbound_mail_address.rotated': {
    targets: [{ type: 'inbound_mail_address' }, { type: 'project' }],
    metadata: { projectId: 'string', previousAddressId: 'string', followsEnded: 'number' },
  },
  'inbound_mail_address.deleted': {
    targets: [{ type: 'inbound_mail_address' }, { type: 'project' }],
    metadata: { projectId: 'string' },
  },
  // A person's standing decision to append a thread's later verified replies
  // as themselves (D31): started or renewed for `days`, and ended with its
  // reason (`MAIL_THREAD_FOLLOW_END_REASONS`); `followerUserId` names whose
  // follow ended when a manager or the system ended it.
  'mail_thread.follow_started': {
    targets: [{ type: 'mail_thread' }, { type: 'project' }],
    metadata: { projectId: 'string', followId: 'string', days: 'number', renewed: 'boolean' },
  },
  'mail_thread.follow_ended': {
    targets: [{ type: 'mail_thread' }, { type: 'project' }],
    metadata: { projectId: 'string', followId: 'string', reason: 'string', followerUserId: 'string' },
  },
  // A filed message moved out of its thread into another or a new one (D34).
  'mail_thread.entry_detached': {
    targets: [{ type: 'mail_thread_entry' }, { type: 'mail_thread' }, { type: 'project' }],
    metadata: { projectId: 'string', fromThreadId: 'string', toThreadId: 'string', threadAction: 'string' },
  },
  // A reader of the thread downloaded a filed message's original `.eml`,
  // scanned whole on the request; `scan` is that scan's status.
  'mail_thread.original_read': {
    targets: [{ type: 'mail_thread_entry' }, { type: 'mail_thread' }, { type: 'project' }],
    metadata: { projectId: 'string', scan: 'string' },
  },
})

/** @typedef {keyof typeof AUDIT_SCHEMAS} AuditAction */

/**
 * Every action the app may emit — derived, never hand-maintained. `tsc` already
 * confines each `recordAuditEvent` call site to this union, so the compiler now
 * carries the guarantee end-to-end: call site → action → registered schema.
 *
 * @type {readonly AuditAction[]}
 */
/**
 * Actions kept only so history reads: their schemas stay registered and their
 * labels resolve, but nothing writes them. `schemas.spec.ts` holds both halves:
 * no call site emits one, and none counts as an orphan. Remove an entry once no
 * event under the old name is left in the retention window.
 */
export const RETIRED_AUDIT_ACTIONS = /** @type {const} */ ([
  'archiv.document.uploaded',
  'archiv.document.deleted',
  'archiv.document.renamed',
])

/**
 * Actions registered ahead of their emitter, while the change that adds them is
 * assembled from several work packages (PR-D of ADR-0134: the schemas land
 * first, so every package emits against one registry). `schemas.spec.ts` holds
 * both halves: none of them counts as an orphan, and an action that HAS an
 * emitter fails until it is taken off this list, so the list only shrinks. It
 * must be empty before the change merges (the integrator's checklist).
 */
export const AWAITING_EMITTER_AUDIT_ACTIONS = /** @type {const} */ ([
  'inbound_mail.expired',
  'mail_thread.follow_started',
])

export const AUDIT_ACTIONS = /** @type {AuditAction[]} */ (Object.keys(AUDIT_SCHEMAS))
