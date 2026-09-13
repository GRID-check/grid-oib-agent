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
  panel: {
    description:
      'An Piloti übergebene Arbeit — aus einem Chat, aus einer Freigabe oder aus einem Job nach Zeitplan. Wiederkehrende Zeitpläne stehen oben, jeder einzelne Lauf darunter.',
  },
  groups: {
    templates: 'Zeitpläne',
    templatesEmpty: 'Keine wiederkehrenden Zeitpläne. Ein Zeitplan lässt Piloti nach Timer arbeiten.',
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
    result: 'Ergebnis',
    openDocument: 'Dokument öffnen',
    continueChat: 'Im Chat fortsetzen',
    request: 'Auftrag',
    schedule: 'Zeitplan',
    prompt: 'Prompt',
    runs: 'Läufe',
    gone: 'Das gibt es nicht mehr — möglicherweise wurde es gelöscht.',
    goneTitle: 'Nicht gefunden',
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
