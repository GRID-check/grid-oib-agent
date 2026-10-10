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
      'Diese Unterhaltung stützt sich auf einen Ordner mit eingeschränktem Zugriff oder auf ein anderes Projekt, deshalb lässt sich aus ihr keine Tiefenrecherche starten: Recherche, Titel und Bericht wären für alle im Projekt sichtbar, auch für Personen, die diesen Ordner oder dieses Projekt nicht lesen dürfen.',
    task: 'Diese Unterhaltung stützt sich auf einen Ordner mit eingeschränktem Zugriff oder auf ein anderes Projekt, deshalb lässt sich aus ihr kein Auftrag anlegen: Aufträge sind für alle im Projekt sichtbar, auch für Personen, die diesen Ordner oder dieses Projekt nicht lesen dürfen.',
    profilePatch:
      'Diese Unterhaltung stützt sich auf einen Ordner mit eingeschränktem Zugriff oder auf ein anderes Projekt, deshalb lässt sich aus ihr der Projektkontext nicht ändern: Er ist für alle im Projekt sichtbar, auch für Personen, die diesen Ordner oder dieses Projekt nicht lesen dürfen.',
    filing:
      'Diese Unterhaltung stützt sich auf einen Ordner mit eingeschränktem Zugriff oder auf ein anderes Projekt, deshalb lässt sich aus ihr nichts dorthin ablegen: Der Ablageort ist auch für Personen sichtbar, die den eingeschränkten Ordner oder das andere Projekt nicht lesen dürfen. Ablegen geht nur in einen Ordner, der mindestens so eng eingeschränkt ist, und nie für Inhalte aus anderen Projekten.',
    revision:
      'Dieses Dokument liegt in einem Ordner mit eingeschränktem Zugriff, deshalb kann Piloti es nicht überarbeiten: Der Auftrag dafür wäre für alle im Projekt sichtbar, auch für Personen, die für diesen Ordner nicht freigegeben sind. Fordern Sie die Änderungen ohne Piloti an.',
    planDocument:
      'Eine genannte Unterlage liegt in einem Ordner mit eingeschränktem Zugriff, deshalb lässt sie sich einer Recherche nicht als Unterlage mitgeben: Unterlagen und Bericht einer Recherche sind für alle im Projekt sichtbar, auch für Personen, die für diesen Ordner nicht freigegeben sind.',
  },
  crossProject: {
    audienceChanged:
      'Wer diese Unterhaltung lesen darf, hat sich gerade geändert, deshalb wurde in anderen Projekten nichts übernommen. Fragen Sie bitte noch einmal.',
    memory:
      'Diese Unterhaltung stützt sich auf laufende andere Projekte oder auf Ordner anderer Projekte mit eigener Zugriffsliste, deshalb wird nichts aus ihr im Projekt- oder Büro-Gedächtnis gespeichert: Dieses Gedächtnis lesen alle im Projekt, auch Personen, die jene Projekte oder Ordner nicht öffnen dürfen. Was aus den offenen Ordnern abgeschlossener Projekte stammt, darf gespeichert werden.',
  },
}
