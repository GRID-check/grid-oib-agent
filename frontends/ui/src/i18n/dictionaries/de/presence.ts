import type { en } from '../en'

/** Connection presence indicator: shell status dot labels and tooltips. */
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
}
