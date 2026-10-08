/** The organization management page (admin). */
export const organization = {
  title: 'Organization',
  subtitle: 'Manage your organization, its members, and access.',
  loading: 'Loading organization…',
  memberSubtitle: 'Your usage and your organization at a glance.',
  backToApp: 'Back to projects',
  nav: {
    label: 'Organization sections',
    overview: 'Overview',
    access: 'People & access',
    models: 'Models',
    budgets: 'Usage & budgets',
    storage: 'Storage',
    screening: 'Sensitive data',
    quarantine: 'Quarantine',
    compliance: 'Compliance',
    enterprise: 'Enterprise',
  },
  /** Page headers of the section routes — one heading per route, not per card. */
  sections: {
    overview: {
      title: 'Overview',
      subtitle:
        'Your organization at a glance — name, domains, members, and the Piloti settings that apply to everyone in it.',
    },
    access: {
      title: 'People & access',
      subtitle:
        'Who is in the organization, the role each of them holds, and what that role is allowed to do.',
    },
    models: {
      title: 'Models',
      subtitle:
        'Which model each part of the agent runs on, and whether it runs on the platform key or your own.',
    },
    budgets: {
      title: 'Usage & budgets',
      subtitle:
        'LLM spend against the limits it is checked against. Admins see the whole organization, everyone else their own.',
    },
    storage: {
      title: 'Storage',
      subtitle:
        'How much document storage this organization uses, and the quota that bounds it.',
    },
    screening: {
      title: 'Sensitive data',
      subtitle: 'What your office wants no language model to see, and how Piloti recognises it.',
    },
    quarantine: {
      title: 'Quarantine',
      subtitle: 'Files the content check held back. No model has read them. Whoever may review them releases or deletes them here.',
    },
    compliance: {
      title: 'Compliance',
      subtitle:
        'The audit trail of every privileged change, plus the legal holds and deletions that answer for your data.',
    },
    enterprise: {
      title: 'Enterprise',
      subtitle:
        'SSO, directory sync, domain verification and audit-log streaming — the WorkOS controls only an admin may touch.',
    },
  },
  /** People & access: the member directory, the role catalog, the permission map. */
  access: {
    people: {
      title: 'People',
      description: 'Everyone in the organization and the role they were given.',
      columnName: 'Name',
      columnEmail: 'Email',
      columnRole: 'Role',
      columnStatus: 'Status',
      noRole: 'No role',
      empty: 'Nobody has joined this organization yet.',
      loadError:
        'Could not load the member directory right now. Roles can still be changed below.',
    },
    roles: {
      title: 'Roles',
      description: 'The roles this organization can hand out, and what each one unlocks.',
      // Singular/plural is chosen in the component — this i18n has no ICU.
      permissionCountOne: '1 permission',
      permissionCountOther: '{count} permissions',
      platformNotice:
        'Platform staff only. These roles live in the GRID Platform organization and cannot be assigned here.',
    },
    permissions: {
      title: 'Permissions',
      description: 'Every permission the organization knows about, and the roles that grant it.',
      columnPermission: 'Permission',
      grantedBy: 'Granted by',
      noRoles: 'No role grants this',
      deprecated: 'Deprecated',
    },
    // Shared by the role catalog and the permission reference — one tier
    // vocabulary, so the two surfaces cannot drift into different words for
    // the same thing.
    tiers: {
      org: 'Organization',
      project: 'Project',
      skill: 'Skill schedule',
      platform: 'Platform',
    },
    // The gate here is `org:members:manage`, NOT org admin — borrowing the
    // notAdmin copy would tell a User Admin the wrong thing about why they
    // are being refused.
    notAllowed: {
      title: 'You cannot manage people here',
      description:
        'Managing people and roles needs the “Manage people and roles” permission. An organization admin can grant it.',
    },
  },
  /**
   * Personen & Zugriff → Eigene Rollen (ADR-0086): roles an office builds in
   * WorkOS, assigned on the People tab, named by restricted folders.
   */
  customRoles: {
    title: 'Custom roles',
    description:
      'Roles your office builds itself, beside Piloti’s. A role bundles permissions under a name such as “Management”.',
    howTo:
      'You assign roles to people on the People tab. A project folder can be restricted to one or more roles: then only people holding one of them see the folder, its documents and what Piloti answers from them. Organization admins always see everything.',
    oneRoleTitle: 'One role per person',
    oneRoleBody:
      'Unless your organization has multiple roles per person switched on, everyone holds exactly one role. A role you use for folders must then also carry the permissions its holders work with.',
    create: 'New role',
    customGroup: 'Your office’s roles',
    environmentGroup: 'Piloti’s roles',
    environmentHint: 'Provided by Piloti for every organization. They cannot be changed here.',
    emptyTitle: 'No custom roles yet',
    emptyDescription: 'Create a role such as “Management” to restrict folders to the people who hold it.',
    permissionCount: '{count, plural, one {# permission} other {# permissions}}',
    editRole: 'Edit role “{name}”',
    deleteRole: 'Delete role “{name}”',
    loadError: 'The roles could not be loaded right now.',
    readOnly: 'Only people with the “Manage people and roles” permission can change custom roles.',
    editor: {
      createTitle: 'New role',
      editTitle: 'Edit role “{name}”',
      createDescription:
        'Name the role and choose what it may do. You assign it to people on the People tab afterwards.',
      editDescription: 'The identifier stays the same, and everyone who holds the role keeps it.',
      name: 'Name',
      namePlaceholder: 'e.g. Management',
      nameHint:
        'Piloti derives the role’s identifier from its name when you create it. The identifier stays the same afterwards, even if you rename the role.',
      nameRequired: 'Give the role a name.',
      description: 'Description (optional)',
      descriptionPlaceholder: 'Who holds this role, and what for',
      permissions: 'Permissions',
      permissionsHint:
        'These permissions apply across the whole organization. Access to individual projects is granted per project.',
      notGrantable: 'You do not hold this permission yourself, so you cannot grant it.',
      create: 'Create role',
      save: 'Save',
      saving: 'Saving…',
      created: 'Role “{name}” created. Assign it on the People tab.',
      saved: 'Role “{name}” saved.',
      saveError: 'The role could not be saved. Please try again.',
      nameTaken: 'A role with this name already exists.',
      forbidden: 'You can only put permissions you hold yourself into a role.',
      discardTitle: 'Discard your changes?',
      discardDescription: 'What you entered for this role has not been saved.',
      discardConfirm: 'Discard',
      keepEditing: 'Keep editing',
    },
    deleteDialog: {
      title: 'Delete the role “{name}”?',
      description:
        'A role can only be deleted once nobody holds it. A folder restricted to this role alone is then visible to organization admins only.',
      confirm: 'Delete role',
      deleted: 'Role “{name}” deleted.',
      stillAssigned: 'Somebody still holds this role. Give them another role on the People tab first.',
      error: 'The role could not be deleted. Please try again.',
    },
    /** One label and one line per organization permission, keyed by the slug after `org:` with `:` as `_`. */
    permission: {
      settings_manage: { name: 'Manage organization settings', hint: 'Name, language and defaults of the organization.' },
      models_manage: { name: 'Manage AI models', hint: 'Which model each part of Piloti works with.' },
      budgets_manage: { name: 'Manage budgets', hint: 'Spending limits and usage of the whole organization.' },
      compliance_manage: { name: 'Manage compliance', hint: 'Legal holds and deletions.' },
      audit_view: { name: 'View the audit log', hint: 'The record of every privileged change.' },
      archiv_manage: {
        name: 'Manage the Archiv',
        hint: 'Upload, delete and re-read documents in the office Archiv. Everyone can read it.',
      },
      skills_manage: {
        name: 'Manage skills',
        hint: 'Write, change and delete the office’s skills. Everyone can use them.',
      },
      projects_create: { name: 'Create projects', hint: 'Start new projects.' },
      projects_administer: {
        name: 'Administer all projects',
        hint: 'Reach every project without being added to it, and see every restricted folder.',
      },
      members_manage: {
        name: 'Manage people and roles',
        hint: 'Invite people, change their roles, and build roles here.',
      },
    },
  },
  overview: {
    title: 'Overview',
    description: 'Your organization at a glance.',
    name: 'Name',
    id: 'Organization ID',
    domains: 'Domains',
    noDomains: 'No verified domains',
    created: 'Created',
    members: 'Members',
    membersCapped: '{count}+',
    pendingInvites: 'Pending invitations',
  },
  settings: {
    title: 'Organization settings',
    description: 'Piloti-specific settings for your organization.',
    displayName: 'Display name',
    displayNameHint: 'Shown inside Piloti. Leave blank to use the WorkOS organization name.',
    displayNamePlaceholder: 'e.g. Acme Architektur GmbH',
    defaultLocale: 'Default language for new members',
    defaultLocaleHint: 'New members start in this language until they choose their own.',
    chatEffort: 'Default effort for new chats',
    chatEffortHint:
      'How long Piloti thinks in a new chat. Every member can change the effort in the chat itself; this is only where it starts.',
    webSearch: 'Web search',
    webSearchHint:
      'Allow agents to search the public web. When off, web-search tools disappear from the picker and are blocked server-side for every member.',
    save: 'Save changes',
    saving: 'Saving…',
    saved: 'Organization settings saved',
    saveError: 'Could not save organization settings. Please try again.',
    loadError: 'Could not load organization settings right now. Please refresh to try again.',
  },
  /**
   * Organization → Instructions: the standing block every answer in the
   * organization is written under. The hint states the boundary out loud,
   * because the boundary is the point: standing preferences on form, focus and
   * workflow — never a rule that overrides Piloti, never a normative value.
   */
  instructions: {
    title: 'Instructions',
    description:
      'What Piloti should keep in mind for your organization. Sent with every request.',
    label: 'Standing instructions',
    placeholder:
      'e.g. Lead with the verdict, then the reasoning. Assume Vienna when no Bundesland is named. Always append a list of deficiencies to a review.',
    hint: 'Standing preferences on form, focus and workflow. They never override Piloti’s own rules and never supply a normative value — an OIB requirement comes from the guideline, never from this box.',
    remaining: '{used} of {max} characters',
    overCap: '{over} characters over. Shorten the text before saving.',
    save: 'Save instructions',
    saving: 'Saving…',
    saved: 'Instructions saved',
    clear: 'Clear',
    cleared: 'Instructions cleared',
    saveError: 'Could not save the instructions. Please try again.',
    loadError: 'Could not load the instructions right now. Please refresh to try again.',
  },
  members: {
    title: 'Members',
    description: 'Invite people, assign roles, and manage who has access.',
  },
  advanced: {
    title: 'Advanced',
    description: 'Enterprise access controls. Only options your role can manage are shown.',
    sso: 'Single Sign-On (SSO)',
    ssoDescription: 'Connect an identity provider so members sign in with your IdP.',
    directory: 'Directory Sync (SCIM)',
    directoryDescription: 'Automatically provision and de-provision members from your directory.',
    domains: 'Domain verification',
    domainsDescription: 'Verify domains your organization owns.',
    auditLogs: 'Audit log streaming',
    auditLogsDescription: 'Stream audit events to your SIEM or logging provider.',
    reingestFailed: {
      title: 'Rescan failed ingestions',
      description:
        'Reads again every file that could not be read. Nothing that already works is touched.',
      action: 'Rescan failed ingestions',
      busy: 'Rescanning.',
      started: 'The rescan has started. It runs in the background and carries on after a restart.',
      failed: 'The rescan could not be started. Please try again.',
    },
  },
  notAdmin: {
    title: 'You need admin access',
    description:
      'Only organization admins can manage the organization. Ask an admin if you need access.',
  },
  models: {
    title: 'AI model configuration',
    description:
      'Choose which OpenRouter model each agent group runs on. Changes apply to new conversations immediately; every save is a new version you can roll back to.',
    defaultModel: 'Platform default',
    defaultBadge: 'Default',
    overrideBadge: 'Override',
    discard: 'Discard changes',
    unsavedChanges: 'Unsaved changes — save them as a new version or discard.',
    change: 'Change',
    searchPlaceholder: 'Search appropriate models…',
    noResults: 'No appropriate models match your search.',
    contextWindow: 'Context',
    /** The platform's reference request priced at the current price list (ADR-0053). */
    creditsPerRequest: '≈ {credits} credits per request',
    resetToDefault: 'Use default',
    comment: 'Change note (optional)',
    commentPlaceholder: 'Why are you changing models?',
    save: 'Save as new version',
    saving: 'Saving…',
    saved: 'Model configuration saved',
    saveError: 'Could not save the model configuration.',
    history: 'Version history',
    historyEmpty: 'No versions yet — the organization runs on the platform defaults.',
    version: 'Version',
    activeBadge: 'Active',
    activate: 'Activate',
    activated: 'Version activated',
    activateError: 'Could not activate this version.',
    activateTitle: 'Activate for the whole organization?',
    activateDescription:
      'Makes {target} the production model for every member of your organization, effective immediately for new conversations. You can roll back to another version at any time.',
    activateConfirm: 'Activate now',
    defaultsTarget: 'the platform defaults',
    useDefaults: 'Deactivate overrides (use the platform defaults)',
    loadError: 'Could not load the model configuration.',
    byokCatalogHint:
      'Your organization key ({provider}) is active: the picker lists the models available to YOUR provider account, and all traffic is billed to it. Removing the key switches back to the platform catalog.',
    pickerLoadError: 'The model list could not be loaded.',
    saveErrorZdrUnavailable:
      'The zero-data-retention list could not be loaded, so the models could not be checked. Nothing was saved; try again shortly.',
    zdrTitle: 'Zero data retention',
    zdrHint:
      'On by default. Every request Piloti sends to an AI model through OpenRouter for your organization goes only to endpoints that store neither prompts nor responses: chat and research answers, clarifying questions, reading documents on upload (drawing captions, OCR, embeddings, summaries, classification), search reranking, conversation titles and summaries, consistency checks and skill reviews. If the setting cannot be read, requests are restricted anyway, and only models with such an endpoint can be chosen. EU-hosted endpoints are preferred where a model has one. Not covered: web search queries go to the web search provider (Tavily), which is not a model provider.',
    zdrNotApplicable:
      'Your organization’s own {provider} key is active, so requests go directly to that provider, not through OpenRouter. Retention for those requests is governed by your contract with {provider}; Piloti cannot enforce it. Your saved setting is kept and applies again once you switch back to the platform key or an OpenRouter key.',
    zdrEnabled: 'Zero data retention is on',
    zdrDisabled: 'Zero data retention is off',
    zdrError: 'Could not change zero data retention. Try again.',
    zdrErrorForbidden:
      'You cannot change zero data retention: it needs the “Manage AI models” permission, and model configuration must be enabled for your organization.',
    zdrDisableTitle: 'Turn off zero data retention?',
    zdrDisableDescription:
      'With zero data retention off, the model providers behind OpenRouter may store your organization’s prompts, uploaded documents, drawings and answers and, depending on the provider, use them to train their models. This applies to every member of your organization, from the next request on.',
    zdrDisableAcknowledge:
      'I understand that prompts, documents, drawings and answers of this organization may then be stored by model providers and used for training.',
    zdrDisableConfirm: 'Turn off zero data retention',
    zdrOffTitle: 'Zero data retention is off',
    zdrOffBody:
      'The model providers behind OpenRouter may store your organization’s prompts, documents, drawings and answers and, depending on the provider, use them for training. You can turn it back on above at any time, without confirmation.',
    zdrBlockedSummary:
      '{count, plural, one {# task cannot run under zero data retention with its current model} other {# tasks cannot run under zero data retention with their current models}}. See the marked rows below.',
    zdrBlockedNotZdr:
      '{model} ({source}) has no zero-data-retention endpoint. Requests for this task are refused until you choose a ZDR model here.',
    zdrBlockedCapability:
      '{model} ({source}) has zero-data-retention endpoints, but none supports what this task needs. Requests for this task are refused until you choose a different model here.',
    zdrSource: {
      org: 'your choice',
      platform: 'platform default',
      workflow: 'workflow configuration',
    },
    zdrCoverageUnknown:
      'The zero-data-retention list could not be loaded, so it is unknown whether each task’s model has a ZDR endpoint. Requests stay restricted to ZDR endpoints; any without one are refused.',
    zdrUnresolved:
      'The default model for this task could not be determined, so whether it has a zero-data-retention endpoint is unknown.',
    zdrListUnavailable:
      'The zero-data-retention list could not be loaded, so no model can be offered right now. Try again shortly.',
    noZdrResults: 'No model with a zero-data-retention endpoint matches.',
    noZdrMark: 'No zero-data-retention endpoint',
    /** Why a model was refused for a task (`ModelRejectionCode`, lib/model-config/rejections.ts). */
    rejection: {
      unknown_group: 'This task no longer exists.',
      not_in_catalog: '{model} is not in the model catalog.',
      not_zdr: '{model} has no zero-data-retention endpoint.',
      zdr_endpoint_lacks_capability: 'No zero-data-retention endpoint of {model} supports what this task needs.',
      no_text_input: 'The model does not accept text input.',
      no_image_input: 'The model does not accept images; this task needs a vision model.',
      context_too_small: 'Its context window ({actual} tokens) is below the required {required}.',
      missing_parameter: 'The model does not support “{parameter}”, which this task needs.',
      reasoning_mandatory: 'The model always reasons, and this task runs with reasoning off.',
    },
  },
  byok: {
    title: 'LLM API key (BYOK)',
    description:
      'Bring your own LLM provider key: research traffic is billed to your provider account and the key is envelope-encrypted per organization in WorkOS Vault. Keys are verified live before activation; rotation and revocation are audited.',
    loading: 'Loading credentials…',
    loadError: 'Could not load the LLM credentials.',
    noCredential: 'No organization key connected — Piloti uses the platform key.',
    storageVaultNote: 'New keys are stored encrypted in WorkOS Vault under your organization’s key context.',
    storageLocalNote: 'New keys are stored encrypted with this deployment’s local key.',
    activeBadge: 'Active',
    standbyBadge: 'Stored, not in use',
    modeTitle: 'Use your own key',
    modeByokHint:
      'Research traffic runs on your key and is billed to your provider account. The model picker lists your provider’s models.',
    modePlatformHint:
      'Research traffic runs on the Piloti platform service. Your key stays stored securely and can be re-enabled anytime.',
    modeByokSet: 'Switched to your own key — new conversations use it within a minute.',
    modePlatformSet: 'Switched to the Piloti platform service — your key is kept but not used.',
    modeError: 'Could not change the provider mode.',
    keyLabel: 'Key',
    storageLabel: 'Storage',
    storageVault: 'WorkOS Vault (per-org encryption)',
    storageLocal: 'Local encrypted store',
    baseUrl: 'Base URL',
    baseUrlHint: 'HTTPS endpoint of an OpenAI-compatible API (e.g. your Azure OpenAI resource or gateway).',
    lastVerified: 'Last verified',
    lastUsed: 'Last used',
    connectTitle: 'Connect an organization key',
    rotateTitle: 'Rotate the key',
    provider: 'Provider',
    providers: {
      openrouter: 'OpenRouter',
      openai: 'OpenAI',
      'azure-openai': 'Azure OpenAI',
      custom: 'Custom (OpenAI-compatible)',
    },
    label: 'Label',
    labelPlaceholder: 'e.g. Corporate OpenRouter account',
    apiKey: 'API key',
    apiKeyPlaceholder: 'sk-…',
    apiKeyHint: 'Verified against the provider before it is stored. Never shown again after saving.',
    connect: 'Verify & connect',
    rotate: 'Verify & rotate',
    saving: 'Verifying…',
    connected: 'Organization key connected — new conversations use it immediately.',
    rotated: 'Key rotated — the previous key was revoked.',
    saveError: 'Could not save the key.',
    verify: 'Verify',
    verified: 'Key verified — {count, plural, one {# model} other {# models}} visible.',
    verifyError: 'Verification failed.',
    revoke: 'Revoke',
    revokeConfirm:
      'Revoke the organization key? Research traffic falls back to the platform key within a minute.',
    revoked: 'Key revoked — the platform key is used again.',
    revokeError: 'Could not revoke the key.',
    history: 'Key history',
    revokedOn: 'created {date}',
  },
  /** Storage: bytes stored against the quota that stops new uploads. */
  storage: {
    title: 'Document storage',
    description:
      'Every uploaded document is kept so it can be re-read, re-embedded and audited. The quota is what stops one organization filling the shared disk.',
    used: 'Used',
    ofQuota: '{used} of {quota}',
    noQuota: '{used} stored (no quota set)',
    overQuota: 'Quota reached — new uploads are refused until space is freed',
    nearQuota: 'Almost full — new uploads will soon be refused',
    projectDocuments: 'Project documents',
    archivDocuments: 'Organization Archiv',
    /** Count-neutral: a scope with exactly one document renders this too. */
    documentCount: 'Documents: {count}',
    /** The per-file upload limit, read-only; `size` is formatted with its unit. */
    maxFileSize: 'Largest file per upload',
    setByPlatform:
      'Your storage quota and the largest file you can upload are set by Piloti. Contact support if you need more.',
    loadError: 'Could not load storage usage.',
  },
  budgets: {
    title: 'Usage & budgets',
    description:
      'Usage per model against your organization limits. Every request is metered as it runs; limits are enforced before every request.',
    memberTitle: 'Your usage',
    memberDescription:
      'Your own usage against your organization limits. If a budget is exhausted, chat is paused until an admin raises the limit.',
    today: 'Today',
    thisMonth: 'This month',
    ofLimit: '{spent} of {limit}',
    noLimit: '{spent} (no limit)',
    creditsValue: '{value} credits',
    tokensValue: '{value} tokens',
    unitCredits: 'credits',
    unitTokens: 'tokens',
    ownKeyNote:
      'Your organization runs on its own provider key. Usage is counted in tokens on your own bill, and Piloti charges no credits for it.',
    overLimit: 'Budget exhausted — new requests are blocked',
    legendTitle: 'Usage by model',
    legendEmpty: 'No LLM usage recorded in this window yet.',
    trendTitle: 'Last 30 days',
    trendEmpty: 'No usage recorded in the last 30 days.',
    otherModels: 'Other models',
    tooltipRequests: '{count, plural, one {# request} other {# requests}}',
    limitsTitle: 'Organization limits',
    limitsDescription:
      'Your plan’s allowance applies until you set your own limits. Limits are in credits and are enforced before every request.',
    limitsDescriptionTokens:
      'There is no limit until you set one. Limits are in tokens on your own key and are enforced before every request.',
    dailyLimit: 'Daily limit ({unit})',
    monthlyLimit: 'Monthly limit ({unit})',
    noLimitPlaceholder: 'No limit',
    limitInvalid: 'Enter a number of 0 or more, or leave blank for no limit.',
    saveLimits: 'Save limits',
    limitsSaved: 'Budget limits saved',
    limitsSaveError: 'Could not save the budget limits.',
    membersTitle: 'Members — usage & limits',
    membersDescription:
      'Usage per member with their optional individual caps. A member limit never exceeds the organization limits and is enforced in addition to them.',
    colMember: 'Member',
    limitLabel: 'Limit',
    setLimit: 'Set limit',
    noUsageYet: 'no usage yet',
    scopedTitle: 'Project limits',
    scopedDescription:
      'Optional caps per project, settable by project admins and org admins. A project limit must not exceed the organization limits and is enforced in addition to them.',
    scopeMember: 'Member',
    scopeProject: 'Project',
    subjectMemberPlaceholder: 'WorkOS user id (user_…)',
    subjectProjectPlaceholder: 'Project id (uuid)',
    addPolicy: 'Set limit',
    policySaved: 'Limit saved',
    policySaveError: 'Could not save this limit.',
    activePolicies: 'Active scoped limits',
    noPolicies: 'No member or project limits set.',
    selectMember: 'Select a member…',
    selectProject: 'Select a project…',
    subjectGone: 'no longer available',
    removePolicy: 'Remove',
    policyRemoved: 'Limit removed — organization limits apply again.',
    policyRemoveError: 'Could not remove this limit.',
    perDay: 'day',
    perMonth: 'month',
    loadError: 'Could not load usage data.',
  },
  audit: {
    title: 'Audit logs',
    description:
      'Every privileged change — budgets, model configuration, settings, legal holds — is recorded in your organization’s WorkOS audit trail. The viewer opens in a new tab and can export events.',
    open: 'View audit logs',
    error: 'Could not open the audit log viewer.',
  },
  /** Sensitive data: the lists Piloti checks every upload against (ADR-0086). */
  screening: {
    title: 'Screening list',
    description:
      'Piloti checks every upload against these lists, and chat messages against the content terms and numbers. No model reads what matches.',
    enabled: 'Screen uploads and chat',
    enabledHint: 'When off, Piloti checks nothing. Your lists stay saved.',
    suggestedTitle: 'Piloti’s suggestion applies',
    suggestedBody:
      'Your office has not saved its own list yet. Until it does, Piloti checks with this one. Once you save, yours applies.',
    namesTitle: 'Before upload: file and folder names',
    namesHint:
      'The browser checks names before it sends anything. A matching file is not sent unless the person uploading releases it on its own.',
    nameTerms: 'Name terms',
    nameTermsHint: 'Matches inside words too: “Rechnung” finds “Schlussrechnung”.',
    nameExceptions: 'Exceptions',
    nameExceptionsHint: 'Words that contain a term but mean something else: “Berechnung” contains “Rechnung”.',
    contentTitle: 'After upload: content',
    contentHint:
      'Piloti reads the text on its own server and checks it before any model sees it. Matches wait in quarantine until someone releases or deletes them. The same terms and numbers apply to chat messages: before sending, Piloti shows what it found and sends the message to the answering model only masked. A dictated message is first heard by an external speech model, which transcribes it.',
    contentTerms: 'Content terms',
    contentTermsHint: 'Matches words that start with the term: “Honorar” finds “Honorarnote”.',
    detectors: 'Detect numbers',
    detectorsHint: 'Piloti recomputes the check digit. A number that only looks right does not match.',
    detector: {
      iban: 'IBAN',
      at_svnr: 'Social security number (AT)',
      credit_card: 'Credit card number',
    },
    limits:
      'The check sees words and numbers, not meaning. A fee agreement that contains none of your terms gets through. Piloti checks scanned pages and images without a text layer by name only.',
    termPlaceholder: 'Type a term, press Enter',
    removeTerm: 'Remove “{term}”',
    emptyList: 'No terms',
    useSuggestion: 'Use suggestion',
    saved: 'List saved. It applies from the next upload, and in chat once the page is reloaded at the latest.',
    saveError: 'Could not save the list. Please try again.',
    saveForbidden: 'You cannot change this list. That needs the “Manage organization settings” permission.',
    invalid: 'A term is too long. A term has at most 80 characters.',
    readOnly: 'Only people with the “Manage organization settings” permission can change these lists.',
    loadError: 'Could not load the lists.',
  },
  /** Quarantine: files the content check held back (ADR-0086). */
  quarantine: {
    listLabel: 'Files held back',
    empty: 'Nothing is waiting for review',
    emptyHint: 'When the content check holds a file back, it appears here. You see the files you may release.',
    whereProject: 'Project {name}',
    whereProjectUnknown: 'A project',
    whereArchiv: 'Archiv',
    whereSession: 'Chat attachment',
    reasonsLabel: 'Reasons',
    noReason: 'Reason could not be read',
    release: 'Release',
    releaseTitle: 'Release “{name}”?',
    releaseDescription:
      'Piloti then reads the file like any other upload: language models see its content, and search finds it. The release is logged under your name.',
    released: '“{name}” is released and being read.',
    releaseError: 'Could not release the file. Please try again.',
    changed: 'Someone already acted on this file. The list is up to date now.',
    delete: 'Delete',
    deleteTitle: 'Delete “{name}”?',
    deleteDescription: 'The file is removed from Piloti. This cannot be undone.',
    deleted: '“{name}” was deleted.',
    deleteError: 'Could not delete the file. Please try again.',
    deleteErrorSession: 'Only people in that chat can delete a chat attachment.',
    loadError: 'Could not load the quarantine.',
  },
}
