import type { en } from '../en'

/** Präsenz: der Verbindungspunkt der Shell, und für wen Piloti auf einer gemeinsamen Fläche da ist. */
export const presence: typeof en.presence = {
  status: {
    connected: 'Verbunden',
    reconnecting: 'Verbindung wird wiederhergestellt',
    offline: 'Offline',
  },
  tooltip: {
    connected: 'Sie sind verbunden. Alles ist auf dem aktuellen Stand.',
    reconnecting: 'Verbindung unterbrochen – erneuter Verbindungsversuch läuft…',
    offline: 'Sie sind offline. Bitte überprüfen Sie Ihre Netzwerkverbindung.',
  },
  /**
   * Whose request Piloti is working on, wherever it is present (ADR-0105; EU AI
   * Act Art. 50). `{name}` is the person it acts for.
   */
  piloti: {
    /** The tooltip on Piloti's face in a presence stack. */
    onBehalfOf: 'Piloti · für {name}',
    /** After the words on Piloti's cursor tag („Piloti“, „Treppe“), never clipped: „Treppe · für Anna“. */
    forSuffix: '· für {name}',
    /** Was Pilotis Zeiger sagt, während es eine Seite oder einen Ausschnitt liest, nach seinem Namen. */
    reading: 'liest Seite {page}',
  },
}
