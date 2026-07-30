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
    visibility: {
      private: 'Nur ich',
      privateHint: 'Nur Sie und Personen, die Sie namentlich einladen.',
      project: 'Alle im Projekt',
      projectHint: 'Alle Projektmitglieder können mitlesen und mitschreiben.',
      organization: 'Alle in der Organisation',
      organizationHint: 'Alle Mitglieder Ihrer Organisation können mitlesen und mitschreiben.',
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
      empty: 'Es gibt niemanden mehr einzuladen.',
      submit: 'Einladen',
      needsProjectAccess: 'Noch nicht im Projekt',
      needsProjectAccessHint:
        'Fügen Sie die Person zuerst dem Projekt hinzu. Einen Chat zu teilen gibt nie Zugriff auf das Projekt selbst.',
    },
    remove: 'Zugriff entziehen',
    removeConfirm: '{name} entfernen?',
    removeConfirmHint:
      'Der Zugriff endet sofort. Bereits geschriebene Beiträge bleiben im Chat erhalten.',
    leave: 'Chat verlassen',
    leaveConfirm: 'Diesen Chat verlassen?',
    leaveConfirmHint: 'Sie verlieren den Zugriff. Für alle anderen bleibt er bestehen.',
    escalate: 'Besitz übernehmen',
    escalateHint:
      'Als Projekt-Administrator können Sie den Besitz dieses Chats übernehmen. Das wird im Audit-Protokoll festgehalten.',
    errors: {
      lastOwner:
        'Dieser Chat braucht mindestens einen Eigentümer. Bestimmen Sie zuerst eine andere Person.',
      containerAccessRequired:
        'Diese Person ist noch kein Mitglied des Projekts. Fügen Sie sie zuerst dem Projekt hinzu.',
      organizationMembershipRequired: 'Diese Person ist kein Mitglied dieser Organisation.',
      rateLimited: 'Zu viele Änderungen an der Freigabe. Bitte warten Sie einige Minuten.',
      loadFailed: 'Die Freigabe-Einstellungen konnten nicht geladen werden.',
      saveFailed: 'Die Änderung konnte nicht gespeichert werden.',
      tryAgain: 'Erneut versuchen',
    },
    resourceTypes: {
      conversation: 'Chat',
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
      cannotInvite: 'Nur Eigentümer können neue Personen in diesen Chat holen.',
      resultsAria: 'Personen, die Sie erwähnen können',
      keyboardHint: '↑↓ auswählen · ↵ einfügen · esc schließen',
      badgeInChat: 'In diesem Chat',
      badgeAgent: 'Assistent',
      chipRemove: 'Erwähnung von {name} entfernen',
    },
    composerHint: 'Piloti antwortet nicht — {name} wird gefragt.',
    composerHintMany: 'Piloti antwortet nicht — {names} werden gefragt.',
    addressee: {
      toAgent: 'Geht an Piloti',
      toPerson: 'Geht an {name}',
      toPeople: 'Geht an {names}',
      toThread: 'Geht an den Chat',
      agentHint: '@Piloti eingeben, um Piloti zu fragen',
      ariaLabel: 'Empfänger dieser Nachricht: {label}',
    },
    notePlaceholder: 'Worum soll sich die Person kümmern? (optional)',
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
      released: 'Das Warten wurde aufgehoben.',
      askAgent: 'Stattdessen Piloti fragen',
    },
    handback: {
      offer: '{name} hat geantwortet — Piloti weiterarbeiten lassen?',
      offerMany: '{names} haben geantwortet — Piloti weiterarbeiten lassen?',
      action: 'Piloti weiterarbeiten lassen',
      dismiss: 'Nicht jetzt',
      prefill: 'bitte auf dieser Grundlage weiterarbeiten.',
    },
    errors: {
      inviteRequiresOwner:
        'Sie können nur Personen erwähnen, die bereits in diesem Chat sind. Bitten Sie einen Eigentümer, {name} einzuladen.',
      containerAccessRequired: '{name} ist kein Mitglied dieses Projekts.',
      rateLimited: 'Zu viele Erwähnungen. Bitte warten Sie einige Minuten.',
      tooMany: 'Sie können höchstens {count} Personen in einer Nachricht erwähnen.',
      releaseFailed: 'Das Warten konnte nicht aufgehoben werden.',
    },
  },

  inbox: {
    title: 'Postfach',
    navLabel: 'Postfach',
    badgeAria: '{count} Einträge brauchen Ihre Aufmerksamkeit',
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
      tryAgain: 'Erneut versuchen',
    },
    types: {
      mentionRequested: {
        title: '{actor} bittet um Ihre Einschätzung',
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
    composerBusy:
      'Piloti beantwortet gerade die Frage von {name} – Sie können senden, sobald das erledigt ist.',
    unreadDivider: 'Neu',
    authorYou: 'Sie',
    authorAria: 'Nachricht von {name}',
  },
}
