import type { en } from '../en'

/** projects namespace — populated during component i18n. */
export const projects: typeof en.projects = {
  list: {
    heading: 'Projekte',
    description:
      'Jedes Bauprojekt in einem Arbeitsbereich — Dokumente, Mitglieder und Chat, fundiert in den Dateien, der Büroablage und dem Baurecht.',
    loading: 'Projekte werden geladen…',
    searchPlaceholder: 'Projekte durchsuchen…',
    searchAria: 'Projekte nach Namen durchsuchen',
    resume: {
      heading: 'Weitermachen',
      fallbackHeading: 'Ihre Projekte',
    },
    more: {
      heading: 'Weitere Projekte',
    },
    results: {
      heading: 'Treffer',
    },
    noMatch: {
      title: 'Keine passenden Projekte',
      description: 'Kein Projektname entspricht Ihrer Suche.',
      clear: 'Suche löschen',
    },
    empty: {
      title: 'Starten Sie Ihr erstes Projekt',
      description:
        'Piloti ist der Arbeitsbereich, in dem ein Planungsbüro ein Bauprojekt führt. Legen Sie ein Projekt an, um Dateien, Mitglieder und Chat zusammenzubringen — und sprechen Sie mit Piloti über die Arbeit, fundiert in den Dateien, der Büroablage und dem österreichischen Baurecht.',
      action: 'Erstellen Sie Ihr erstes Projekt',
    },
    filter: {
      label: 'Projekte nach Status filtern',
      active: 'Aktiv',
      closed: 'Abgeschlossen',
      all: 'Alle',
    },
    noneInFilter: {
      active: 'Keine aktiven Projekte',
      closed: 'Keine abgeschlossenen Projekte',
      description: 'In dieser Ansicht gibt es keine Projekte.',
      showAll: 'Alle Projekte zeigen',
    },
  },
  section: {
    loading: 'Wird geladen…',
  },
  steckbrief: {
    heading: 'Steckbrief',
    description: 'Die Eckdaten, die bleiben, wenn das Projekt abgeschlossen ist: wo, wann und mit wem.',
    address: 'Adresse',
    addressMissing: 'Noch keine Adresse. Sie wird im Briefing erfasst.',
    period: 'Zeitraum',
    startedOn: 'Beginn',
    endedOn: 'Abschluss',
    open: 'offen',
    savePeriod: 'Zeitraum speichern',
    periodSaved: 'Zeitraum gespeichert.',
    periodInvalid: 'Der Abschluss liegt vor dem Beginn.',
    people: 'Personen',
    peopleDescription:
      'Alle, die am Projekt mitgearbeitet haben, auch ehemalige Mitarbeitende und externe Planer ohne Piloti-Konto. Nur Name, Funktion, Firma und Zeitraum; Piloti verwendet diese Angaben nicht in Antworten.',
    noPeople: 'Noch niemand eingetragen.',
    name: 'Name',
    function: 'Funktion',
    company: 'Firma',
    from: 'von',
    to: 'bis',
    account: 'Piloti-Konto',
    noAccount: 'Kein Konto',
    add: 'Person hinzufügen',
    save: 'Speichern',
    cancel: 'Abbrechen',
    edit: '{name} bearbeiten',
    remove: '{name} entfernen',
    removeTitle: 'Person entfernen?',
    removeDescription: '{name} wird mit allen Angaben endgültig aus dem Steckbrief gelöscht.',
    removeConfirm: 'Endgültig entfernen',
    removed: 'Person entfernt.',
    saved: 'Gespeichert.',
    error: 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.',
  },
  cleanup: {
    title: 'Projekt abschließen',
    intro:
      'Vor dem Abschluss kann Piloti ausmisten: Arbeitskopien, überholte Fassungen, Duplikate, temporäre Dateien und nie veröffentlichte Entwürfe. Sie entscheiden über jeden Eintrag.',
    loading: 'Piloti sieht die Dateien durch …',
    aiNotice:
      'KI-Vorschlag: erstellt von Piloti aus Dateinamen, Ordnern, Typen und den vorhandenen Zusammenfassungen, ohne den Inhalt der Dateien neu zu lesen. Prüfen Sie jeden Eintrag.',
    aiUnavailable:
      'Die KI-Prüfung war gerade nicht verfügbar. Die Vorschläge beruhen nur auf festen Regeln, etwa Sperrdateien, „Kopie von …" oder ältere Versionsnummern.',
    considered: '{count} Dateien geprüft, die Sie bearbeiten dürfen.',
    none: 'Piloti schlägt nichts zum Entfernen vor.',
    unavailable: 'Vorschläge konnten nicht geladen werden. Sie können das Projekt trotzdem abschließen.',
    binNote: 'Ausgewähltes kommt für 14 Tage in den Papierkorb und lässt sich von dort wiederherstellen.',
    aiChip: 'KI-Vorschlag',
    selectAll: 'Alle auswählen',
    confirm: '{count} in den Papierkorb und abschließen',
    closeOnly: 'Abschließen, ohne etwas zu entfernen',
    cancel: 'Abbrechen',
    removed: '{count} Dateien in den Papierkorb gelegt.',
    error: 'Das Ausmisten hat nicht geklappt; das Projekt ist noch offen.',
    /** Das Ausmisten ist gescheitert und ließ sich nicht ganz zurücknehmen (ADR-0090): wo nachsehen. */
    partial:
      'Das Ausmisten hat nicht geklappt und ließ sich nicht ganz zurücknehmen. Manche Dateien liegen womöglich noch in einem Ordner „{folders}“ in ihrem Ordner oder im Papierkorb. Das Projekt ist noch offen.',
    rules: {
      'lock-file': 'Sperrdatei eines Office-Programms',
      'temp-file': 'Temporäre Datei',
      'system-file': 'Systemdatei',
      'copy-name': 'Arbeitskopie (Name)',
      'old-name': 'Als alt markiert (Name)',
      'same-content': 'Gleicher Inhalt wie eine ältere Datei',
      'older-version': 'Ältere Fassung, eine neuere liegt im selben Ordner',
      'unpublished-draft': 'Entwurf von Piloti, nie veröffentlicht',
    },
  },
  lifecycle: {
    fileChip: '{name} · abgeschlossen',
    fileChipNoName: 'Abgeschlossenes Projekt',
    banner: {
      title: 'Abgeschlossenes Projekt · nur lesen',
      closedOn: 'Abgeschlossen am {date}.',
      body: 'Dateien, Ordner, Briefing und Projektgedächtnis sind schreibgeschützt. Fragen im Chat bleiben möglich.',
      outsider:
        'Sie sehen dieses Projekt, weil abgeschlossene Projekte für das ganze Büro lesbar sind. Ordner mit eigener Zugriffsliste bleiben für Sie verborgen.',
    },
    card: {
      heading: 'Projektstatus',
      activeDescription:
        'Schließen Sie das Projekt ab, wenn die Arbeit erledigt ist. Es bleibt vollständig erhalten und durchsuchbar, wird schreibgeschützt und ist für alle im Büro lesbar. Ordner mit eigener Zugriffsliste bleiben eingeschränkt.',
      closedDescription:
        'Das Projekt ist abgeschlossen und schreibgeschützt. Öffnen Sie es wieder, um Dateien, Ordner, Briefing oder Projektgedächtnis zu ändern. Danach sehen es wieder nur seine Mitglieder.',
      closedOn: 'Abgeschlossen am {date}',
      close: 'Projekt abschließen',
      reopen: 'Projekt wieder öffnen',
    },
    closeDialog: {
      description:
        'Danach kann niemand mehr Dateien, Ordner, das Briefing oder das Projektgedächtnis ändern, auch Tiefenrecherchen und Aufträge laufen nicht mehr. Alle im Büro können das Projekt lesen und dazu fragen. Sie können es jederzeit wieder öffnen. Ist im Steckbrief noch kein Abschluss eingetragen, wird der aktuelle Monat gesetzt.',
    },
    reopenDialog: {
      title: 'Projekt wieder öffnen?',
      description:
        'Das Projekt wird wieder bearbeitbar und ist danach nur noch für seine Mitglieder sichtbar.',
      confirm: 'Wieder öffnen',
    },
    toast: {
      closed: 'Projekt abgeschlossen.',
      reopened: 'Projekt wieder geöffnet.',
      error: 'Der Projektstatus konnte nicht geändert werden.',
    },
  },
  card: {
    summaryFallback:
      'Arbeitsbereich des Planungsbüros. Fügen Sie Dokumente und ein Briefing hinzu, damit Piloti aus diesem Projekt arbeiten kann.',
    status: {
      active: 'Aktiv',
      closed: 'Abgeschlossen',
    },
    lastActivity: 'Letzte Aktivität',
    yourActivity: 'Zuletzt hier gearbeitet',
    document: 'Dokument',
    documents: 'Dokumente',
    docLabel: '{count} {unit}',
    open: '{name} öffnen',
    settingsAria: 'Einstellungen für {name} öffnen',
  },
  archivCard: {
    title: 'Büroablage',
    subtitle:
      'Das organisationsweite Wissen Ihres Büros — geteilte Dokumente und bewährte Details, in jedem Projekt verfügbar.',
    aria: 'Büroablage der Organisation öffnen',
  },
  dialog: {
    newProject: 'Neues Projekt',
    title: 'Projekt erstellen',
    description:
      'Ein Projekt ist ein fokussierter Arbeitsbereich für ein Gebäude — dessen Dokumente, Mitglieder, Recherche und Chat-Kontext bleiben zusammen.',
  },
  form: {
    nameRequired: 'Der Projektname ist erforderlich.',
    nameTooLong: 'Der Projektname darf höchstens 255 Zeichen lang sein.',
    createError:
      'Wir konnten dieses Projekt gerade nicht erstellen. Bitte versuchen Sie es in einem Moment erneut.',
    nameLabel: 'Projektname',
    namePlaceholder: 'OIB-Brandschutzprüfung',
    templateLabel: 'Mit einer Vorlage beginnen',
    templates: {
      neubauWohnbau: { label: 'Neubau Wohnbau', name: 'Neubau Wohnbau' },
      betriebsbauBrandschutz: {
        label: 'Betriebsbau Brandschutz',
        name: 'Betriebsbau — Brandschutz',
      },
      sanierungBestand: { label: 'Sanierung Bestand', name: 'Sanierung Bestand' },
      oibBrandschutzAudit: { label: 'OIB Brandschutz-Audit', name: 'OIB Brandschutz-Audit' },
    },
    footnote:
      'Erstellen Sie einen Arbeitsbereich für Dokumente, Mitglieder und Chat, fundiert in den Projektdateien, der Büroablage und dem Baurecht.',
    submit: 'Projekt erstellen',
  },
  applicableStandards: {
    heading: 'Anwendbare Standards',
    description: 'OIB-Richtlinien, die auf Basis des Briefings für dieses Projekt relevant sind.',
    briefIncomplete:
      'Vervollständigen Sie das Projekt-Briefing für eine auf dieses Gebäude zugeschnittene Anwendbarkeit.',
    status: {
      required: 'Erforderlich',
      check: 'Prüfen',
      likely: 'Wahrscheinlich',
    },
    askQuestion: 'Welche Anforderungen von {code} ({title}) gelten für dieses Projekt?',
    source: 'Quelle',
    sourceAria: 'Quelle für {code} öffnen',
    sourceTitle: 'OIB-Quelle öffnen',
    askGrid: 'Piloti fragen',
    askGridAria: 'Piloti zu {code} fragen',
    askGridTitle: 'Piloti zu dieser Richtlinie fragen',
    emptyTitle: 'Noch keine anwendbaren Standards',
    emptyDescription:
      'Vervollständigen Sie das Projekt-Briefing, damit Piloti ermitteln kann, welche OIB-Richtlinien auf dieses Gebäude zutreffen.',
    disclaimer:
      'Nur zur Orientierung — keine Rechtsberatung. Prüfen Sie die Anwendbarkeit anhand der aktuellen Bauordnung und der zuständigen Behörde.',
  },
  dangerZone: {
    deleteSuccess:
      'Projekt gelöscht. Ein Organisationsadministrator kann es bis {date} wiederherstellen.',
    deleteSuccessNoDate:
      'Projekt gelöscht. Ein Organisationsadministrator kann es während der Kulanzfrist wiederherstellen.',
    deleteError: 'Projekt konnte nicht gelöscht werden.',
    heading: 'Gefahrenzone',
    description:
      'Das Löschen eines Projekts entfernt dessen Dokumente, Chats, Rechercheverlauf und Wissensdatenbank überall. Für eine begrenzte Kulanzfrist wiederherstellbar, danach endgültig gelöscht.',
    deleteButton: 'Projekt löschen',
    dialogTitle: 'Projekt löschen',
    dialogDescriptionBefore: 'Dies löscht ',
    dialogDescriptionAfter:
      ' und alle zugehörigen Daten in der gesamten App: Dateien, Chats, Rechercheläufe und die Wissensdatenbank.',
    confirmLabel: 'Projekt löschen',
    typeToConfirm: 'Zum Bestätigen {name} eingeben:',
  },
  recentlyDeleted: {
    restoreSuccess: '„{name}“ wiederhergestellt.',
    restoreError: 'Wiederherstellung fehlgeschlagen.',
    heading: 'Kürzlich gelöscht',
    purgeFailed: 'Löschung fehlgeschlagen — Support kontaktieren',
    purgeAfter: 'Endgültig gelöscht nach {date}',
    restore: 'Wiederherstellen',
    loadError: 'Kürzlich gelöschte Projekte konnten nicht geladen werden.',
    retry: 'Erneut versuchen',
  },
  researchRuns: {
    hint: {
      noReport: 'Kein Bericht',
    },
    status: {
      running: 'Läuft',
      submitted: 'Übermittelt',
      pending: 'Ausstehend',
      completed: 'Abgeschlossen',
      failed: 'Fehlgeschlagen',
      cancelled: 'Abgebrochen',
    },
    loadError: 'Rechercheläufe konnten nicht geladen werden',
    errorTitle: 'Rechercheläufe konnten nicht geladen werden',
    tryAgain: 'Erneut versuchen',
    emptyTitle: 'Noch keine Rechercheläufe',
    emptyDescription:
      'Tiefe Rechercheläufe erscheinen hier, sobald Sie Piloti im Chat eine komplexe Frage stellen — es durchsucht die OIB/RIS-Quellen und liefert einen belegten Bericht, den Sie erneut aufrufen können.',
    emptyAction: 'Einen Lauf im Chat starten',
    viewReport: 'Bericht ansehen',
    viewProgress: 'Fortschritt ansehen',
  },
  intake: {
    validation: {
      selectOption: 'Wählen Sie eine Option, um fortzufahren.',
      selectAtLeastOne: 'Wählen Sie mindestens eine Option.',
      chooseYesNo: 'Wählen Sie Ja oder Nein.',
      enterNumber: 'Geben Sie eine Zahl ein.',
      required: 'Dieses Feld ist erforderlich.',
    },
    errors: {
      loadFailed: 'Wir konnten die Projektfragen nicht laden.',
      saveConflict:
        'Dieses Briefing wurde an anderer Stelle geändert. Bitte aktualisieren Sie und versuchen Sie es erneut.',
      saveFailed:
        'Wir konnten das Projekt-Briefing nicht speichern. Bitte versuchen Sie es erneut.',
    },
    tryAgain: 'Erneut versuchen',
    conflictReload: 'Aktualisieren',
    draftSaved: 'Entwurf gespeichert',
    salvage: {
      partial:
        'Teile des bestehenden Projekt-Briefings konnten nicht geladen werden und werden beim Speichern ersetzt.',
      full: 'Das bestehende Projekt-Briefing konnte nicht geladen werden. Ihre Eingaben ersetzen es beim Speichern.',
    },
    eyebrowEdit: 'Projekt-Briefing bearbeiten',
    eyebrowCreate: 'Projekteinrichtung',
    titleFallback: 'Erzählen Sie Piloti von diesem Projekt',
    subtitle:
      'Etwa 2 Minuten. Piloti nutzt dieses Briefing, um jede Antwort zu fundieren — und um zu zeigen, welche OIB-Richtlinien auf dieses Gebäude zutreffen.',
    moduleNav: 'Module',
    moduleNavAria: 'Wizard-Module',
    schnellstart: 'Schnellstart',
    schnellstartOn:
      'Nur Kernfragen. Alles Übrige wird als „offen“ übernommen und in der Zusammenfassung als offener Punkt gelistet.',
    schnellstartOff: 'Alle Fragen dieses Moduls.',
    skipRest: 'Rest überspringen',
    skipRestDone: 'Als offen übernommen',
    moduleProgress: '{answered} von {total}',
    moduleDone: 'vollständig',
    coreBadge: 'Kernfrage',
    hiddenByQuickstart:
      '{count, plural, one {# weitere Frage} other {# weitere Fragen}} im Schnellstart ausgeblendet',
    showAllHere: 'Hier alle anzeigen',
    progressAria: 'Fortschritt',
    reviewTitle: 'Prüfen & bestätigen',
    reviewStep: 'Prüfen',
    reviewDescription:
      'Bestätigen Sie, was Piloti über dieses Projekt verstanden hat, bevor Sie speichern.',
    back: 'Zurück',
    stepCounter: 'Schritt {current} von {total}',
    saving: 'Wird gespeichert…',
    saveSuccess:
      'Projektprofil gespeichert — {count, plural, one {# Angabe} other {# Angaben}} erfasst',
    saveChanges: 'Änderungen speichern',
    saveAndSee: 'Speichern & meine Standards ansehen',
    next: 'Weiter',
    unknownsTitle: 'Piloti wird weiterhin nicht wissen',
    unknownsHint:
      'Sie können jetzt speichern und dies später ergänzen — Piloti markiert diese Punkte als offene Fragen.',
    edit: 'Bearbeiten',
    optional: '(optional)',
    yes: 'Ja',
    no: 'Nein',
    open: 'noch offen',
    why: 'Warum fragen wir das?',
    selectPlaceholder: 'Auswählen…',
    mode: {
      aria: 'Antwortmodus',
      wert: 'Wert',
      geschaetzt: 'Schätzung',
      offen: 'noch offen',
    },
    bauwerk: {
      nameAria: 'Name des Bauwerks',
      remove: 'entfernen',
      add: 'Bauwerk hinzufügen',
    },
    upload: {
      hint: 'Dokument im Dateien-Tab ablegen',
    },
    derived: {
      badge: 'aus dem Profil',
    },
    classification: {
      title: 'Wozu dieses Profil da ist',
      description:
        'Die Gebäudeklasse steht hier, wenn sie bestätigt ist. Fehlt sie, fragt Piloti im Chat nach, bevor eine Antwort fällt, die an der Klasse hängt. Das Profil ist die Arbeitsgrundlage dafür, welche Regeln gelten und was noch offen ist.',
    },
    consistency: {
      checking: 'Angaben werden geprüft…',
      title: 'Ein paar Dinge zum Prüfen',
      subtitle:
        'Einige Angaben passen möglicherweise nicht zusammen. Bitte prüfen — oder trotzdem speichern.',
      severity: {
        warning: 'Zum Nachsehen',
        inconsistency: 'Möglicher Widerspruch',
      },
      revise: 'Überarbeiten',
      proceed: 'Trotzdem speichern',
      rules: {
        fossilNeubauConflict:
          'Eine Gas-Wärmeversorgung für {bauwerk} widerspricht einem Neubau — das Erneuerbare-Wärme-Gesetz verbietet fossile Systeme im Neubau.',
      },
    },
  },
  memory: {
    kinds: {
      decision: 'Entscheidungen',
      constraint: 'Einschränkungen',
      open_question: 'Offene Fragen',
      derived_fact: 'Abgeleitete Fakten',
      preference: 'Präferenzen',
    },
    kindSingular: {
      decision: 'Entscheidung',
      constraint: 'Einschränkung',
      open_question: 'Offene Frage',
      derived_fact: 'Abgeleiteter Fakt',
      preference: 'Präferenz',
    },
    verification: {
      unverified: 'nicht verifiziert',
      source_grounded: 'quellenbasiert',
      user_confirmed: 'von Ihnen bestätigt',
    },
    provenance: {
      user: 'von Ihnen hinzugefügt',
      grid: 'von Piloti notiert',
    },
    conflict: {
      badge: 'Widerspricht einer bestätigten Notiz',
      title:
        'Widerspricht „{note}“ — Piloti durfte diese Notiz nicht ersetzen. Bestätigen oder entfernen Sie einen der beiden Einträge.',
      titleUnknown: 'Widerspricht einer bestätigten Notiz, die nicht mehr in dieser Liste steht.',
    },
    restricted: {
      badge: 'Eingeschränkt',
      title:
        'Stammt aus eingeschränkten Ordnern ({folders}). Nur wer für alle diese Ordner freigegeben ist, sieht diese Notiz, und nur deren Chats erhalten sie.',
      titleUnknown:
        'Stammt aus eingeschränkten Ordnern. Nur wer für alle diese Ordner freigegeben ist, sieht diese Notiz.',
    },
    time: {
      justNow: 'gerade eben',
      minutesAgo: 'vor {count} Min.',
      hoursAgo: 'vor {count} Std.',
      daysAgo: 'vor {count} T.',
    },
    errors: {
      requestFailed: 'Anfrage fehlgeschlagen ({status})',
      loadFailed: 'Projektspeicher konnte nicht geladen werden',
      updateFailed: 'Aktualisierung fehlgeschlagen',
      deleteFailed: 'Löschen fehlgeschlagen',
      addFailed: 'Speichereintrag konnte nicht hinzugefügt werden',
      title: 'Beim Projektspeicher ist etwas schiefgelaufen',
    },
    added: 'Eintrag hinzugefügt.',
    updated: 'Eintrag aktualisiert.',
    deleted: 'Eintrag entfernt.',
    heading: 'Projektspeicher',
    description: 'Was Piloti über dieses Projekt gelernt hat — bearbeitbar.',
    addMemory: 'Eintrag hinzufügen',
    kindAria: 'Art des Eintrags',
    scopeAria: 'Geltungsbereich des Eintrags',
    scopeProject: 'Dieses Projekt',
    scopeOrganization: 'Alle meine Projekte',
    addPlaceholder: 'Eine prägnante, in sich geschlossene Erkenntnis zu diesem Projekt…',
    cancel: 'Abbrechen',
    add: 'Hinzufügen',
    tryAgain: 'Erneut versuchen',
    emptyTitle: 'Noch nichts erfasst',
    emptyDescription:
      'Piloti hat zu diesem Projekt noch nichts erfasst. Das geschieht, während Sie chatten — oder fügen Sie selbst etwas hinzu.',
    orgWide: 'organisationsweit',
    confidence: 'Konfidenz {confidence}',
    save: 'Speichern',
    pinned: 'Angeheftet',
    remove: 'Entfernen',
    removeConfirm: 'Entfernen?',
    cancelRemovalAria: 'Entfernen abbrechen',
    cancelTitle: 'Abbrechen',
    unpin: 'Lösen',
    pin: 'Anheften',
    unpinTitle: 'Lösen — nicht mehr immer einbeziehen',
    pinTitle: 'Anheften — immer in den Kontext einbeziehen',
    confirm: 'Bestätigen',
    confirmTitle: 'Bestätigen — als korrekt markieren',
    edit: 'Bearbeiten',
    editTitle: 'Bearbeiten',
    removeAria: 'Entfernen',
    removeTitle: 'Aus dem Speicher entfernen',
  },
  overview: {
    workspaceCreated: 'Projekt-Arbeitsbereich · erstellt {date}',
    workspace: 'Projekt-Arbeitsbereich',
    askGrid: 'Piloti fragen',
    uploadFiles: 'Dateien hochladen',
    rename: {
      action: 'Projekt umbenennen',
      dialogTitle: 'Projekt umbenennen',
      dialogDescription:
        'Geben Sie diesem Projekt einen klaren Namen. Er ist zugleich die zur Bestätigung der Löschung erforderliche Eingabe.',
      nameLabel: 'Projektname',
      save: 'Speichern',
      saving: 'Wird gespeichert…',
      cancel: 'Abbrechen',
      success: 'Projekt umbenannt.',
      error: 'Das Projekt konnte nicht umbenannt werden. Bitte versuchen Sie es erneut.',
      forbidden: 'Sie haben keine Berechtigung, dieses Projekt umzubenennen.',
    },
    brief: {
      heading: 'Projekt-Briefing',
      edit: 'Briefing bearbeiten',
      summaryGenerate: 'Zusammenfassung erstellen',
      summaryRegenerate: 'Neu erstellen',
      summaryGenerating: 'Wird erstellt…',
      summaryWriting: 'Piloti schreibt die Projekt-Zusammenfassung…',
      summarySuccess: 'Zusammenfassung aktualisiert.',
      summaryError:
        'Die Zusammenfassung konnte nicht erstellt werden. Bitte versuchen Sie es erneut.',
      summaryLlmNotConfigured:
        'Die Erstellung der Zusammenfassung ist nicht verfügbar — es ist kein Sprachmodell konfiguriert. Bitten Sie eine Administratorin, eines einzurichten.',
      summaryForbidden: 'Sie haben keine Berechtigung, die Zusammenfassung zu erstellen.',
      summaryUnavailable: 'Zusammenfassung derzeit nicht verfügbar.',
      summaryUnavailableLlm: 'KI-Dienst nicht konfiguriert — bitte Administrator kontaktieren.',
      captured: '{answered} von {total} erfasst',
      focus: 'Fokus',
      startedNoDetailsBefore:
        'Das Briefing wurde begonnen, aber es sind noch keine Details erfasst. ',
      completeBrief: 'Briefing vervollständigen',
      startedNoDetailsAfter: ', damit Piloti seine Antworten fundieren kann.',
      missingHeading: 'Piloti weiß noch nicht',
      assumptionsHeading:
        'Von Piloti vorgeschlagen — bestätigen, um es als Projektfakt zu übernehmen',
      assumptionConfirm: 'Bestätigen',
      assumptionDismiss: 'Verwerfen',
      assumptionError: 'Das Briefing konnte nicht aktualisiert werden. Bitte erneut versuchen.',
      assumptionForbidden: 'Sie haben keine Berechtigung, das Briefing zu aktualisieren.',
      assumptionConflict:
        'Dieses Briefing wurde an anderer Stelle geändert. Bitte aktualisieren Sie und versuchen Sie es erneut.',
      provenance: {
        onboarding: 'Im Intake-Assistenten erfasst',
        user_confirmed: 'Von Ihnen bestätigt',
        admin_edit: 'Von einer Administratorin bearbeitet',
      },
      emptyTitle: 'Projekt-Briefing einrichten',
      emptyDescription:
        'Erzählen Sie Piloti von diesem Gebäude — Nutzung, Klasse, Geschosse und Ziele. Ein vollständiges Briefing lässt Piloti jede Antwort im realen Kontext Ihres Projekts fundieren.',
      emptyAction: 'Projektkontext einrichten',
    },
    stats: {
      files: 'Dateien',
      totalSize: 'Gesamtgröße',
      knowledgeBase: 'Wissensdatenbank',
    },
    recentFiles: {
      heading: 'Zuletzt verwendete Dateien',
      viewAll: 'Alle ansehen',
      emptyTitle: 'Noch keine Dateien',
      emptyDescription:
        'Laden Sie Baudokumente hoch — Pläne, Berichte, Auszüge der Bauordnung — damit Piloti Ihr Projekt in seinen Antworten zitieren kann.',
      emptyAction: 'Dateien hochladen',
    },
  },
}
