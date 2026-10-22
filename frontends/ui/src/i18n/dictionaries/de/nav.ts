import type { en } from '../en'

/** Navigation shell: sidebar, org header, and the user menu. */
export const nav: typeof en.nav = {
  projectNavigation: 'Projektnavigation',
  projectSections: 'Projektbereiche',
  allProjects: 'Piloti — alle Projekte',
  collapseSidebar: 'Seitenleiste einklappen',
  expandSidebar: 'Seitenleiste ausklappen',
  resizeSidebar: 'Breite der Seitenleiste ändern',
  resizeSidebarHint: 'Ziehen zum Ändern der Breite, klicken zum Einklappen',
  expandSidebarHint: 'Ziehen oder klicken zum Ausklappen',
  openNavigation: 'Navigation öffnen',
  closeNavigation: 'Navigation schließen',
  sections: {
    chat: 'Frag Piloti',
    files: 'Dateien',
    knowledge: 'Wissen',
    research: 'Recherche',
    /** Automatisierung — Aufgaben und Skills als Tabs in einem Bereich. */
    automation: 'Automatisierung',
    // Ähnliche abgeschlossene Projekte, für dieses gelesen (ADR-0094).
    referenzen: 'Ähnliche Projekte',
    skills: 'Skills',
    jobs: 'Jobs',
    // Der führende Tab: an Piloti übergebene Arbeit, eine Karte je Aufgabe (ADR-0051).
    tasks: 'Aufgaben',
    officeShelf: 'Büroablage',
    settings: 'Übersicht',
    // Der Intake-Assistent, im Produkt „Einrichtung" (nur ⌘K-Palette).
    intake: 'Einrichtung',
    // Piloti liest die Dokumente des Projekts, die Person prüft (ADR-0111).
    setup: 'Einrichtung',
  },
  sectionGroups: {
    work: 'Arbeit',
    org: 'Organisation',
  },
  sectionSubtitles: {
    files: 'Die Unterlagen dieses Projekts. Piloti liest sie und zitiert daraus.',
    automation:
      'Was Piloti erledigt hat, während Sie weg waren, was als Nächstes ansteht — und die Skills, mit denen es arbeitet.',
    knowledge: 'Was die Wissensbasis derzeit enthält.',
    settings: 'Wo dieses Projekt steht und wie es eingerichtet ist.',
    intake: 'Geführtes Briefing für dieses Projekt.',
    setup: 'Projekt, Ablage, Erfassung, Rückfragen, Steckbrief: Piloti liest, Sie prüfen und bestätigen.',
  },
  backTo: 'Zurück zu {label}',
  returnTargets: {
    project: 'zum Projekt',
    members: 'zum Projektteam',
    model: 'zum Modell',
    organization: 'zur Organisation',
    platform: 'zur Plattform',
    profile: 'zum Profil',
  },
  tabTitle: {
    intake: 'Einrichtung',
    setup: 'Einrichtung',
    researchProgress: '{percent}% · {label} — Piloti',
    researchActive: '⏳ {label} — Piloti',
  },
  projectSwitcher: {
    select: 'Projekt auswählen',
    switchCurrent: 'Projekt wechseln (aktuell: {name})',
    switchHeading: 'Projekt wechseln',
    projectSettings: 'Einstellungen für {name}',
    projects: 'Projekte',
    allProjects: 'Alle Projekte',
    viewAllProjects: 'Alle Projekte ansehen',
    newProject: 'Neues Projekt',
  },
  /** Die untere Tab-Leiste am Telefon (`components/shell/phone-tab-bar.tsx`). */
  inboundMailWaiting: '{count, plural, one {# E-Mail wartet auf Ablage} other {# E-Mails warten auf Ablage}}',
  tabBar: {
    label: 'Hauptnavigation',
    /** Öffnet das Blatt mit den Zielen, die die Leiste nicht trägt. */
    more: 'Mehr',
    /** Das Blatt hinter „Mehr“ (`components/shell/phone-more-sheet.tsx`). */
    moreSheet: {
      title: 'Mehr',
      description: 'Weitere Bereiche und das Konto.',
      close: 'Schließen',
      places: 'Bereiche',
      account: 'Konto',
    },
  },
  search: {
    /** Der Weg zur Befehlspalette per Finger, in beiden Kopfzeilen. */
    open: 'Suchen und springen',
  },
  /** Der Projektwechsel als Blatt von unten am Telefon. */
  projectSheet: {
    description: 'Zuletzt geöffnete Projekte zuerst, danach alle laufenden.',
    close: 'Schließen',
    searchLabel: 'Projekt suchen',
    searchPlaceholder: 'Projekt suchen',
    clearSearch: 'Suche leeren',
    recent: 'Zuletzt geöffnet',
    others: 'Weitere Projekte',
    matches: 'Passende Projekte',
    noMatch: 'Kein laufendes Projekt heißt so.',
  },
  userMenu: {
    label: 'Benutzermenü für {name}',
    defaultUser: 'Standardbenutzer',
    authNotConfigured: 'Authentifizierung nicht konfiguriert',
    profile: 'Profil',
    organization: 'Organisation',
    platform: 'Plattform',
    settings: 'Einstellungen',
    productTour: 'Produkttour',
  },
}
