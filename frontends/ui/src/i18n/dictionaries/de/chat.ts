import type { en } from '../en'

/** chat namespace — populated during component i18n. */
export const chat: typeof en.chat = {
  actions: {
    dismiss: 'Schließen',
  },
  agentPrompt: {
    needsInput: 'Der Agent benötigt Ihre Eingabe',
    receivedInput: 'Der Agent hat Ihre Eingabe erhalten',
    approve: 'Genehmigen',
    reject: 'Ablehnen',
    approvePlan: 'Plan genehmigen',
    rejectPlan: 'Plan ablehnen',
    yourResponse: 'Ihre Antwort:',
  },
  agentResponse: {
    viewProgress: 'Fortschritt anzeigen',
    viewReport: 'Bericht anzeigen',
    loading: 'Wird geladen …',
    loadingLabel: 'Wird geladen',
    errorTitle: 'Fehler: {message}',
  },
  thinking: {
    inProgress: 'Denkvorgang läuft',
    working: 'Antwort wird erstellt …',
    waiting: 'Warten auf Antwort',
    interrupted: 'Unterbrochen',
    done: 'Fertig',
    showThinking: 'Denkschritte anzeigen ({count})',
    showThinkingSteps: 'Denkschritte anzeigen ({count})',
    stepsLabel: 'Denkschritte',
    selectedDataSources: 'Ausgewählte Datenquellen:',
    dataSource: {
      webSearch: 'Websuche',
      files: 'Dateien',
    },
  },
  deepResearch: {
    stats: {
      tokens: '{count} Tokens',
      toolCalls: '{count} Tool-Aufrufe',
    },
    success: {
      heading: 'Bericht abgeschlossen!{stats}',
      subheading:
        'Die Recherche ist abgeschlossen und ein Bericht steht im Recherche-Panel zur Ansicht bereit.',
    },
    failure: {
      heading: 'Bericht konnte nicht abgeschlossen werden',
      subheading:
        'Etwas hat den Abschluss des Rechercheberichts verhindert. Prüfen Sie die Denkschritte für Details.',
    },
    cancelled: {
      heading: 'Recherche abgebrochen',
      subheading:
        'Die Recherche wurde vom Benutzer gestoppt. Sie können den Teilfortschritt im Recherche-Panel ansehen.',
    },
    expired: {
      heading: 'Bericht abgelaufen',
      subheading: 'Der Bericht ist abgelaufen und nicht mehr verfügbar.',
    },
    starting: {
      heading: 'Deep Research wird gestartet',
      subheading:
        'Der Chat ist pausiert, während der Bericht erstellt wird, um zu verhindern, dass mehrere Berichte generiert werden. Sie können den Tab verlassen, während dies läuft – es kann mehrere Minuten dauern.',
    },
    viewReport: 'Bericht anzeigen',
    viewThinking: 'Denkschritte anzeigen',
    viewProgress: 'Fortschritt anzeigen',
  },
  error: {
    showDetails: 'Details anzeigen',
    hideDetails: 'Details ausblenden',
  },
  fileUpload: {
    uploading:
      'Die Datei wird hochgeladen und verarbeitet. Bis zum Abschluss kann eine Datei nicht in Abfragen einbezogen werden.',
    pendingWarning:
      'Dateien stehen noch aus! Warten Sie, bis sie bereit sind, oder senden Sie Ihre Abfrage erneut, um OHNE diese Dateien fortzufahren.',
  },
  noSources: {
    warning:
      'Keine Datenquellen ausgewählt und keine Dateien verfügbar. Antworten sind eher ungenau oder veraltet, sofern keine externen Datenquellen hinzugefügt werden.',
  },
  memory: {
    noted: 'Grid hat sich gemerkt',
    notedAria: 'Grid hat sich {count} Notizen gemerkt',
    addedToMemory: 'In das Projektgedächtnis aufgenommen',
    manageHint: 'Diese Einträge können Sie im Projektgedächtnis verwalten und löschen.',
    kinds: {
      decision: 'Entscheidung',
      constraint: 'Vorgabe',
      open_question: 'Offene Frage',
      derived_fact: 'Fakt',
      preference: 'Präferenz',
    },
    provenance: {
      distillation: 'nach der Antwort ergänzt',
      inTurn: 'während der Antwort notiert',
    },
  },
}
