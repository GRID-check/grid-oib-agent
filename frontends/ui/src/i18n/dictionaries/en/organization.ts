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
    webSearch: 'Web search',
    webSearchHint:
      'Allow agents to search the public web. When off, web-search tools disappear from the picker and are blocked server-side for every member.',
    save: 'Save changes',
    saving: 'Saving…',
    saved: 'Organization settings saved',
    saveError: 'Could not save organization settings. Please try again.',
    loadError: 'Could not load organization settings right now. Please refresh to try again.',
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
    zdrTitle: 'Zero data retention only',
    zdrHint:
      'Show only models with a zero-data-retention endpoint and route every request to one, so no prompt or response is stored by the provider. Applies to OpenRouter models.',
    zdrEnabled: 'Zero data retention enabled',
    zdrDisabled: 'Zero data retention disabled',
    zdrError: 'Could not change the zero-data-retention policy.',
    zdrDisableTitle: 'Turn off zero data retention?',
    zdrDisableDescription:
      'Requests may then be sent to endpoints without zero data retention, so the provider can store prompts and responses. This affects every member of your organization.',
    zdrDisableConfirm: 'Turn off',
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
    setByPlatform: 'Your storage quota is set by Piloti. Contact support if you need more room.',
    loadError: 'Could not load storage usage.',
  },
  budgets: {
    title: 'Usage & budgets',
    description:
      'LLM spend per model against your organization limits. Costs come from OpenRouter usage accounting; limits are enforced before every request.',
    memberTitle: 'Your usage',
    memberDescription:
      'Your own spend against your organization limits. If a budget is exhausted, chat is paused until an admin raises the limit.',
    today: 'Today',
    thisMonth: 'This month',
    ofLimit: '{spent} of {limit}',
    noLimit: '{spent} (no limit)',
    overLimit: 'Budget exhausted — new requests are blocked',
    legendTitle: 'Spend by model',
    legendEmpty: 'No LLM usage recorded in this window yet.',
    trendTitle: 'Last 30 days',
    trendEmpty: 'No usage recorded in the last 30 days.',
    otherModels: 'Other models',
    tooltipRequests: '{count, plural, one {# request} other {# requests}}',
    limitsTitle: 'Organization limits',
    limitsDescription:
      'Defaults are €10 per day and €100 per month until you set your own. EUR limits are compared against USD costs at a deployment-configured rate.',
    dailyLimit: 'Daily limit (EUR)',
    monthlyLimit: 'Monthly limit (EUR)',
    noLimitPlaceholder: 'No limit',
    saveLimits: 'Save limits',
    limitsSaved: 'Budget limits saved',
    limitsSaveError: 'Could not save the budget limits.',
    membersTitle: 'Members — usage & limits',
    membersDescription:
      'Spend per member with their optional individual caps. A member limit never exceeds the organization limits and is enforced in addition to them.',
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
}
