import type { en } from '../en'

/** The organization management page (admin). */
export const organization: typeof en.organization = {
  title: 'Organisation',
  subtitle: 'Verwalten Sie Ihre Organisation, ihre Mitglieder und Zugriffe.',
  backToApp: 'Zurück zu den Projekten',
  overview: {
    title: 'Übersicht',
    description: 'Ihre Organisation auf einen Blick.',
    name: 'Name',
    id: 'Organisations-ID',
    domains: 'Domains',
    noDomains: 'Keine verifizierten Domains',
    created: 'Erstellt',
    members: 'Mitglieder',
    membersCapped: '{count}+',
    pendingInvites: 'Ausstehende Einladungen',
  },
  settings: {
    title: 'Organisationseinstellungen',
    description: 'Grid-spezifische Einstellungen für Ihre Organisation.',
    displayName: 'Anzeigename',
    displayNameHint: 'Wird innerhalb von Grid angezeigt. Leer lassen, um den WorkOS-Organisationsnamen zu verwenden.',
    displayNamePlaceholder: 'z. B. Acme Architektur GmbH',
    defaultLocale: 'Standardsprache für neue Mitglieder',
    defaultLocaleHint: 'Neue Mitglieder starten in dieser Sprache, bis sie ihre eigene wählen.',
    save: 'Änderungen speichern',
    saving: 'Wird gespeichert…',
    saved: 'Organisationseinstellungen gespeichert',
    saveError: 'Die Organisationseinstellungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
  },
  members: {
    title: 'Mitglieder',
    description: 'Laden Sie Personen ein, weisen Sie Rollen zu und verwalten Sie den Zugriff.',
  },
  advanced: {
    title: 'Erweitert',
    description: 'Enterprise-Zugriffssteuerung. Es werden nur Optionen angezeigt, die Ihre Rolle verwalten kann.',
    sso: 'Single Sign-On (SSO)',
    ssoDescription: 'Verbinden Sie einen Identitätsanbieter, damit sich Mitglieder über Ihren IdP anmelden.',
    directory: 'Directory Sync (SCIM)',
    directoryDescription: 'Mitglieder automatisch aus Ihrem Verzeichnis bereitstellen und entfernen.',
    domains: 'Domain-Verifizierung',
    domainsDescription: 'Verifizieren Sie Domains, die Ihrer Organisation gehören.',
  },
  notAdmin: {
    title: 'Sie benötigen Administratorrechte',
    description:
      'Nur Organisations-Administratoren können die Organisation verwalten. Wenden Sie sich an einen Administrator, wenn Sie Zugriff benötigen.',
  },
}
