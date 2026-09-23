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
  line: {
    filing: 'Ergebnis kommt ins Projekt',
    wartet: 'Antworten Sie unten im Verlauf',
    fertigFiled: 'Bericht abgelegt in Projekt › Berichte',
    fertigInline: 'Der Bericht liegt hier im Verlauf',
    fehlgeschlagen: 'Fehlgeschlagen: {reason}',
    abgebrochen: 'auf Ihren Wunsch beendet',
    unterbrochen: 'Bericht aus dem Vorhandenen geschrieben',
  },
  completedBefore: 'Bis dahin: {phases}',
  completedBeforeTallies: '{phase} ({rounds}, {docs})',
  step: {
    fallback: 'Recherche-Runde {n}',
    round: 'Runde {n}',
    repeat: 'bereits gelesen',
    openPoints: 'Offen:',
    findings: 'Bisher belegt',
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
    findings: '{count, plural, one {# Befund} other {# Befunde}}',
  },
  action: {
    answer: 'Antworten',
    review: 'Prüfen',
    openReport: 'Bericht öffnen',
    openInProject: 'Im Projekt anzeigen',
    retry: 'Erneut starten',
    openInThread: 'Im Verlauf öffnen',
    cancel: 'Abbrechen',
    writeNow: 'Jetzt schreiben',
    continue: 'Bericht fortschreiben',
  },
  plan: {
    heading: 'Rechercheplan',
    headingOwn: 'Ihr Rechercheplan',
    summary: '{genre} · {depth} · {count, plural, one {# Abschnitt} other {# Abschnitte}}',
    startsIn: 'Startet von selbst in {seconds} s. Sie können ihn vorher anpassen.',
    startsNow: 'Startet …',
    held: 'Wartet auf Sie. Die Recherche beginnt, wenn Sie sie starten.',
    approved: 'Freigegeben. Die Recherche beginnt gleich.',
    started: 'Die Recherche läuft nach diesem Plan.',
    adjust: 'Anpassen',
    startNow: 'Jetzt starten',
    start: 'Starten',
    dialogTitle: 'Recherche planen',
    dialogDescription:
      'Schreiben Sie die Frage und die Abschnitte, die der Bericht abdecken soll. Die Recherche beginnt, sobald Sie den Plan anlegen.',
    question: 'Frage',
    questionPlaceholder: 'Was soll die Recherche herausfinden?',
    create: 'Plan anlegen und starten',
    cancel: 'Abbrechen',
    createFailed: 'Der Plan konnte nicht angelegt werden. Bitte erneut versuchen.',
    openDialog: 'Recherche planen',
  },
  unterlagen: {
    receiptLabel: 'Für diesen Auftrag benannte Unterlagen',
    receipt: '{read} von {total} benannten Unterlagen gelesen',
    unread: 'nicht gelesen',
    open: '{name} öffnen',
    addAction: 'Unterlage hinzufügen',
    addTitle: 'Unterlage hinzufügen',
    addDescription:
      'Piloti liest sie in der nächsten Recherche-Runde vollständig und führt sie bei den übrigen benannten Unterlagen.',
    pickTitle: 'Unterlagen wählen',
    pickDescription:
      '„Lesen" heißt vollständig lesen, was immer die Recherche sonst findet. „Ausschließen" heißt nie verwenden, auch nicht, wenn eine Suche sie liefert.',
    search: 'Unterlagen durchsuchen',
    searchPlaceholder: 'Nach Namen suchen …',
    list: 'Unterlagen',
    loading: 'Unterlagen werden geladen …',
    empty: 'Keine passenden Unterlagen.',
    read: 'Lesen',
    exclude: 'Ausschließen',
    markRead: 'Vollständig lesen: {name}',
    markExcluded: 'Ausschließen: {name}',
    add: 'Hinzufügen',
    addOne: '{name} hinzufügen',
    alreadyNamed: 'benannt',
    done: 'Fertig',
    shelf: { project: 'Projekt', archiv: 'Büroarchiv', session: 'Dieser Chat', base: 'Regelwerke' },
  },
  cancel: {
    confirmTitle: 'Auftrag abbrechen?',
    confirmBody:
      'Piloti hört dort auf, wo es gerade ist. Was bis dahin recherchiert wurde, bleibt im Block stehen; der Bericht wird nicht mehr geschrieben.',
    confirm: 'Auftrag abbrechen',
    keep: 'Weiterlaufen lassen',
  },
  review: {
    accepted: 'Angenommen von {name}',
    acceptedAnon: 'Angenommen',
    rejected: 'Zurückgeschickt: {reason}',
    rejectedAnon: 'Zurückgeschickt',
  },
  connection: {
    reconnecting:
      'Die Live-Ansicht hat die Verbindung verloren und verbindet neu. Der Auftrag läuft weiter.',
    lost: 'Die Live-Ansicht ist getrennt. Der Auftrag läuft weiter — zum Mitlesen neu laden.',
  },
  block: {
    aria: 'Auftrag {title}: {status}',
    toggle: 'Verlauf des Auftrags ein- oder ausblenden',
    untitled: 'Auftrag',
    elapsedAria: 'Laufzeit {elapsed}',
  },
}
