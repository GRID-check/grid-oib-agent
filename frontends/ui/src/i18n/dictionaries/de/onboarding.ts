import type { en } from '../en'

/** onboarding namespace — populated during component i18n. */
export const onboarding: typeof en.onboarding = {
  validation: {
    nameRequired: 'Der Organisationsname ist erforderlich.',
  },
  steps: {
    createOrg: 'Ihre Organisation erstellen',
    makeAdmin: 'Sie zum Administrator des Arbeitsbereichs machen',
    openProject: 'Grid und Ihr erstes Projekt öffnen',
  },
  errors: {
    createFailed: 'Organisation konnte nicht erstellt werden.',
    generic: 'Etwas ist schiefgelaufen.',
    title: 'Organisationseinrichtung fehlgeschlagen',
  },
  intro: {
    eyebrow: 'erster Arbeitsbereich',
    title: 'Legen Sie Ihre Organisation fest, bevor Grid Projektdaten verarbeitet.',
    description:
      'Ihre Organisation ist die private Grenze für Ihre Bauprojekte — Dokumente, Mitglieder und OIB/RIS-Recherche liegen alle darin. Sie werden ihr Administrator.',
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
