import type { en } from '../en'

/**
 * Zusammenarbeit: Teilen, @-Erwähnungen mit Übergabe an einen Menschen, Postfach
 * (ADR-0032…0035).
 *
 * Deutsch ist die primäre Produktsprache — diese Datei ist die Fassung, die die
 * meisten Nutzer sehen. Durchgängig Sie-Form, wie im übrigen Produkt.
 */
export const collaboration: typeof en.collaboration = {
  sharing: {
    title: 'Teilen',
    action: 'Teilen',
    close: 'Schließen',
    visibilityHeading: 'Wer diesen Chat sehen kann',
    loading: 'Freigabe-Einstellungen werden geladen…',
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
    },
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
        'Zu viele Änderungen an der Freigabe. Bitte warten Sie einige Minuten und versuchen Sie es dann erneut.',
      rosterFull:
        'Dieser Chat hat bereits die maximale Anzahl an Personen. Entziehen Sie zuerst jemandem den Zugriff.',
      loadFailed: 'Die Freigabe-Einstellungen konnten nicht geladen werden.',
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
      toAgent: 'Geht an Piloti',
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
    archived: 'Archiviert',
    resolved: 'Beantwortet',
    inert: 'Nicht mehr verfügbar',
    bodyUnavailable: 'Dieser Chat ist für Sie nicht mehr verfügbar.',
    inertHint: 'Sie haben keinen Zugriff mehr darauf.',
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
      storageQuotaWarning: {
        title: 'Der Speicherplatz Ihrer Organisation wird knapp',
        body: '{subject} des Speicherkontingents sind belegt. Sobald es voll ist, schlagen Uploads fehl – löschen Sie nicht mehr benötigte Dokumente oder bitten Sie den Betreiber Ihrer Piloti-Installation, das Kontingent zu erhöhen.',
      },
      documentAssigned: {
        title: '{actor} hat Ihnen {subject} zugewiesen',
        body: 'Sie sind für diese Datei verantwortlich.',
      },
      unknown: {
        title: 'Es gab Aktivität',
        body: 'in {subject}',
      },
    },
    unknownActor: 'Jemand',
    untitledConversation: 'Chat ohne Titel',
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
