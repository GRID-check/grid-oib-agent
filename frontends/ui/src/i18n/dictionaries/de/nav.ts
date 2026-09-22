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
    /** Automatisierung — Tasks und Skills als Tabs in einem Bereich. */
    automation: 'Automatisierung',
    skills: 'Skills',
    jobs: 'Jobs',
    // Der führende Tab: an Piloti übergebene Arbeit, eine Karte je Task (ADR-0051).
    tasks: 'Tasks',
    archiv: 'Archiv',
    settings: 'Einstellungen',
    // Der Intake-Assistent, im Produkt „Einrichtung" (nur ⌘K-Palette).
    intake: 'Einrichtung',
  },
  sectionGroups: {
    work: 'Arbeit',
    org: 'Organisation',
  },
  sectionSubtitles: {
    files: 'Dokumente, auf die sich Piloti in diesem Projekt stützt.',
    automation:
      'Was Piloti erledigt hat, während Sie weg waren, was als Nächstes ansteht — und die Skills, mit denen es arbeitet.',
    knowledge: 'Was die Wissensbasis derzeit enthält.',
    settings: 'Projektprofil, Mitglieder, Gedächtnis und Gefahrenzone.',
    intake: 'Geführtes Briefing für dieses Projekt.',
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
  userMenu: {
    label: 'Benutzermenü für {name}',
    defaultUser: 'Standardbenutzer',
    authNotConfigured: 'Authentifizierung nicht konfiguriert',
    profile: 'Profil',
    organization: 'Organisation',
    platform: 'Plattform',
    settings: 'Einstellungen',
  },
}
