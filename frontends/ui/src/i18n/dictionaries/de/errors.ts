import type { en } from '../en'

/** Error, not-found, and auth-error surfaces. */
export const errors: typeof en.errors = {
  notFound: {
    code: '404',
    title: 'Das konnten wir nicht finden',
    description:
      'Die gesuchte Seite oder das gesuchte Projekt existiert nicht, oder Sie haben keinen Zugriff mehr darauf.',
    action: 'Zurück zu den Projekten',
  },
  appError: {
    code: 'Fehler',
    title: 'Etwas ist schiefgelaufen',
    description:
      'Ein unerwarteter Fehler ist aufgetreten. Sie können es erneut versuchen oder zu Ihren Projekten zurückkehren.',
    action: 'Erneut versuchen',
    backAction: 'Zurück zu den Projekten',
  },
  access: {
    code: 'Zugriff',
    title: 'Sie haben keinen Zugriff darauf',
    description:
      'Dieses Projekt wurde möglicherweise verschoben, oder Ihr Zugriff wurde geändert. Wenden Sie sich an einen Projekt-Administrator, wenn Sie glauben, dass dies ein Fehler ist.',
    action: 'Zur Startseite',
  },
  auth: {
    title: 'Authentifizierungsfehler',
    heading: 'Authentifizierungsfehler',
    description: 'Wir konnten Sie nicht anmelden. Bitte versuchen Sie es erneut.',
    action: 'Zurück zur Startseite',
    tryAgain: 'Erneut versuchen',
    goHome: 'Zur Startseite',
    redirecting: 'Weiterleitung…',
    loading: 'Wird geladen',
    messages: {
      Configuration: 'Es liegt ein Problem mit der Serverkonfiguration vor.',
      AccessDenied: 'Sie haben keine Berechtigung, auf diese Ressource zuzugreifen.',
      Verification: 'Der Bestätigungslink ist abgelaufen oder wurde bereits verwendet.',
      Default: 'Bei der Authentifizierung ist ein Fehler aufgetreten.',
    },
  },
  confinement: {
    deepResearch:
      'Diese Unterhaltung stützt sich auf einen Ordner mit eingeschränktem Zugriff, deshalb lässt sich aus ihr keine Tiefenrecherche starten: Recherche, Titel und Bericht wären für alle im Projekt sichtbar, auch für Personen, die für diesen Ordner nicht freigegeben sind.',
    task: 'Diese Unterhaltung stützt sich auf einen Ordner mit eingeschränktem Zugriff, deshalb lässt sich aus ihr kein Auftrag anlegen: Aufträge sind für alle im Projekt sichtbar, auch für Personen, die für diesen Ordner nicht freigegeben sind.',
    profilePatch:
      'Diese Unterhaltung stützt sich auf einen Ordner mit eingeschränktem Zugriff, deshalb lässt sich aus ihr der Projektkontext nicht ändern: Er ist für alle im Projekt sichtbar, auch für Personen, die für diesen Ordner nicht freigegeben sind.',
    filing:
      'Diese Unterhaltung stützt sich auf einen Ordner mit eingeschränktem Zugriff, deshalb lässt sich aus ihr nichts dorthin ablegen: Der Ablageort ist auch für Personen sichtbar, die für den eingeschränkten Ordner nicht freigegeben sind. Ablegen geht nur in einen Ordner, der mindestens so eng eingeschränkt ist.',
    planDocument:
      'Eine genannte Unterlage liegt in einem Ordner mit eingeschränktem Zugriff, deshalb lässt sie sich einer Recherche nicht als Unterlage mitgeben: Unterlagen und Bericht einer Recherche sind für alle im Projekt sichtbar, auch für Personen, die für diesen Ordner nicht freigegeben sind.',
  },
}
