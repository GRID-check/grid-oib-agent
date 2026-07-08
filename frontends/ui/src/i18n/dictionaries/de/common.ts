import type { en } from '../en'

/** Shared strings used across many surfaces. */
export const common: typeof en.common = {
  appName: 'Grid',
  tagline: 'KI-gestützter Recherche-Assistent',
  actions: {
    save: 'Speichern',
    cancel: 'Abbrechen',
    close: 'Schließen',
    back: 'Zurück',
    retry: 'Erneut versuchen',
    delete: 'Löschen',
    confirm: 'Bestätigen',
    edit: 'Bearbeiten',
    create: 'Erstellen',
    signOut: 'Abmelden',
    signIn: 'Anmelden',
    open: 'Öffnen',
    done: 'Fertig',
    skipToContent: 'Zum Inhalt springen',
  },
  states: {
    loading: 'Wird geladen…',
    saving: 'Wird gespeichert…',
    saved: 'Gespeichert',
    error: 'Etwas ist schiefgelaufen',
    empty: 'Noch nichts vorhanden',
  },
  theme: {
    label: 'Design',
    system: 'System',
    light: 'Hell',
    dark: 'Dunkel',
    systemAuto: 'Systemdesign (automatisch)',
  },
  language: {
    label: 'Sprache',
    english: 'English',
    german: 'Deutsch',
  },
}
