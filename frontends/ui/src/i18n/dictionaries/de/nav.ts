import type { en } from '../en'

/** Navigation shell: sidebar, topbar, user menu. */
export const nav: typeof en.nav = {
  projectNavigation: 'Projektnavigation',
  projectSections: 'Projektbereiche',
  allProjects: 'Grid — alle Projekte',
  collapseSidebar: 'Seitenleiste einklappen',
  expandSidebar: 'Seitenleiste ausklappen',
  openNavigation: 'Navigation öffnen',
  closeNavigation: 'Navigation schließen',
  sections: {
    overview: 'Übersicht',
    chat: 'Chat',
    files: 'Dateien',
    research: 'Recherche',
    members: 'Mitglieder',
  },
  projectSwitcher: {
    select: 'Projekt auswählen',
    switchCurrent: 'Projekt wechseln (aktuell: {name})',
    projects: 'Projekte',
    allProjects: 'Alle Projekte',
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
