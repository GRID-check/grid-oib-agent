import type { en } from '../en'

/** The profile / account settings page. */
export const profile: typeof en.profile = {
  title: 'Profil',
  subtitle: 'Verwalten Sie Ihr Konto, das Erscheinungsbild und Ihre Spracheinstellungen.',
  backToApp: 'Zurück zu den Projekten',
  savedToast: 'Einstellungen gespeichert',
  saveError: 'Ihre Einstellungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
  account: {
    title: 'Konto',
    description: 'Ihre Identität innerhalb von Grid.',
    name: 'Name',
    email: 'E-Mail',
    organization: 'Organisation',
    role: 'Rolle',
    noName: 'Nicht festgelegt',
    noOrganization: 'Keine Organisation',
  },
  appearance: {
    title: 'Erscheinungsbild',
    description: 'Wählen Sie, wie Grid aussieht. „System“ folgt der Einstellung Ihres Geräts.',
    theme: 'Design',
  },
  language: {
    title: 'Sprache',
    description: 'Die in der Grid-Oberfläche verwendete Sprache.',
    label: 'Sprache der Oberfläche',
  },
  security: {
    title: 'Sicherheit & Sitzungen',
    description: 'Wo Sie angemeldet sind und wie Ihr Konto geschützt ist.',
    currentSession: 'Aktuelle Sitzung',
    signedInAs: 'Angemeldet als {email}',
    thisDevice: 'Dieses Gerät',
    signOutEverywhere: 'Abmelden',
    managedByWorkos: 'Sitzungen und Sicherheitsfaktoren werden von WorkOS verwaltet.',
    unavailable: 'Sitzungsdetails sind nicht verfügbar, während die Authentifizierung deaktiviert ist.',
  },
}
