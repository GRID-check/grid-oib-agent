/** The platform owner's cross-organization dashboard (ADR-0016). */
export const platform = {
  title: 'Platform',
  subtitle: 'Cross-organization overview for the platform owner.',
  loadError: 'Could not load the platform overview.',
  stats: {
    organizations: 'Organizations',
    projects: 'Projects',
    spendToday: 'Spend today',
    spendMonth: 'Spend this month',
    requestsMonth: '{count} requests this month',
  },
  orgs: {
    title: 'Organizations',
    description: 'Every organization on the platform, biggest spender first. Costs come from the LLM usage ledger.',
    colOrganization: 'Organization',
    colProjects: 'Projects',
    colToday: 'Today',
    colMonth: 'This month',
    colCreated: 'Created',
    platformBadge: 'Platform',
    empty: 'No organizations yet.',
  },
  trend: {
    title: 'Spend trend',
    description: 'Platform-wide LLM spend per day over the last 30 days (UTC), from the usage ledger.',
    requests: '{count} requests',
    empty: 'No usage recorded in the last 30 days.',
  },
  team: {
    title: 'Platform team',
    description: 'Members of the GRID Platform organization. Roles here grant platform-wide access — invite with care.',
    auditLogs: 'Audit logs',
    auditError: 'Could not open the audit log viewer.',
  },
  notOwner: {
    title: 'Platform access required',
    description: 'This dashboard is exclusive to the platform owner.',
  },
}
