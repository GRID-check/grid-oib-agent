import type { en } from '../en'

/** Keyboard shortcuts: command palette, cheatsheet, and the profile toggle. */
export const shortcuts: typeof en.shortcuts = {
  palette: {
    title: 'Befehlspalette',
    description: 'Projekt oder Aktion suchen und direkt dorthin springen.',
    placeholder: 'Befehl eingeben oder suchen…',
    empty: 'Keine Ergebnisse gefunden.',
    groups: {
      projects: 'Projekte',
      currentProject: 'Aktuelles Projekt',
      general: 'Allgemein',
    },
    /** The intake wizard section (labelled "Einrichtung" in the product). */
    intake: 'Einrichtung',
    toggleTheme: 'Design umschalten',
  },
  cheatsheet: {
    title: 'Tastaturkürzel',
    description: 'Grid bedienen, ohne die Tastatur zu verlassen.',
    thenSeparator: 'dann',
    items: {
      palette: 'Befehlspalette öffnen',
      cheatsheet: 'Diese Übersicht anzeigen',
      projects: 'Zu Ihren Projekten wechseln',
    },
    disableHint: 'Tastaturkürzel lassen sich in den Profileinstellungen deaktivieren.',
  },
  preference: {
    title: 'Tastaturkürzel',
    description: 'Schnelle Navigation mit Befehlspalette und Kurzbefehlen.',
    label: 'Tastaturkürzel aktivieren',
    hint: 'Schaltet die Befehlspalette (Strg+K / ⌘K) und alle Kurzbefehle auf diesem Gerät ein oder aus.',
  },
}
