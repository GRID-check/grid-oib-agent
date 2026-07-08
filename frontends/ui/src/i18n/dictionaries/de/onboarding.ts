import type { en } from '../en'

/** onboarding namespace — populated during component i18n. */
export const onboarding: typeof en.onboarding = {
  validation: {
    nameRequired: 'Der Organisationsname ist erforderlich.',
    nameTooLong: 'Der Organisationsname darf höchstens 100 Zeichen lang sein.',
  },
  steps: {
    createOrg: 'Ihre Organisation erstellen',
    makeAdmin: 'Sie zum Administrator des Arbeitsbereichs machen',
    openProject: 'Grid und Ihr erstes Projekt öffnen',
  },
  inviteOnly: {
    title: 'Diese Plattform ist nur auf Einladung zug\u00e4nglich',
    description:
      'Neue Organisationen werden vom Plattform-Team angelegt. Bitten Sie den Administrator Ihrer Organisation um eine Einladung \u2014 danach landen Sie direkt im gemeinsamen Arbeitsbereich.',
  },
  errors: {
    createFailed: 'Organisation konnte nicht erstellt werden.',
    selfServeDisabled: 'Das Erstellen neuer Organisationen ist auf dieser Plattform deaktiviert. Bitten Sie Ihren Administrator um eine Einladung.',
    generic: 'Etwas ist schiefgelaufen.',
    title: 'Organisationseinrichtung fehlgeschlagen',
  },
  intro: {
    eyebrow: 'erster Arbeitsbereich',
    title: 'Legen Sie Ihre Organisation fest, bevor Grid Projektdaten verarbeitet.',
    description:
      'Ihre Organisation ist die private Grenze für Ihre Bauprojekte — Dokumente, Mitglieder und OIB/RIS-Recherche liegen alle darin. Sie werden ihr Administrator.',
    invitedHint:
      'Sie möchten einer bestehenden Organisation beitreten? Bitten Sie deren Administrator um eine Einladung — eingeladene Mitglieder sehen diesen Schritt nie.',
  },
  features: {
    privateTenant: 'Privater Mandant',
    adminAccess: 'Administratorzugriff',
    projectsReady: 'Projekte bereit',
  },
  success: {
    eyebrow: 'Arbeitsbereich bereit',
    title: 'Alles bereit',
    description: 'Ihre Organisation ist erstellt und Sie sind der Administrator.',
    redirecting: 'Sie werden zu Ihren Projekten weitergeleitet…',
  },
  form: {
    eyebrow: 'Organisationseinrichtung',
    title: 'Benennen Sie Ihre Organisation',
    description: 'Verwenden Sie den Namen Ihres Büros, Ihrer Praxis oder Ihrer Kundenorganisation.',
    nameLabel: 'Organisationsname',
    namePlaceholder: 'Grid Bauphysik Wien',
    submit: 'Organisation erstellen',
  },
}
