import type { en } from '../en'

/** Produkt-Feedback: das Formular in der App und Plattform → Feedback. */
export const feedback: typeof en.feedback = {
  open: 'Feedback senden',
  openHint: 'Fehler melden oder Idee teilen',
  dialog: {
    title: 'Sagen Sie uns Ihre Meinung',
    description:
      'Ihre Nachricht geht direkt an das Team, das Piloti baut. Jede Meldung wird gelesen.',
    kindLabel: 'Worum geht es?',
    messageLabel: 'Ihre Nachricht',
    counter: '{count} / {max}',
    tooShort: 'Bitte noch ein paar Worte mehr – mindestens {min} Zeichen.',
    context: {
      summary: 'Wird automatisch mitgeschickt',
      page: 'Seite',
      browser: 'Browser',
      screen: 'Bildschirm',
      locale: 'Sprache',
      timeZone: 'Zeitzone',
      none: '–',
    },
    allowContact: 'Sie dürfen mich dazu kontaktieren',
    allowContactHint: 'Wir antworten an {email}, wenn wir eine Rückfrage oder Neuigkeiten haben.',
    cancel: 'Abbrechen',
    send: 'Feedback senden',
    sending: 'Wird gesendet …',
    shortcut: 'zum Senden',
    error: 'Ihr Feedback konnte nicht gesendet werden. Bitte versuchen Sie es erneut.',
    rateLimited:
      'Sie haben in der letzten Stunde schon viel Feedback gesendet. Bitte versuchen Sie es später erneut.',
    success: {
      title: 'Vielen Dank!',
      body: 'Ihr Feedback ist beim Piloti-Team angekommen. Jede Meldung wird gelesen.',
      another: 'Weiteres senden',
      close: 'Schließen',
    },
  },
  kinds: {
    bug: {
      label: 'Fehler',
      hint: 'Etwas funktioniert nicht',
      placeholder: 'Was haben Sie gemacht, was ist passiert und was hätten Sie erwartet?',
    },
    idea: {
      label: 'Idee',
      hint: 'Etwas fehlt',
      placeholder: 'Was würde Ihnen die Arbeit erleichtern? Beschreiben Sie die Situation.',
    },
    praise: {
      label: 'Lob',
      hint: 'Etwas gefällt',
      placeholder: 'Was gefällt Ihnen? Wir hören es gern.',
    },
    question: {
      label: 'Frage',
      hint: 'Etwas ist unklar',
      placeholder: 'Was möchten Sie wissen?',
    },
  },
  statuses: {
    new: 'Neu',
    in_progress: 'In Arbeit',
    resolved: 'Erledigt',
    dismissed: 'Verworfen',
  },
  platform: {
    filters: {
      label: 'Nach Status filtern',
      all: 'Alle',
      kindLabel: 'Art',
      allKinds: 'Alle Arten',
    },
    empty: {
      title: 'Hier ist kein Feedback',
      description: 'Sobald ein Mitglied Feedback sendet, erscheint es hier und in Ihrem Postfach.',
    },
    loadError: 'Das Feedback konnte nicht geladen werden.',
    retry: 'Erneut versuchen',
    loadMore: 'Mehr laden',
    from: '{name} · {organization}',
    unknownReporter: 'Unbekanntes Mitglied',
    unknownOrganization: 'Unbekannte Organisation',
    onPage: 'auf {page}',
    contact: 'Per E-Mail antworten',
    noContact: 'Möchte nicht kontaktiert werden',
    statusLabel: 'Status',
    triagedBy: 'Gesichtet von {name}',
    triaged: 'Auf „{status}“ gesetzt.',
    triageError: 'Der Status konnte nicht geändert werden.',
    details: 'Browserdetails',
    listTitle: 'Meldungen',
    linked: 'Aus dem Postfach',
    focusMissing: {
      title: 'Die verlinkte Meldung wurde nicht gefunden.',
      description: 'Sie wurde gelöscht oder ist für Sie nicht sichtbar. Die übrigen Meldungen stehen unten.',
    },
  },
}
