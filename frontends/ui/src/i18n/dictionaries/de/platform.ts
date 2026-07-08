import type { en } from '../en'

/** Das plattformweite Dashboard des Plattform-Inhabers (ADR-0016). */
export const platform: typeof en.platform = {
  title: 'Plattform',
  subtitle: 'Organisationsübergreifende Übersicht für den Plattform-Inhaber.',
  loadError: 'Die Plattform-Übersicht konnte nicht geladen werden.',
  stats: {
    organizations: 'Organisationen',
    projects: 'Projekte',
    spendToday: 'Ausgaben heute',
    spendMonth: 'Ausgaben diesen Monat',
    requestsMonth: '{count} Anfragen diesen Monat',
  },
  orgs: {
    title: 'Organisationen',
    description: 'Alle Organisationen der Plattform, größte Ausgaben zuerst. Kosten stammen aus dem LLM-Nutzungsregister.',
    colOrganization: 'Organisation',
    colProjects: 'Projekte',
    colToday: 'Heute',
    colMonth: 'Dieser Monat',
    colCreated: 'Erstellt',
    platformBadge: 'Plattform',
    empty: 'Noch keine Organisationen.',
  },
  trend: {
    title: 'Ausgabenverlauf',
    description: 'Plattformweite LLM-Ausgaben pro Tag der letzten 30 Tage (UTC), aus dem Nutzungsregister.',
    requests: '{count} Anfragen',
    empty: 'In den letzten 30 Tagen wurde keine Nutzung erfasst.',
  },
  team: {
    title: 'Plattform-Team',
    description: 'Mitglieder der GRID-Platform-Organisation. Rollen hier gewähren plattformweiten Zugriff — mit Bedacht einladen.',
    auditLogs: 'Audit-Logs',
    auditError: 'Der Audit-Log-Viewer konnte nicht geöffnet werden.',
  },
  notOwner: {
    title: 'Plattform-Zugriff erforderlich',
    description: 'Dieses Dashboard ist exklusiv für den Plattform-Inhaber.',
  },
}
