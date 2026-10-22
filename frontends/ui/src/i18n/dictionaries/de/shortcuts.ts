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
    hints: {
      move: 'bewegen',
      open: 'öffnen',
      close: 'schließen',
    },
  },
  cheatsheet: {
    title: 'Tastaturkürzel',
    description: 'Piloti bedienen, ohne die Tastatur zu verlassen.',
    thenSeparator: 'dann',
    orSeparator: 'oder',
    groups: {
      general: 'Allgemein',
      navigation: 'Wechseln zu',
      chat: 'Chat',
      review: 'Prüfansicht',
      inbox: 'Postfach',
      inboundMail: 'E-Mail-Eingang',
    },
    /** Shown under the navigation group, which mixes scoped and global jumps. */
    projectScopeNote: 'Bereichs-Kürzel öffnen den Bereich des Projekts, in dem Sie gerade sind.',
    items: {
      palette: 'Befehlspalette öffnen',
      cheatsheet: 'Diese Übersicht anzeigen',
      dismiss: 'Dialog oder Menü schließen',
      sendMessage: 'Nachricht senden',
      newLine: 'Neue Zeile',
      mention: 'Person erwähnen',
      chooseOption: 'Nummerierte Option wählen',
      reviewPoint: 'Anmerken',
      reviewRegion: 'Bereich anmerken',
      reviewAsk: 'Piloti nach einem Bereich fragen',
      reviewStep: 'Nächste oder vorige Anmerkung',
      reviewSettle: 'Vorschlag übernehmen oder Anmerkung erledigen',
      reviewDismiss: 'Vorschlag verwerfen',
      reviewChat: 'Kurz etwas sagen',
      inboxStep: 'Nächster oder voriger Eintrag',
      inboxOpen: 'Eintrag öffnen',
      inboxArchive: 'Eintrag archivieren',
      inboxToggleRead: 'Als gelesen oder ungelesen markieren',
      inboundMailStep: 'Nächste oder vorige E-Mail',
      inboundMailOpen: 'E-Mail öffnen',
      inboundMailSelect: 'E-Mail auswählen',
      inboundMailPreview: 'Anhang ansehen',
      inboundMailFile: 'Wie gezeigt ablegen',
      inboundMailDismiss: 'E-Mail verwerfen',
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
