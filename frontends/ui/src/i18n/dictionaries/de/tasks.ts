import type { en } from '../en'

/**
 * Tasks — die delegierte Arbeit eines Projekts (ADR-0051).
 *
 * Eine Aufgabe ist Arbeit, die jemand an Piloti übergeben und dann losgelassen
 * hat: eine Übergabe im Chat, ein „Piloti überarbeiten lassen“ aus einer
 * Freigabe, oder ein Zeitplan nach Timer. Die Wörter hier handeln von ARBEIT,
 * nicht von einem Lauf — deshalb heißen die Zeilen jetzt in beiden Sprachen
 * „Tasks“. „Läufe“ stand für genau dieselben Zeilen, und wer um etwas gebeten
 * hat, denkt über das Ergebnis nicht als Lauf von irgendetwas nach.
 */
export const tasks: typeof en.tasks = {
  cadence: {
    once: 'Einmalig',
  },
  create: {
    delegate: 'Delegieren',
    delegateHint: 'Übergeben wird im Chat: Bitten Sie Piloti, etwas zu übernehmen.',
    /** Die eine Erstell-Geste: eine Aufgabe, deren Assistent das WANN als einen seiner Schritte fragt. */
    task: 'Neue Aufgabe',
  },
  /** Liste und Zeitplan lesen dieselben Tasks — die Umschaltung ist eine Vorliebe, nie ein Ziel. */
  view: {
    label: 'Ansicht',
    list: 'Liste',
    timetable: 'Zeitplan',
  },
  /** Die stehenden Vereinbarungen hinter den Läufen — mit oder ohne Rhythmus. */
  standing: {
    heading: 'Stehende Aufgaben',
    emptyTitle: 'Noch keine stehenden Aufgaben',
    emptyDescription:
      'Legen Sie eine Aufgabe an — mit Rhythmus läuft sie von allein, ohne wartet sie auf Sie.',
  },
  filters: {
    label: 'Tasks filtern',
    all: 'Alle',
    active: 'Läuft',
    /** Fertig, und niemand hat gesagt, ob es taugt. Eine offene Schleife. */
    unreviewed: 'Ungeprüft',
    failed: 'Fehlgeschlagen',
    showAll: 'Alle Tasks zeigen',
  },
  buckets: {
    today: 'Heute',
    yesterday: 'Gestern',
    week: 'Diese Woche',
    earlier: 'Früher',
  },
  card: {
    openAria: '„{title}“ öffnen',
    unreviewed: 'Noch nicht geprüft',
  },
  result: {
    document: 'Dokument öffnen',
    conversation: 'Im Chat fortsetzen',
    report: 'Bericht öffnen',
    /** Ein Fehlschlag hat keinen Bericht; gefragt ist, was er versucht hat. */
    thinking: 'Gedankengang ansehen',
  },
  detail: {
    close: 'Details schließen',
    edit: 'Bearbeiten',
    result: 'Ergebnis',
    request: 'Auftrag',
    schedule: 'Zeitplan',
    prompt: 'Prompt',
    /** Die Läufe eines Zeitplans — jeder davon ein Task, also heißt es so. */
    runs: 'Tasks',
    /** Macht aus einem Einmaligen eine stehende Aufgabe, vorausgefüllt. */
    promote: 'Als stehende Aufgabe speichern',
    promoteHint: 'Öffnet den Aufgaben-Assistenten, dieser Auftrag ist schon eingetragen.',
    gone: 'Das gibt es nicht mehr — möglicherweise wurde es gelöscht.',
    /**
     * Ein Deep Link, der in diesem Projekt auf keine Zeile passt. Der Link zeigt
     * möglicherweise auf ein anderes Projekt, oder der Eintrag wurde gelöscht,
     * bevor diese Liste lud. „Nicht hier" statt „weg": Die Detailansicht hat ihn
     * nie gesehen, also kann sie nicht behaupten, er sei gegangen.
     */
    goneUnresolved:
      'Das wurde hier nicht gefunden. Der Link zeigt möglicherweise auf ein anderes Projekt, oder der Eintrag wurde gelöscht.',
    goneTitle: 'Nicht gefunden',
    /** Die Überschrift, solange ein Deep Link noch geprüft wird — kein Befund. */
    loadingTitle: 'Wird geladen',
    /** Solange der Ablauf des Laufs für den Block geladen wird. */
    runLoading: 'Der Ablauf wird geladen …',
    /** Die Abfrage wurde abgelehnt. Stattdessen stehen die Angaben der Zeile da. */
    runUnavailable: 'Der vollständige Ablauf dieses Laufs konnte nicht geladen werden.',
    /** In den Verlauf, neben dem Ergebnis — Lesen ist nicht Verfolgen. */
    openThread: 'Im Verlauf öffnen',
  },
  list: {
    emptyTitle: 'Noch nichts übergeben',
    emptyDescription:
      'Bitten Sie Piloti im Chat, etwas zu übernehmen, oder schicken Sie einen Entwurf zur Überarbeitung zurück — dann steht es hier.',
    emptyFiltered: {
      active: 'Gerade läuft nichts',
      unreviewed: 'Alles Fertige ist geprüft',
      failed: 'Nichts ist fehlgeschlagen',
    },
    errorTitle: 'Die Tasks konnten nicht geladen werden',
    errorDescription: 'Der Rest des Projekts ist davon nicht betroffen. Versuchen Sie es gleich noch einmal.',
    retry: 'Erneut versuchen',
  },
  kind: {
    'deep-research': 'Recherche',
    chat: 'Chat',
    compliance_check: 'Normprüfung',
    einreichcheck: 'Einreichcheck',
    document: 'Dokument',
    revision: 'Überarbeitung',
  },
  status: {
    queued: 'Eingereiht',
    running: 'Läuft',
    succeeded: 'Fertig',
    failed: 'Fehlgeschlagen',
    // Angehalten — von einem Menschen oder von einem Budget. Kein Fehler, dem
    // jemand nachgehen müsste.
    interrupted: 'Angehalten',
    // Ein Start, der den Agenten nie erreicht hat (Obergrenze, Feature aus).
    skipped: 'Übersprungen',
    // Ein Start, dessen Übermittlung gebrochen ist.
    error: 'Übermittlung fehlgeschlagen',
  },
  review: {
    accepted: 'Angenommen',
    rejected: 'Zurückgeschickt',
  },
  meta: {
    byOn: '{name} · {when}',
    on: '{when}',
  },
}
