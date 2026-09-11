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
      'An Piloti übergebene Arbeit — aus einem Chat, aus einer Freigabe oder aus einem Job nach Zeitplan.',
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
