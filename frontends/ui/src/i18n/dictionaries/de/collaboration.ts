import type { en } from '../en'

/**
 * Zusammenarbeit: Teilen, @-Erwähnungen mit Übergabe an einen Menschen, Postfach
 * (ADR-0032…0035).
 *
 * Deutsch ist die primäre Produktsprache — diese Datei ist die Fassung, die die
 * meisten Nutzer sehen. Durchgängig Sie-Form, wie im übrigen Produkt.
 */
export const collaboration: typeof en.collaboration = {
  rightsLost: {
    neutralTitle: 'Geteilter Chat',
    title: 'Ihnen fehlen inzwischen die Rechte, um diesen Chat zu sehen',
    description:
      'Der Zugriff auf einen Ordner, aus dem dieser Chat stammt, hat sich seit dem Teilen geändert. Fragen Sie eine Person, die diese Ordner lesen darf, oder Ihre Administration.',
  },
  sharing: {
    title: 'Teilen',
    action: 'Teilen',
    close: 'Schließen',
    /** Der Link zum Chat: er öffnet nur für Personen, die ohnehin Zugriff haben. */
    link: {
      heading: 'Link',
      share: 'Link teilen',
      copy: 'Link kopieren',
      copied: 'Link kopiert',
      failed: 'Der Link konnte nicht kopiert werden.',
      hint: 'Der Link öffnet den Chat nur für Personen, die Zugriff haben. Wer noch keinen hat, wird oben eingeladen.',
      shareTitle: 'Chat in Piloti',
    },
    visibilityHeading: 'Wer diesen Chat sehen kann',
    loading: 'Einstellungen zum Teilen werden geladen…',
    audienceHeading: 'Wer mitliest',
    visibility: {
      private: 'Nur ich',
      privateHint: 'Nur Sie und Personen, die Sie namentlich einladen.',
      project: 'Alle im Projekt',
      projectHint: 'Alle Projektmitglieder können mitlesen und mitschreiben.',
      organization: 'Alle in der Organisation',
      organizationHint: 'Alle Mitglieder Ihrer Organisation können mitlesen und mitschreiben.',
      narrowLoss: {
        project: 'Alle im Projekt verlieren dadurch den Zugriff auf diesen Chat.',
        organization: 'Alle in der Organisation verlieren dadurch den Zugriff auf diesen Chat.',
      },
    },
    chip: {
      private: 'Privat',
      project: 'Projekt',
      organization: 'Organisation',
      sharedOne: 'Mit 1 Person geteilt',
      sharedMany: 'Mit {count} Personen geteilt',
      ariaLabel: 'Zugriff: {label}',
    },
    peopleHeading: 'Personen mit Zugriff',
    roles: {
      viewer: 'Kann lesen',
      collaborator: 'Kann mitschreiben',
      owner: 'Eigentümer',
    },
    reasons: {
      creator: 'Hat den Chat erstellt',
      grant: 'Eingeladen von {name}',
      grantUnknown: 'Eingeladen',
      'visibility-project': 'Projektmitglied',
      'visibility-organization': 'Mitglied der Organisation',
    },
    invite: {
      label: 'Person einladen',
      placeholder: 'Nach Name oder E-Mail suchen…',
      empty: 'Es gibt niemanden mehr, den Sie einladen könnten.',
      noResults: 'Keine Treffer für „{query}“',
      submit: 'Einladen',
      needsProjectAccess: 'Noch nicht im Projekt',
      needsProjectAccessHint:
        'Fügen Sie die Person zuerst dem Projekt hinzu. Das Teilen eines Chats gewährt niemals Zugriff auf das Projekt selbst.',
      lacksFolderAccess: 'Hat keinen Zugriff auf einen Ordner, aus dem dieser Chat stammt',
      lacksFolderAccessBadge: 'Kein Zugriff',
    },
    lostAccess: 'Hat keinen Zugriff mehr',
    roleHeading: 'Zugriffsstufe',
    manageFor: 'Zugriff verwalten: {name}',
    remove: 'Zugriff entziehen',
    removeConfirm: '{name} entfernen?',
    removeConfirmHint:
      'Der Zugriff endet sofort. Bereits geschriebene Beiträge bleiben im Chat erhalten.',
    leave: 'Chat verlassen',
    leaveConfirm: 'Diesen Chat verlassen?',
    leaveConfirmHint: 'Sie verlieren den Zugriff. Für alle anderen bleibt er bestehen.',
    escalate: 'Eigentümerschaft übernehmen',
    escalateConfirm: 'Eigentümerschaft übernehmen?',
    escalateHint:
      'Als Projekt-Administrator können Sie die Eigentümerschaft an diesem Chat übernehmen. Das wird im Audit-Protokoll festgehalten.',
    errors: {
      lastOwner:
        'Dieser Chat braucht mindestens einen Eigentümer. Machen Sie zuerst eine andere Person zum Eigentümer.',
      containerAccessRequired:
        'Diese Person ist noch kein Mitglied des Projekts. Fügen Sie sie zuerst dem Projekt hinzu.',
      organizationMembershipRequired: 'Diese Person ist kein Mitglied dieser Organisation.',
      rateLimited:
        'Zu viele Änderungen daran, wer diesen Chat sieht. Bitte warten Sie einige Minuten und versuchen Sie es dann erneut.',
      rosterFull:
        'Dieser Chat hat bereits die maximale Anzahl an Personen. Entziehen Sie zuerst jemandem den Zugriff.',
      restrictedContent:
        '{name} darf nicht jeden Ordner mit eingeschränktem Zugriff lesen, auf den sich dieser Chat stützt. Deshalb kann er nicht mit dieser Person geteilt werden.',
      restrictedContentFolders:
        '{name} darf nicht jeden Ordner mit eingeschränktem Zugriff lesen, auf den sich dieser Chat stützt ({folders}). Deshalb kann er nicht mit dieser Person geteilt werden.',
      restrictedContentSomeone:
        'Diese Person darf nicht jeden Ordner mit eingeschränktem Zugriff lesen, auf den sich dieser Chat stützt. Deshalb kann er nicht mit ihr geteilt werden.',
      restrictedContentSelf:
        'Sie dürfen nicht jeden Ordner mit eingeschränktem Zugriff lesen, auf den sich dieser Chat stützt, und können ihn deshalb nicht übernehmen.',
      restrictedContentProject:
        'Dieser Chat stützt sich auf einen Ordner mit eingeschränktem Zugriff und kann deshalb nicht für das ganze Projekt sichtbar gemacht werden. Teilen Sie ihn mit einzelnen Personen, die den Ordner lesen dürfen.',
      crossProjectContent:
        '{name} darf nicht jedes andere Projekt öffnen, auf das sich dieser Chat stützt. Deshalb kann er nicht mit dieser Person geteilt werden.',
      crossProjectContentSomeone:
        'Diese Person darf nicht jedes andere Projekt öffnen, auf das sich dieser Chat stützt. Deshalb kann er nicht mit ihr geteilt werden.',
      crossProjectContentSelf:
        'Sie dürfen nicht jedes andere Projekt öffnen, auf das sich dieser Chat stützt, und können ihn deshalb nicht übernehmen.',
      crossProjectContentProject:
        'Dieser Chat stützt sich auf Inhalte aus anderen Projekten und kann deshalb nicht für das ganze Projekt sichtbar gemacht werden. Teilen Sie ihn mit einzelnen Personen, die diese Projekte öffnen dürfen.',
      loadFailed: 'Die Einstellungen zum Teilen konnten nicht geladen werden.',
      saveFailed: 'Die Änderung konnte nicht gespeichert werden.',
      tryAgain: 'Erneut versuchen',
      dismiss: 'Diese Meldung ausblenden',
    },
    resourceTypes: {
      conversation: 'Chat',
      document: 'Datei',
    },
    overview: {
      title: 'Wer Zugriff hat',
      openLabel: 'Anzeigen, wer Zugriff hat',
      countOne: '1 Person',
      countMany: '{count} Personen',
      ownersHeading: 'Eigentümer',
      collaboratorsHeading: 'Können mitschreiben',
      viewersHeading: 'Können lesen',
      you: 'Sie',
      viaVisibilityProject: 'Alle im Projekt können ebenfalls mitlesen und mitschreiben.',
      viaVisibilityOrganization:
        'Alle in Ihrer Organisation können ebenfalls mitlesen und mitschreiben.',
      viaVisibilityPrivate: 'Nur die hier aufgeführten Personen.',
      namedHeading: 'Namentlich eingeladen',
      derivedMore: 'und {count, plural, one {eine weitere} other {# weitere}}',
    },
  },

  mentions: {
    picker: {
      label: 'Person erwähnen',
      placeholder: 'Kollegin oder Kollegen erwähnen…',
      empty: 'Hier gibt es niemanden zu erwähnen.',
      noResults: 'Keine Treffer für „{query}“',
      loading: 'Personen werden geladen…',
      participantsHeading: 'In diesem Chat',
      othersHeading: 'Weitere im Projekt',
      agentName: 'Piloti',
      agentHint: 'Den Assistenten fragen',
      needsInvite: 'Wird eingeladen',
      needsInviteHint: '{name} ist noch nicht in diesem Chat und wird eingeladen.',
      needsInviteHintShort: 'Noch nicht in diesem Chat – wird eingeladen.',
      cannotInvite: 'Nur Eigentümer können neue Personen in diesen Chat holen.',
      resultsAria: 'Personen, die Sie erwähnen können',
      keyboardHint: '↑↓ auswählen · ↵ einfügen · Esc schließen',
      badgeAgent: 'Assistent',
      chipRemove: 'Erwähnung von {name} entfernen',
    },
    composerHint: 'Piloti hält sich zurück – {name} wird gefragt.',
    composerHintMany: 'Piloti hält sich zurück – {names} werden gefragt.',
    addressee: {
      toPerson: 'Geht an {name}',
      toPeople: 'Geht an {names}',
      toThread: 'Geht an alle im Chat',
      agentHint: '@Piloti eingeben, um Piloti zu fragen',
      mentionSomeone: 'Kollegin oder Kollegen erwähnen',
      ariaLabel: 'Empfänger dieser Nachricht: {label}',
    },
    peek: {
      agentRole: 'Assistent in diesem Projekt',
      inConversation: 'Kann diesen Chat lesen',
      notInConversation: 'Nicht in diesem Chat',
    },
    notePlaceholder: 'Worum soll sich die Person kümmern? (optional)',
    engagement: {
      mentionLabel: 'Piloti antwortet nur bei Erwähnung',
      mentionHint:
        'Hier unterhalten sich mehrere Personen – eine Nachricht ohne Erwähnung geht an alle im Chat.',
      switchToAsk: 'Piloti immer antworten lassen',
      offerHint: 'Hier schreiben mehrere Personen. Soll Piloti auf eine Erwähnung warten?',
      switchToMention: 'Nur bei Erwähnung antworten',
      failed: 'Die Änderung konnte nicht gespeichert werden.',
    },
    awaiting: {
      one: 'Warten auf {name}',
      many: 'Warten auf {names}',
      hint: 'Piloti hält sich zurück, bis eine Antwort kommt.',
      askedBy: 'Gefragt von {name}',
      since: 'seit {time}',
      awaitingYou: 'Ihre Einschätzung wurde angefragt',
      awaitingYouHint: 'Antworten Sie im Chat – oder heben Sie das Warten auf.',
      release: 'Ohne Antwort weitermachen',
      releaseOne: 'Ohne {name} weitermachen',
      releaseOneSince: 'Ohne {name} weitermachen – Warten seit {time}',
      released: 'Das Warten wurde aufgehoben.',
      askAgent: 'Stattdessen Piloti fragen',
      askBack: 'Rückfrage an {name}',
    },
    handback: {
      offer: '{name} hat geantwortet – Piloti weiterarbeiten lassen?',
      offerMany: '{names} haben geantwortet – Piloti weiterarbeiten lassen?',
      action: 'Piloti weiterarbeiten lassen',
      dismiss: 'Nicht jetzt',
      prefill: '– bitte auf dieser Grundlage weiterarbeiten.',
    },
    errors: {
      inviteRequiresOwner:
        'Sie können nur Personen erwähnen, die bereits in diesem Chat sind. Bitten Sie einen Eigentümer, {name} einzuladen.',
      containerAccessRequired: '{name} ist kein Mitglied dieses Projekts.',
      rateLimited: 'Zu viele Erwähnungen. Bitte warten Sie einige Minuten.',
      releaseFailed: 'Das Warten konnte nicht aufgehoben werden.',
    },
  },

  inbox: {
    title: 'Postfach',
    navLabel: 'Postfach',
    badgeAria:
      '{count, plural, one {# Eintrag braucht} other {# Einträge brauchen}} Ihre Aufmerksamkeit',
    badgeAriaOne: '1 Eintrag braucht Ihre Aufmerksamkeit',
    subtitle: 'Anfragen und Neuigkeiten aus Ihrem Team.',
    filters: {
      needsMe: 'Für mich',
      all: 'Alle',
      ariaLabel: 'Postfach filtern',
    },
    markAllRead: 'Alle als gelesen markieren',
    archive: 'Archivieren',
    undo: 'Rückgängig',
    /** Die kurze Form für ein Telefon, wo die lange die Zeile sprengt. */
    markAllReadShort: 'Alle gelesen',
    archived: 'Archiviert',
    resolved: 'Beantwortet',
    inert: 'Nicht mehr verfügbar',
    // Für jedes Ziel, auf das eine Zeile zeigt (Chat, Dokument, Anmerkung), nicht nur für Chats.
    bodyUnavailable: 'Das ist für Sie nicht mehr verfügbar.',
    inertHint: 'Sie haben keinen Zugriff mehr darauf.',
    // Die nächste Handlung bei einer neuen Fassung unter anderem Namen: die
    // beiden nebeneinander sehen. Öffnet die Vorschau mit dem Vergleich.
    compareFassungen: 'Fassungen vergleichen',
    compareFassungenLabel: 'Neue und ältere Fassung von „{subject}“ vergleichen',
    empty: {
      needsMeTitle: 'Nichts zu tun',
      needsMeDescription:
        'Wenn jemand Ihre Einschätzung braucht, erscheint die Anfrage hier.',
      allTitle: 'Ihr Postfach ist leer',
      allDescription: 'Anfragen, Antworten und geteilte Chats erscheinen hier.',
    },
    errors: {
      loadFailed: 'Ihr Postfach konnte nicht geladen werden.',
      actionFailed: 'Die Aktion konnte nicht ausgeführt werden. Ihr Postfach ist unverändert.',
      tryAgain: 'Erneut versuchen',
    },
    types: {
      mentionRequested: {
        title: '{actor} hat um Ihre Einschätzung gebeten',
        body: 'in {subject}',
      },
      mentionAnswered: {
        title: '{actor} hat geantwortet',
        body: 'in {subject}',
      },
      conversationShared: {
        title: '{actor} hat einen Chat mit Ihnen geteilt',
        body: '{subject}',
      },
      conversationActivity: {
        titleOne: '1 neue Nachricht',
        titleMany: '{count} neue Nachrichten',
        titleNone: 'Nachrichten',
        body: 'in {subject}',
      },
      // Platform tier: a member sent product feedback. {subject} is the
      // organization it came from; the excerpt below the title is the message.
      feedbackSubmitted: {
        title: '{actor} hat Feedback gesendet',
        body: 'aus {subject} – zum Sichten öffnen.',
      },
      storageQuotaWarning: {
        title: 'Der Speicherplatz Ihrer Organisation wird knapp',
        body: '{subject} des Speicherkontingents sind belegt. Sobald es voll ist, schlagen Uploads fehl – löschen Sie nicht mehr benötigte Dokumente oder bitten Sie den Betreiber Ihrer Piloti-Installation, das Kontingent zu erhöhen.',
      },
      documentAssigned: {
        title: '{actor} hat Ihnen {subject} zugewiesen',
        body: 'Sie sind für diese Datei verantwortlich.',
      },
      // Ein Hintergrundauftrag ist zu Ende. {subject} ist der Name des Auftrags.
      // Kein {actor}: die Arbeit hat Piloti getan, nicht eine Person.
      // ADR-0086: alles, was ein Upload gebracht hat, ist gelesen. {subject}
      // ist der Projektname; ein Upload in die Büroablage oder einen Chat hat
      // keinen und liest bodyNoSubject.
      uploadCompleted: {
        title: 'Ihr Upload ist gelesen',
        body: '{subject}: Öffnen Sie die Übersicht, um zu sehen, was angekommen ist.',
        bodyNoSubject: 'Öffnen Sie die Übersicht, um zu sehen, was angekommen ist.',
      },
      // ADR-0086: die Inhaltsprüfung hat Dateien zurückgehalten.
      documentQuarantined: {
        titleOne: '1 Datei wartet in der Quarantäne',
        titleMany: '{count} Dateien warten in der Quarantäne',
        titleNone: 'Dateien in der Quarantäne',
        body: 'Kein Modell hat sie gelesen. Prüfen Sie sie: zulassen oder löschen.',
      },
      // ADR-0086: wer eine Datei hochgeladen hat, die in der Quarantäne liegt,
      // bittet darum, sie zu prüfen. {subject} ist der Dateiname.
      documentReleaseRequested: {
        title: '{actor} bittet Sie, „{subject}“ zu prüfen',
        body: 'Die Datei liegt in der Quarantäne. Sehen Sie sie an und lassen Sie sie zu oder löschen Sie sie.',
      },
      // Die Zeile führt zum Lauf selbst (seinem Block im Verlauf, sonst der
      // Aufgabe): dort stehen Ergebnis und Grund, nicht in einer „Laufhistorie“.
      jobCompleted: {
        title: 'Piloti hat „{subject}“ erledigt',
        body: 'Öffnen Sie den Eintrag, um das Ergebnis zu sehen.',
      },
      // Ein Outlook-Archiv ist importiert. {subject} ist der Dateiname des Archivs.
      mailImportCompleted: {
        title: '„{subject}“ ist importiert',
        body: 'Piloti hat die E-Mails und ihre Anhänge im Projekt unter E-Mail-Import abgelegt.',
      },
      mailImportFailed: {
        title: 'Der Import von „{subject}“ wurde abgebrochen',
        body: 'Was bis dahin importiert war, bleibt im Projekt. Die Importliste unter Dateien nennt den Grund.',
      },
      jobFailed: {
        title: 'Piloti konnte „{subject}“ nicht abschließen',
        body: 'Öffnen Sie den Eintrag: Dort steht, woran es lag.',
      },
      jobWaiting: {
        title: 'Piloti hat eine Rückfrage zu „{subject}“',
        body: 'Antworten Sie im Verlauf, dann arbeitet Piloti weiter.',
      },
      // Eine Fassung eines Dokuments wartet auf eine Entscheidung (ADR-0054).
      // {subject} ist das Dokument, {actor} wer sie eingereicht hat.
      documentReviewRequested: {
        title: '{actor} bittet Sie um die Freigabe von {subject}',
        body: 'Eine neue Fassung wartet auf Ihre Freigabe.',
      },
      // Eine neuere Fassung eines Dokuments, dem Sie folgen: ein Satz über die
      // Person, die sie hochgeladen hat. {actor} ist diese Person, {subject} das
      // Dokument, dem Sie folgen (ohne Dateiendung). Was sich geändert hat,
      // steht als Auszug darunter; nur ohne Auszug sagt `bodyNoExcerpt`, wo
      // man es findet. `titleNoActor`, wenn niemand Bestimmtes es war.
      documentNewFassung: {
        title: '{actor} hat eine neue Fassung von „{subject}“ hochgeladen',
        titleNoActor: 'Neue Fassung von „{subject}“',
        bodyNoExcerpt: 'Öffnen Sie die Fassung, um die Änderungen zu sehen.',
      },
      // Was Piloti an einer Anmerkung getan hat, für die Person, deren Handlung
      // es geweckt hat: wer die Anmerkung delegiert, Piloti darin erwähnt oder
      // auf seine Rückfrage geantwortet hat (ADR-0106). {related} ist die
      // laufende Nummer der Anmerkung, {subject} das Dokument; der Auszug
      // darunter ist, was die Anmerkung sagt. Kein {actor}: das war Piloti.
      // `titleRelatedNoSubject`, wenn das Dokument nicht zu benennen war.
      // Dieselben Wörter wie in der Prüfansicht: Anmerkung, Verlauf, delegieren.
      pilotiWorkDone: {
        title: 'Piloti hat eine Anmerkung für Sie bearbeitet',
        titleRelated: 'Piloti hat Anmerkung {related} in „{subject}“ für Sie bearbeitet',
        titleRelatedNoSubject: 'Piloti hat Anmerkung {related} für Sie bearbeitet',
        body: 'Lesen Sie die Antwort im Verlauf der Anmerkung.',
      },
      // Piloti konnte es nicht. `variants` sagen warum, nach der Klasse des
      // gespeicherten Grundes (`lib/annotations/wake-end-reason.ts`), und was
      // die Person tun kann; `body` gilt für einen Eintrag von davor.
      pilotiWorkFailed: {
        title: 'Piloti konnte eine Anmerkung nicht bearbeiten',
        titleRelated: 'Piloti konnte Anmerkung {related} in „{subject}“ nicht bearbeiten',
        titleRelatedNoSubject: 'Piloti konnte Anmerkung {related} nicht bearbeiten',
        body: 'Öffnen Sie die Anmerkung: Bitten Sie Piloti noch einmal darum oder bearbeiten Sie sie selbst.',
        variants: {
          budget: {
            body: 'Das Nutzungsbudget ist aufgebraucht. Wer Ihre Organisation verwaltet, kann es unter Organisation → Nutzung & Budgets erhöhen; danach können Sie Piloti noch einmal darum bitten.',
          },
          busy: {
            body: 'Piloti kam nicht rechtzeitig dazu, weil gerade zu viel zu tun war. Bitten Sie Piloti später noch einmal darum.',
          },
          access: {
            body: 'Piloti konnte sich nicht in Ihrem Namen anmelden. Bitten Sie Piloti noch einmal darum oder bearbeiten Sie die Anmerkung selbst.',
          },
          error: {
            body: 'Die Bearbeitung brach ab, bevor eine Antwort da war. Bitten Sie Piloti noch einmal darum oder bearbeiten Sie die Anmerkung selbst.',
          },
        },
      },
      // Piloti hat eine Rückfrage gestellt und wartet auf eine Person: die
      // Zuständige der Anmerkung, sonst die, für die es gearbeitet hat. Die
      // Frage steht als Auszug darunter.
      pilotiAsksYou: {
        title: 'Piloti hat eine Rückfrage an Sie',
        titleRelated: 'Piloti hat eine Rückfrage an Sie zu Anmerkung {related} in „{subject}“',
        titleRelatedNoSubject: 'Piloti hat eine Rückfrage an Sie zu Anmerkung {related}',
        body: 'Piloti wartet auf Ihre Antwort. Antworten Sie im Verlauf der Anmerkung.',
      },
      // Ein Vorschlag, den der Server hält (ADR-0105), für die Person, für die
      // Piloti ihn gemacht hat. `variants` nennen, was er ändert (eine
      // Dateiänderung nach ihrem Verb, sonst nach Art:
      // `PROPOSAL_NOTICE_VARIANTS`); der Auszug darunter nennt die Dateien, die
      // Notiz oder die Änderung. Wörter wie auf der Karte.
      pilotiProposalWaiting: {
        title: 'Piloti hat einen Vorschlag für Sie',
        body: 'Der Vorschlag steht im Chat. Übernehmen oder verwerfen Sie ihn dort; bis dahin ändert sich nichts.',
        variants: {
          move: { title: 'Piloti schlägt einen neuen Ablageort vor' },
          rename: { title: 'Piloti schlägt eine Umbenennung vor' },
          create_folder: { title: 'Piloti schlägt einen neuen Ordner vor' },
          assign: { title: 'Piloti schlägt eine Zuweisung vor' },
          memory: { title: 'Piloti möchte sich eine Notiz merken' },
          project_profile: { title: 'Piloti schlägt eine Änderung am Projektkontext vor' },
        },
      },
      // Piloti hat die Dokumente eines Projekts gelesen und Werte für das
      // Projektprofil vorgeschlagen (ADR-0111). {subject} ist der Projektname,
      // {related} die Zahl der Rückfragen, die die Gebäudeklasse entscheiden;
      // ohne Rückfragen fehlt sie, dann gilt `title`. Was Piloti zusammengefasst
      // hat, steht als Auszug darunter.
      pilotiIntakeReady: {
        title: 'Piloti hat die Dokumente von „{subject}“ gelesen',
        titleRelated: 'Piloti hat die Dokumente von „{subject}“ gelesen – Rückfragen: {related}',
        body: 'Prüfen Sie die Vorschläge und bestätigen Sie, was stimmt.',
      },
      // Die Dateien einer E-Mail an die Projektadresse sind abgelegt (ADR-0075).
      // {subject} ist der Betreff der E-Mail, {project} das Projekt, {filed}
      // und {skipped} die Zahl der abgelegten und übersprungenen Anhänge. Die
      // übersprungenen Dateien listet die Zeile selbst, mit `reasons`.
      inboundMailFiled: {
        title:
          '{filed, plural, =0 {Keine Anhänge} one {# Datei} other {# Dateien}} aus der E-Mail „{subject}“ in {project} abgelegt',
        titleUntitled:
          '{filed, plural, =0 {Keine Anhänge} one {# Datei} other {# Dateien}} aus einer E-Mail in {project} abgelegt',
        titleWithheld: 'Anhänge aus einer E-Mail abgelegt',
        skippedLabel: 'Nicht abgelegt:',
        more: '+{count} weitere',
        cloudLinks: 'Links auf Cloud-Dateien ruft Piloti nicht ab. Hängen Sie die Dateien an oder laden Sie sie direkt hoch.',
        reasons: {
          embedded: 'Bild im E-Mail-Text',
          tnef: 'Outlook-Format (winmail.dat)',
          signature: 'Signatur der E-Mail',
          encrypted: 'verschlüsselt',
          calendar: 'Kalendereinladung',
          empty: 'leere Datei',
          unknownType: 'Dateityp nicht erkannt',
          limit: 'mehr als 100 Dateien in der E-Mail',
          type: 'Dateityp nicht erlaubt',
          size: 'Datei zu groß',
          screened: 'vom Namensfilter des Büros zurückgehalten',
          quota: 'Speicherplatz der Organisation voll',
        },
      },
      // Die Dateien einer E-Mail konnten auch nach allen Wiederholungen nicht
      // abgelegt werden. {project} ist das Projekt, {subject} der Betreff.
      inboundMailFailed: {
        title: 'Die Dateien aus Ihrer E-Mail „{subject}“ konnten nicht in {project} abgelegt werden',
        titleUntitled: 'Die Dateien aus Ihrer E-Mail konnten nicht in {project} abgelegt werden',
        titleWithheld: 'Die Dateien aus einer E-Mail konnten nicht abgelegt werden',
        body: 'Bitte laden Sie sie direkt hoch.',
      },
      unknown: {
        title: 'Es gab Aktivität',
        body: 'in {subject}',
      },
    },
    unknownActor: 'Jemand',
    untitledConversation: 'Chat ohne Titel',
    // Triage einer Fassung, die auf eine Entscheidung wartet, direkt in der
    // Zeile: die drei Entscheidungen ohne Umweg über die Dateien. Die Freigabe
    // trägt dieselbe Mindestzeremonie wie an der Datei (ausdrückliche
    // Bestätigung, nie ein Klick); die beiden Verweigerungen tragen ihre
    // Begründung, wie die Übergangstabelle sie verlangt.
    review: {
      approve: 'Freigeben',
      requestChanges: 'Änderungen anfordern',
      reject: 'Ablehnen',
      changesLabel: 'Was geändert werden soll',
      reasonLabel: 'Grund der Ablehnung',
      approveConfirm: 'Ich gebe diese Fassung frei',
      // Die Unterschrift wie an der Datei: welche Fassung freigegeben wird (das
      // Dokument, die Fassungsnummer und wann die Runde eröffnet wurde — die
      // Nummer ist Pflicht, ohne sie wird nicht freigegeben) und wer wann
      // handelt. Der Name der handelnden Person ist hier unbekannt, daher
      // immer die Form ohne Namen; wer gebeten hat, nennt bereits der Titel.
      approveStand: '{subject} · Fassung {number} · Stand vom {date}',
      approveActing: 'Handelnd: {date}',
      standFailed:
        'Die aktuelle Fassung konnte nicht gelesen werden – die Freigabe ist blockiert, bis sie vorliegt.',
      retry: 'Erneut versuchen',
      send: 'Senden',
      cancel: 'Abbrechen',
      open: 'Datei öffnen',
      decided: 'Entscheidung gesendet – wird aktualisiert.',
      failed: 'Das hat nicht geklappt. Es hat sich nichts geändert.',
      stale: 'Jemand hat zuerst entschieden – die aktuelle Fassung liegt in der Datei.',
      reload: 'Aktuelle Fassung öffnen',
    },
  },

  thread: {
    participantsAria: 'Personen in diesem Chat',
    mentionAria: 'Erwähnung von {name}',
    mentionedYouAria: 'Sie wurden erwähnt',
    groupedAria: 'Fortsetzung von {name}',
    turnInFlight: 'Piloti beantwortet die Frage von {name}…',
    turnInFlightYou: 'Piloti antwortet…',
    typing: '{names} schreibt…',
    typingPair: '{names} schreiben…',
    typingMany: '{names} und {count} weitere Personen schreiben…',
    typingManyOne: '{names} und eine weitere Person schreiben…',
    typingNameSeparator: ', ',
    typingNamePair: '{first} und {second}',
    spectatorPrompt: 'Piloti hat eine Rückfrage gestellt und wartet auf eine Antwort: „{question}“',
    spectatorFailed: 'Diese Antwort endete mit einem Fehler.',
    composerBusy:
      'Piloti beantwortet gerade die Frage von {name} – Sie können senden, sobald das erledigt ist.',
    accessLost:
      'Dieser Chat ist für Sie nicht mehr verfügbar. Was Sie hier sehen, ist eine lokale Kopie und wird nicht mehr aktualisiert.',
    viewerNotice:
      'Sie können hier mitlesen. Eine Eigentümerin oder ein Eigentümer kann Ihnen über den Teilen-Dialog Schreibzugriff geben.',
    unreadDivider: 'Neu',
    authorYou: 'Sie',
    authorAria: 'Nachricht von {name}',
  },
}
