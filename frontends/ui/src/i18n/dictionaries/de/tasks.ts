import type { en } from '../en'

/**
 * Aufgaben — die delegierte Arbeit eines Projekts (ADR-0051).
 *
 * Eine Aufgabe ist Arbeit, die jemand an Piloti übergeben und dann losgelassen
 * hat: eine Übergabe im Chat, ein „Piloti überarbeiten lassen“ aus einer
 * Freigabe, oder ein Job nach Zeitplan. Die Wörter hier handeln von ARBEIT,
 * nicht von einem Lauf — „läuft“ und „fehlgeschlagen“ ist, was man über die
 * Sache fragt, um die man gebeten hat.
 */
export const tasks: typeof en.tasks = {
  groups: {
    templates: 'Zeitpläne',
    templatesEmpty: 'Noch keine Zeitpläne. Legen Sie einen an — Piloti arbeitet dann nach Timer.',
    templatesError: 'Die Zeitpläne konnten nicht geladen werden.',
    instances: 'Läufe',
  },
  cadence: {
    once: 'Einmalig',
  },
  create: {
    delegate: 'Delegieren',
    delegateHint: 'Übergeben wird im Chat: Bitten Sie Piloti, etwas zu übernehmen.',
    schedule: 'Neuer Zeitplan',
    back: 'Zurück zu den Aufgaben',
  },
  detail: {
    close: 'Details schließen',
    // Öffnet den Bearbeiter für diesen Zeitplan; der frühere Jobs-Tab hatte ihn.
    edit: 'Bearbeiten',
    result: 'Ergebnis',
    openDocument: 'Dokument öffnen',
    continueChat: 'Im Chat fortsetzen',
    request: 'Auftrag',
    schedule: 'Zeitplan',
    prompt: 'Prompt',
    runs: 'Läufe',
    gone: 'Das gibt es nicht mehr — möglicherweise wurde es gelöscht.',
    /**
     * Ein Deep Link, der in diesem Projekt auf keine Zeile passt — weder auf
     * einen Lauf noch auf einen Zeitplan. Der Link zeigt möglicherweise auf ein
     * anderes Projekt, oder der Eintrag wurde gelöscht, bevor diese Liste lud.
     * „Nicht hier" statt „weg": Die Detailansicht hat ihn nie gesehen, also
     * kann sie nicht behaupten, er sei gegangen.
     */
    goneUnresolved:
      'Das wurde hier nicht gefunden. Der Link zeigt möglicherweise auf ein anderes Projekt, oder der Eintrag wurde gelöscht.',
    goneTitle: 'Nicht gefunden',
    /** Die Überschrift, solange ein Deep Link noch geprüft wird — kein Befund. */
    loadingTitle: 'Wird geladen',
  },
  list: {
    emptyTitle: 'Noch nichts übergeben',
    emptyDescription:
      'Bitten Sie Piloti im Chat, etwas zu übernehmen, oder schicken Sie einen Entwurf zur Überarbeitung zurück — dann steht es hier.',
    errorTitle: 'Die Aufgaben konnten nicht geladen werden',
    errorDescription: 'Der Rest des Projekts ist davon nicht betroffen. Versuchen Sie es gleich noch einmal.',
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
    // Ein Start, dessen Übermittlung gebrochen ist — der sichtbare Fehler, den
    // die Zusammenführung nach Aufgaben bringt.
    error: 'Übermittlung fehlgeschlagen',
  },
  review: {
    accepted: 'Angenommen',
    rejected: 'Zurückgeschickt',
  },
  meta: {
    byOn: '{name} · {when}',
    on: '{when}',
    document: 'Dokument',
    conversation: 'Chat',
  },
}
