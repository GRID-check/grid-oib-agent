import type { en } from '../en'

/** onboarding namespace — die Einrichtung der Organisation und die Produkttour. */
export const onboarding: typeof en.onboarding = {
  validation: {
    nameRequired: 'Der Organisationsname ist erforderlich.',
    nameTooLong: 'Der Organisationsname darf höchstens 100 Zeichen lang sein.',
  },
  inviteOnly: {
    eyebrow: 'Einladung erforderlich',
    title: 'Diese Plattform ist nur auf Einladung zugänglich',
    description:
      'Neue Organisationen werden vom Plattform-Team angelegt. Bitten Sie den Administrator Ihrer Organisation um eine Einladung — danach landen Sie direkt im gemeinsamen Arbeitsbereich.',
    wrongAccount:
      'Mit dem falschen Konto angemeldet? Melden Sie sich ab und mit dem Konto an, das die Einladung erhalten hat.',
  },
  account: {
    signedInAs: 'Angemeldet als {email}',
    signedIn: 'Sie sind angemeldet.',
  },
  errors: {
    createFailed: 'Organisation konnte nicht erstellt werden.',
    selfServeDisabled: 'Das Erstellen neuer Organisationen ist auf dieser Plattform deaktiviert. Bitten Sie Ihren Administrator um eine Einladung.',
    generic: 'Etwas ist schiefgelaufen.',
    title: 'Organisationseinrichtung fehlgeschlagen',
  },
  form: {
    eyebrow: 'Neue Organisation',
    title: 'Benennen Sie Ihre Organisation',
    description:
      'Ihre Organisation ist der private Raum für die Bauprojekte, Dokumente und Kolleginnen und Kollegen Ihres Büros. Sie werden ihr Administrator.',
    nameLabel: 'Organisationsname',
    namePlaceholder: 'Musterarchitektur ZT GmbH',
    nameHint: 'Meist der Name Ihres Büros.',
    submit: 'Organisation erstellen',
    invitedHint:
      'Sie möchten einer bestehenden Organisation beitreten? Bitten Sie deren Administrator um eine Einladung — eingeladene Mitglieder überspringen diesen Schritt.',
  },
  next: {
    heading: 'Wie es weitergeht',
    private: 'Dokumente, Chats und Recherchen bleiben in Ihrer Organisation.',
    admin: 'Als Administrator laden Sie Kolleginnen und Kollegen ein und legen fest, was sie dürfen.',
    tour: 'Eine kurze Tour zeigt Ihnen alles Wichtige.',
  },
  success: {
    title: 'Organisation erstellt',
    description: '{name} ist bereit, und Sie sind ihr Administrator.',
    redirecting: 'Ihr Arbeitsbereich wird geöffnet…',
  },
  tour: {
    progress: '{current} von {total}',
    next: 'Weiter',
    back: 'Zurück',
    done: 'Loslegen',
    close: 'Tour schließen',
    stops: {
      welcome: {
        title: 'Willkommen bei Piloti',
        body: 'Ihre Organisation ist bereit. Ein kurzer Rundgang zeigt, wo was liegt — er dauert etwa eine Minute.',
      },
      createProject: {
        title: 'Alles beginnt mit einem Projekt',
        body: 'Ein Projekt umfasst ein Gebäude: Pläne und Dokumente, die Beteiligten und einen Chat, der aus OIB-Richtlinien und österreichischem Baurecht antwortet — jede Quelle belegt. Eine kurze Einrichtung fragt nach dem Gebäude, danach zeigen wir Ihnen das Projekt.',
      },
      archiv: {
        title: 'Archiv',
        body: 'Die gemeinsamen Unterlagen Ihres Büros — Regeldetails, Leistungsbeschreibungen, Vorlagen. Einmal hier abgelegt, kann jedes Projekt darauf zurückgreifen.',
      },
      inbox: {
        title: 'Postfach',
        body: 'Erwähnungen, Anfragen und Neuigkeiten Ihrer Kolleginnen und Kollegen landen hier.',
      },
      account: {
        title: 'Ihre Organisation',
        body: 'Unter „Organisation“ laden Sie Kolleginnen und Kollegen ein und verwalten Rollen. Design, Sprache und diese Tour finden Sie ebenfalls hier.',
      },
      shortcuts: {
        title: 'Schneller ans Ziel',
        body: 'Zwei Tasten bringen Sie fast überallhin.',
        palette: 'Zu allem springen',
        cheatsheet: 'Alle Tastenkürzel',
      },
      projectWelcome: {
        title: 'Ihr Projekt ist eingerichtet',
        body: 'Piloti kennt jetzt die Eckdaten dieses Gebäudes. Hier findet die Arbeit statt.',
      },
      projectChat: {
        title: 'Frag Piloti',
        body: 'Fragen Sie in Ihren Worten nach diesem Gebäude: Brandabschnitte, Fluchtwege, Barrierefreiheit, Energie. Die Antworten stützen sich auf Baurecht, OIB-Richtlinien und Ihre eigenen Unterlagen.',
      },
      projectFiles: {
        title: 'Dateien: die Unterlagen dieses Projekts',
        body: 'Laden Sie Pläne, Gutachten und Schriftverkehr zu diesem Gebäude hoch. Sobald eine Datei indexiert ist, kann Piloti daraus zitieren — nur in diesem Projekt.',
      },
      projectArchiv: {
        title: 'Archiv: die Unterlagen Ihres Büros',
        body: 'Das Archiv steht über Ihren Projekten, und jedes Projekt durchsucht es automatisch mit. Es ist anfangs leer: Administratoren legen Unterlagen ab, alle in der Organisation können sie lesen und zitieren.',
      },
      filesOrArchiv: {
        title: 'Dateien oder Archiv?',
        body: 'Entscheidend ist, wem die Unterlage gehört.',
        filesTerm: 'Dateien — dieses Gebäude',
        filesDetail: 'Seine Pläne, Gutachten, Schriftverkehr. Zitiert nur in diesem Projekt.',
        archivTerm: 'Archiv — das Büro',
        archivDetail: 'Regeldetails, Leistungsbeschreibungen, Vorlagen, frühere Einreichungen, die sich wiederverwenden lassen. Zitiert in jedem Projekt.',
      },
      projectSources: {
        title: 'Jede Antwort zeigt ihre Quellen',
        body: 'Jede Aussage ist markiert, woher sie stammt — Baurecht, Projektwissen oder Büroarchiv — und öffnet die Stelle, auf der sie beruht. Hat Piloti keine Quelle, sagt es das.',
      },
      projectSettings: {
        title: 'Einstellungen und Mitglieder',
        body: 'Laden Sie die Beteiligten an diesem Gebäude ein, und passen Sie die Projekteinrichtung an, wenn sich Eckdaten ändern.',
      },
    },
  },
}
