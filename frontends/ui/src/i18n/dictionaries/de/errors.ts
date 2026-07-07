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
}
