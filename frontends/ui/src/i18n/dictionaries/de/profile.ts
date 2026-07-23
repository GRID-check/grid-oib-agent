import type { en } from '../en'

/** The profile / account settings page. */
export const profile: typeof en.profile = {
  title: 'Profil',
  subtitle: 'Verwalten Sie Ihr Konto, das Erscheinungsbild und Ihre Spracheinstellungen.',
  loading: 'Profil wird geladen…',
  backToApp: 'Zurück zu den Projekten',
  savedToast: 'Einstellungen gespeichert',
  saveError: 'Ihre Einstellungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
  account: {
    title: 'Konto',
    description: 'Ihre Identität innerhalb von Piloti.',
    name: 'Name',
    email: 'E-Mail',
    organization: 'Organisation',
    role: 'Rolle',
    noName: 'Nicht festgelegt',
    noOrganization: 'Keine Organisation',
    roles: {
      'org-platform-owner': 'Plattform-Inhaber',
      admin: 'Administrator',
      member: 'Mitglied',
    },
  },
  appearance: {
    title: 'Erscheinungsbild',
    description: 'Wählen Sie, wie Piloti aussieht. „System“ folgt der Einstellung Ihres Geräts.',
    theme: 'Design',
  },
  language: {
    title: 'Sprache',
    description: 'Die in der Piloti-Oberfläche verwendete Sprache.',
    label: 'Sprache der Oberfläche',
  },
  reasoning: {
    title: 'Herleitung',
    description: 'Wie viel von Pilotis Denkweg in der Antwort gezeigt wird.',
    label: 'Technische Herleitung anzeigen',
    hint: 'Zeigt die einzelnen technischen Schritte (welcher Agent bzw. welches Werkzeug lief). Standardmäßig aus — normal siehst du die verständliche Herleitung.',
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
    activeSessions: 'Aktive Sitzungen',
    activeSessionsDescription: 'Geräte und Browser, die derzeit bei Ihrem Konto angemeldet sind. Melden Sie alle ab, die Sie nicht kennen.',
    securityFactors: 'Anmeldung & Sicherheit',
    securityFactorsDescription: 'Verwalten Sie Ihr Passwort und die Zwei-Faktor-Authentifizierung.',
    widgetError: 'Dieser Bereich konnte nicht geladen werden. Bitte laden Sie die Seite neu und versuchen Sie es erneut.',
  },
}
