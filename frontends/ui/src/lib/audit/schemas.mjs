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
  'budget.policy.set': {
    targets: [{ type: 'budget_policy' }],
    metadata: {
      scope: 'string',
      subjectId: 'string',
      dailyLimitEur: 'number',
      monthlyLimitEur: 'number',
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
  'project.role.assigned': {
    targets: [{ type: 'project' }],
    metadata: { organizationMembershipId: 'string', roleSlug: 'string' },
  },
  'project.role.removed': {
    targets: [{ type: 'project' }],
    metadata: { organizationMembershipId: 'string', roleSlug: 'string' },
  },
  'document.uploaded': {
    targets: [{ type: 'document' }],
    metadata: { projectId: 'string', filename: 'string', fileSize: 'number' },
  },
  'document.deleted': {
    targets: [{ type: 'document' }],
    metadata: { projectId: 'string', filename: 'string', collectionName: 'string' },
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
  // The run id is NOT metadata: it rides as the second target, `{type:
  // 'agent_run', id: runId}`, which `recordAuditEvent` appends for an agent
  // actor (see `AuditActorType` in `service.ts`). Hence `agent_run` below —
  // an emitted target type that is not registered is rejected like an
  // unregistered action, so any future action emitted with an agent actor owes
  // this same entry.
  'document.generated': {
    targets: [{ type: 'document' }, { type: 'agent_run' }],
    metadata: { projectId: 'string', filename: 'string', fileSize: 'number' },
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
    },
  },
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
  'archiv.document.renamed': {
    targets: [{ type: 'document' }],
    metadata: {
      filename: 'string',
      previousName: 'string',
      displayName: 'string',
      collectionName: 'string',
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
  // Assignment is not access (ADR-0047). Who is on the hook for a file.
  'resource.assigned': {
    targets: [{ type: 'document' }],
    metadata: { subjectUserId: 'string' },
  },
  'resource.unassigned': {
    targets: [{ type: 'document' }],
    metadata: { subjectUserId: 'string' },
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
export const AUDIT_ACTIONS = /** @type {AuditAction[]} */ (Object.keys(AUDIT_SCHEMAS))
