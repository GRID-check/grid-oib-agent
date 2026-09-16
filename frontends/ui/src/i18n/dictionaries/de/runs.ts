import type { en } from '../en'

/**
 * Läufe — wie ein Lauf im Verlauf liest, der ihn beauftragt hat (der Laufblock).
 *
 * Das Ledger trägt ASCII-Schlüssel (`planen`, `laeuft`); hier stehen die Wörter
 * dafür und der Satz, den jeder Status dem Leser schuldet. Keine Kennung
 * erreicht den Leser, jede Phase ist ein Wort, jeder Status ein Wort und ein
 * Satz, und eine Zahl steht nur dort, wo sie ändert, was der Leser als Nächstes
 * tut.
 */
export const runs: typeof en.runs = {
  phase: {
    planen: 'Planen',
    recherchieren: 'Recherchieren',
    pruefen: 'Prüfen',
    schreiben: 'Schreiben',
    abgelegt: 'Abgelegt',
  },
  status: {
    angelegt: 'Wird gestartet',
    laeuft: 'Läuft',
    wartet: 'Wartet auf Sie',
    fertig: 'Fertig',
    fehlgeschlagen: 'Fehlgeschlagen',
    abgebrochen: 'Abgebrochen',
    unterbrochen: 'Unterbrochen',
  },
  sentence: {
    angelegt: 'Piloti übernimmt den Auftrag.',
    angelegtFiling:
      'Piloti übernimmt den Auftrag. Das Ergebnis wird im Projekt unter „Berichte“ abgelegt.',
    wartet: 'Piloti hat eine Rückfrage. Antworten Sie unten im Verlauf.',
    fertigFiled: 'Bericht abgelegt in Projekt › Berichte.',
    fertigInline: 'Der Bericht liegt hier im Verlauf.',
    fehlgeschlagen: 'Fehlgeschlagen: {reason}',
    abgebrochen: 'Auf Ihren Wunsch beendet.',
    unterbrochen: 'Die Recherche wurde abgebrochen; der Bericht ist aus dem Vorhandenen geschrieben.',
  },
  completedBefore: 'Bis dahin: {phases}',
  completedBeforeTallies: '{phase} ({rounds}, {docs})',
  step: {
    fallback: 'Recherche-Runde {n}',
    round: 'Runde {n}',
    repeat: 'bereits gelesen',
    openPoints: 'Offen:',
  },
  phaseLine: {
    planen: 'Rechercheplan erstellt',
    pruefen: 'Zitate gegen die Quellen geprüft',
    pruefenLive: 'Zitate werden gegen die Quellen geprüft',
    schreiben: 'Bericht geschrieben',
    schreibenLive: 'Bericht wird geschrieben',
  },
  tallies: {
    rounds: '{count, plural, one {# Runde} other {# Runden}}',
    docs: '{count, plural, one {# Dokument} other {# Dokumente}}',
  },
  summary: '{phase} · {rounds} · {docs}',
  action: {
    answer: 'Antworten',
    review: 'Prüfen',
    openReport: 'Bericht öffnen',
    openInProject: 'Im Projekt anzeigen',
    retry: 'Erneut starten',
    openInThread: 'Im Verlauf öffnen',
  },
  review: {
    accepted: 'Angenommen von {name}',
    acceptedAnon: 'Angenommen',
    rejected: 'Zurückgeschickt: {reason}',
    rejectedAnon: 'Zurückgeschickt',
  },
  rail: {
    label: 'Phasen',
    done: 'erledigt',
    active: 'läuft',
    pending: 'ausstehend',
  },
  block: {
    aria: 'Auftrag {title}: {status}',
    toggle: 'Verlauf des Auftrags ein- oder ausblenden',
    untitled: 'Auftrag',
    elapsedAria: 'Laufzeit {elapsed}',
  },
}
