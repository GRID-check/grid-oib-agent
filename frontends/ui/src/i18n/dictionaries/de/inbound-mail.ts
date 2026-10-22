import type { en } from '../en'

/**
 * inboundMail namespace: der E-Mail-Eingang (ADR-0134, DECISION §9).
 *
 * Ein Wort je Begriff (DECISION §3): „E-Mail-Eingang“ ist der Ort, „ablegen“
 * bringt einen Teil ins Projekt, „verwerfen“ sagt Nein zur ganzen E-Mail,
 * „wiederherstellen“ macht beides sieben Tage lang rückgängig, der
 * „E-Mail-Verlauf“ ist das Dokument der Korrespondenz, und seine Stände sind
 * „Fassung N“. Die Absenderangabe nennt eine Domain, nie eine Person. Nie
 * „Projektadresse“ (dort steht das Gebäude), nie „Durchsicht“, nie
 * „Nachricht“ für eine E-Mail, nie „Abgelegt“ als Zustand einer E-Mail.
 */
export const inboundMail: typeof en.inboundMail = {
  title: 'E-Mail-Eingang',
  subtitle: 'E-Mails an die E-Mail-Adresse des Projekts warten hier, bis jemand sie ablegt.',
  back: 'Dateien',
  addressButton: 'Adresse',
  noSelection: 'Wählen Sie eine E-Mail, um zu sehen, was sie enthält.',

  filters: {
    label: 'Anzeigen',
    waiting: 'Wartet auf Ablage',
    handled: 'Bearbeitet',
    outcome: {
      label: 'Ergebnis',
      all: 'Alle',
      filed: 'Abgelegt',
      dismissed: 'Verworfen',
      expired: 'Abgelaufen',
    },
  },

  empty: {
    neverTitle: 'Noch keine E-Mails an dieses Projekt',
    neverText:
      'Leiten Sie E-Mails mit Unterlagen an die E-Mail-Adresse des Projekts weiter. Sie warten hier, bis jemand sie ablegt. Ins Projekt kommt nur, was eine Person bestätigt.',
    doneTitle: 'Nichts wartet auf Ablage',
    doneText: 'Neue E-Mails an die E-Mail-Adresse des Projekts erscheinen hier.',
    showHandled: 'Bearbeitete anzeigen',
    handledTitle: 'Noch nichts bearbeitet',
    handledText: 'Abgelegte, verworfene und abgelaufene E-Mails stehen hier noch sieben Tage nach ihrem letzten Teil.',
  },

  loadError: 'Der E-Mail-Eingang konnte nicht geladen werden.',
  detailLoadError: 'Diese E-Mail konnte nicht geladen werden.',
  retry: 'Erneut versuchen',
  loadMore: 'Weitere laden',

  closed: {
    title: 'Projekt ist abgeschlossen – wieder öffnen, um abzulegen',
    text: 'E-Mails kommen weiterhin an und lassen sich verwerfen.',
    dismiss: 'Hinweis ausblenden',
  },

  row: {
    noSubject: '(ohne Betreff)',
    attachments: '{count, plural, one {# Anhang} other {# Anhänge}}',
    automatic: 'Automatisch',
    thread: 'E-Mail-Verlauf „{name}“ · wird Fassung {version}',
    select: '„{subject}“ auswählen',
    restorableUntil: 'wiederherstellbar bis {date}',
    outcome: {
      filed: '{count, plural, one {# Teil abgelegt} other {# Teile abgelegt}}',
      dismissed: '{count, plural, one {# Teil verworfen} other {# Teile verworfen}}',
      expired: '{count, plural, one {# Teil abgelaufen} other {# Teile abgelaufen}}',
    },
    textFollowed: 'Text dem E-Mail-Verlauf angefügt (Verlauf folgen)',
  },

  group: {
    thread: 'E-Mail-Verlauf „{name}“ · {count, plural, one {# neue E-Mail} other {# neue E-Mails}}',
    threadAction: '{count} E-Mails in E-Mail-Verlauf „{name}“ ablegen (wird Fassung {version})',
    quiet: 'Domain nicht bestätigt oder automatisch ({count})',
    quietHint: 'Sie stehen vollständig hier. Piloti macht für sie keine Vorschläge, und von selbst wird nichts davon abgelegt.',
  },

  trust: {
    verified: 'Domain bestätigt: {domain}',
    bccOwn: 'Ihre eigene E-Mail (Bcc)',
    memberUnverified: 'Mitglied · Domain nicht bestätigt',
    impersonation: 'Gibt sich als {name} aus',
    unverified: 'Domain nicht bestätigt',
    explain: {
      verified:
        'Die Domain des Absenders hat diese E-Mail signiert (DKIM). Das belegt die Domain, nicht die Person, die sie geschrieben hat.',
      bccOwn: 'Eine Kopie einer E-Mail, die Sie an andere geschickt haben, mit diesem Projekt in Bcc. Ihre Domain hat sie signiert.',
      memberUnverified:
        'Die Adresse gehört einem Mitglied, aber dessen Domain hat diese E-Mail nicht signiert. Zum Ablegen braucht es Ihre Bestätigung.',
      impersonation:
        'Die Signatur dieser E-Mail ist ungültig, oder die Richtlinie der Domain hat sie abgelehnt. Möglicherweise verwendet jemand diesen Namen. Zum Ablegen braucht es Ihre Bestätigung.',
      unverified:
        'Die Domain des Absenders hat diese E-Mail nicht signiert. Piloti schlägt dafür nichts vor und wählt keinen E-Mail-Verlauf vor.',
    },
  },

  flags: {
    not_addressed_to_project: 'An andere Empfänger adressiert',
    stale_date: 'Datum liegt mehr als 7 Tage vor dem Eingang',
    date_out_of_range: 'Datum liegt außerhalb des erwarteten Zeitraums; es gilt der Eingang',
    already_filed: 'Liegt schon in einem E-Mail-Verlauf',
  },

  header: {
    from: 'Von {name} ‹{address}›',
    received: 'Eingegangen {time}',
    sent: 'Gesendet {time}',
    to: 'An',
    cc: 'Cc',
    replyTo: 'Antwort an',
    participants: 'Empfänger',
    forwardedFrom: 'Ursprünglich von {who} · nicht geprüft',
    forwardedExplain: 'Aus dem weitergeleiteten Text gelesen. Niemand hat diese Angabe geprüft.',
    original: 'Original (.eml) herunterladen',
    originalHint: 'Öffnet sich im Mailprogramm; Bilder von außen werden dort geladen.',
    originalNotClean: 'Das Original enthält Schadsoftware und kann nicht heruntergeladen werden.',
    originalScanning: 'Das Original wird auf Schadsoftware geprüft.',
    expires: 'Wartet bis {date}',
  },

  findings: {
    title: 'Die Inhaltsprüfung hat im Text etwas gefunden: {kinds}',
    kinds: {
      iban: 'IBAN',
      at_svnr: 'Sozialversicherungsnummer',
      credit_card: 'Kreditkartennummer',
      term: 'ein Begriff der Inhaltsprüfung',
    },
    choiceLabel: 'Wie der Text abgelegt wird',
    masked: 'Unkenntlich ablegen',
    maskedHint: 'Die Fundstellen werden im E-Mail-Verlauf unkenntlich gemacht. Das Original bleibt unverändert.',
    own_thread: 'Als eigenen E-Mail-Verlauf ablegen',
    own_threadHint: 'Der ganze Text kommt in einen neuen E-Mail-Verlauf, getrennt vom bestehenden.',
    full: 'Ungekürzt in den E-Mail-Verlauf',
    fullHint: 'Der ganze E-Mail-Verlauf wird zurückgehalten, bis jemand ihn prüft.',
  },

  text: {
    label: 'E-Mail-Text',
    loading: 'Text wird geladen …',
    loadError: 'Der Text konnte nicht geladen werden.',
    showAll: 'Ganze E-Mail anzeigen',
    showLess: 'Weniger anzeigen',
    showQuoted: 'Zitierten Text anzeigen ({count})',
    hideQuoted: 'Zitierten Text ausblenden',
    masked: 'Was die Inhaltsprüfung gefunden hat, ist unkenntlich gemacht.',
    truncated: 'Der Text ist gekürzt. Das Original enthält ihn vollständig.',
    unreadable: 'Der Text dieser E-Mail konnte nicht gelesen werden. Das Original enthält ihn.',
    empty: 'Diese E-Mail hat keinen eigenen Text.',
    calendar: 'Termin: {summary}',
    calendarWhen: '{start} – {end}',
    calendarAllDay: '{date}, ganztägig',
    calendarLocation: 'Ort: {location}',
    linkTitle: 'Link auf {domain}, als Text gezeigt und nicht geöffnet',
  },

  message: {
    label: 'E-Mail-Text',
    file: 'E-Mail-Text ablegen',
    append: 'In E-Mail-Verlauf „{name}“ ablegen (wird Fassung {version})',
    create: 'Als neuen E-Mail-Verlauf ablegen',
    nameLabel: 'Name des E-Mail-Verlaufs',
    folderLabel: 'Ordner',
    full: 'Dieser E-Mail-Verlauf ist voll. Legen Sie den Text als neuen E-Mail-Verlauf ab.',
    hidden:
      '{count, plural, one {# möglicher E-Mail-Verlauf in einem Ordner, den Sie nicht sehen} other {# mögliche E-Mail-Verläufe in Ordnern, die Sie nicht sehen}}',
    acknowledge: 'Gehört trotzdem zu diesem E-Mail-Verlauf',
    alreadyFiled: 'Dieser Text liegt schon in einem E-Mail-Verlauf.',
    unreadable: 'Der Text konnte nicht gelesen werden und lässt sich daher nicht ablegen. Das Original enthält ihn.',
    followed: 'Text dem E-Mail-Verlauf angefügt (Verlauf folgen)',
    filed: 'In einem E-Mail-Verlauf abgelegt',
    openThread: 'Öffnen',
    nameStop: 'Namensprüfung: „{terms}“',
    releaseName: 'Trotzdem ablegen',
    blocks: {
      weak_match: 'Gehört vermutlich dazu: nur der Betreff stimmt überein',
      sender_not_verified: 'Verweist auf den E-Mail-Verlauf, aber die Domain des Absenders ist nicht bestätigt',
      header_not_signed: 'Der Verweis auf den E-Mail-Verlauf ist nicht von der Domain signiert',
      not_addressed_to_project: 'Die E-Mail ist an andere Empfänger adressiert',
      stale_date: 'Das Datum der E-Mail liegt mehr als 7 Tage zurück',
      date_out_of_range: 'Das Datum der E-Mail ist nicht plausibel',
    },
  },

  attachments: {
    label: 'Anhänge',
    unnamed: 'Anhang {position}',
    file: '{name} ablegen',
    facts: '{type} · {size}',
    open: 'Öffnen',
    change: 'Ändern',
    preview: '{name} ansehen',
    status: {
      scan_pending: 'Wird auf Schadsoftware geprüft …',
      scan_failed: 'Prüfung fehlgeschlagen, wird wiederholt',
      scan_infected: 'Schadsoftware gefunden · lässt sich nicht ablegen',
      clean: 'Auf Schadsoftware geprüft',
      not_offered: 'Dateityp wird in diesem Büro nicht abgelegt · im Original enthalten',
      filing: 'Wird abgelegt …',
      filed: 'In Dateien abgelegt',
      dismissed: 'Verworfen',
      expired: 'Abgelaufen',
    },
    notes: {
      duplicate: 'Liegt schon im Projekt: {path}',
      revision: 'wird Fassung {version} von {name}',
      revisionUnverified: 'könnte Fassung {version} von {name} sein · Domain nicht bestätigt',
      revisionHidden: 'Eine mögliche frühere Fassung liegt in einem Ordner, den Sie nicht sehen',
      nameStop: 'Namensprüfung: „{terms}“',
      releaseName: 'Trotzdem ablegen',
      macro: 'Enthält Makros. Öffnen Sie die Datei nur, wenn Sie dem Absender vertrauen.',
      type_mismatch: 'Dateiname und Inhalt passen nicht zusammen.',
      acknowledgeRisk: 'Ich habe die Warnung gelesen. Trotzdem ablegen',
      acknowledgeRevision: 'Trotzdem als nächste Fassung ablegen',
      encrypted: 'Verschlüsselt – Piloti kann den Inhalt nicht lesen',
      forwarded_inner: 'Aus einer weitergeleiteten E-Mail',
      image_in_mail: 'Bild in der E-Mail',
      lastFailure: 'Konnte nicht abgelegt werden: {reason}',
    },
    notStaged: {
      tnef: '{name} · Outlook-eigener Anhang, nicht geöffnet · im Original enthalten',
      encrypted: '{name} · verschlüsselt · im Original enthalten',
      archive: '{name} · Archivdatei, nicht entpackt · im Original enthalten',
      calendar: '{name} · Termin, im Text angezeigt',
      size: '{name} · zu groß zum Ablegen · im Original enthalten',
      limit: '{name} · über der Anzahl an Anhängen, die eine E-Mail haben darf · im Original enthalten',
      layoutImages: '{count, plural, one {# Bild aus der Signatur} other {# Bilder aus der Signatur}} · im Original enthalten',
    },
  },

  suggestion: {
    label: 'Vorschlag von Piloti',
    newFolder: 'neu',
    noFolder: 'Kein Vorschlag – wählen Sie einen Ordner.',
    pending: 'Piloti liest noch …',
    none: 'Für nicht bestätigte oder automatische E-Mails gibt es keinen Vorschlag.',
    root: 'Dateien (oberste Ebene)',
    documentType: 'Dokumentart',
  },

  target: {
    title: 'Wohin {name} kommt',
    name: 'Name',
    folder: 'Ordner',
    chooseFolder: 'Ordner wählen',
    folderPickerTitle: 'Ablegen in',
    folderNote: 'Nur Ordner, in die Sie ablegen dürfen.',
    documentType: 'Dokumentart',
    noDocumentType: 'Keine',
    revision: 'Fassung',
    newDocument: 'Ein neues Dokument',
    revisionOf: 'Fassung {version} von {name}',
    apply: 'Übernehmen',
    cancel: 'Abbrechen',
  },

  bar: {
    dismiss: 'Verwerfen',
    dismissBusy: 'Wird verworfen …',
    fileBoth: '{count, plural, one {# Datei und den E-Mail-Text ablegen} other {# Dateien und den E-Mail-Text ablegen}}',
    fileFiles: '{count, plural, one {# Datei ablegen} other {# Dateien ablegen}}',
    fileText: 'E-Mail-Text ablegen',
    fileThread: 'In E-Mail-Verlauf „{name}“ ablegen (wird Fassung {version})',
    fileNothing: 'Nichts ablegen',
    busy: 'Wird abgelegt …',
    acknowledgeSender: 'Domain nicht bestätigt. Trotzdem ablegen',
    originalErased: 'Das Original der E-Mail wird nach der Ablage gelöscht',
    blockers: {
      project_closed: 'Projekt ist abgeschlossen – wieder öffnen, um abzulegen',
      folder_missing: '{count, plural, one {Wählen Sie für # Anhang einen Ordner.} other {Wählen Sie für # Anhänge einen Ordner.}}',
      name_stop: '{count, plural, one {Bestätigen Sie die Namensprüfung bei # Anhang.} other {Bestätigen Sie die Namensprüfung bei # Anhängen.}}',
      risk: '{count, plural, one {Bestätigen Sie die Warnung bei # Teil.} other {Bestätigen Sie die Warnung bei # Teilen.}}',
      thread_name_missing: 'Geben Sie dem neuen E-Mail-Verlauf einen Namen.',
    },
  },

  state: {
    filing: 'Wird abgelegt …',
    decidedByOther: 'Jemand anderes hat diese E-Mail inzwischen bearbeitet.',
    partialFailure: '{failed} von {total} Dateien konnten nicht abgelegt werden.',
    partialFailureAll: '{failed, plural, one {Die Datei konnte nicht abgelegt werden.} other {Keine der # Dateien konnte abgelegt werden.}}',
    partialFailureHint: 'Sie warten wieder hier. Wählen Sie einen anderen Namen oder Ordner und legen Sie sie erneut ab.',
    quotaFull: 'Der Speicher des Büros ist voll. Es wurde nichts abgelegt; die E-Mail wartet weiter.',
    expired: 'Abgelaufen · wiederherstellbar bis {date}',
    dismissed: 'Verworfen · wiederherstellbar bis {date}',
    restore: 'Wiederherstellen',
    restoreBusy: 'Wird wiederhergestellt …',
    settled: 'Alles an dieser E-Mail ist bearbeitet.',
    filedOutcome: 'Ins Projekt abgelegt',
  },

  toast: {
    filed: '{count, plural, one {# Datei abgelegt} other {# Dateien abgelegt}}',
    filedIn: '{count, plural, one {# Datei in „{folder}“ abgelegt} other {# Dateien in „{folder}“ abgelegt}}',
    textFiled: 'Text in E-Mail-Verlauf „{name}“ abgelegt',
    textFiledNew: 'Text als neuer E-Mail-Verlauf abgelegt',
    filing: 'Wird abgelegt …',
    view: 'Ansehen',
    dismissed: 'E-Mail verworfen',
    dismissedMany: '{count, plural, one {# E-Mail verworfen} other {# E-Mails verworfen}}',
    undo: 'Rückgängig',
    restored: 'E-Mail wiederhergestellt',
    bulkFiled: '{count, plural, one {# E-Mail wird abgelegt} other {# E-Mails werden abgelegt}}',
    failed: 'Das hat nicht geklappt. Bitte erneut versuchen.',
  },

  bulk: {
    selected: '{count} ausgewählt',
    clear: 'Auswahl aufheben',
    fileSuggested: 'Wie vorgeschlagen ablegen',
    fileSuggestedBusy: 'Wird abgelegt …',
    dismiss: 'Verwerfen',
    checking: 'Auswahl wird geprüft …',
    blocked: {
      not_waiting: 'Ein Teil der Auswahl ist schon bearbeitet.',
      project_closed: 'Projekt ist abgeschlossen – wieder öffnen, um abzulegen.',
      sender:
        '{count, plural, one {Bei # E-Mail muss der Absender bestätigt werden. Öffnen Sie sie einzeln.} other {Bei # E-Mails muss der Absender bestätigt werden. Öffnen Sie sie einzeln.}}',
      no_thread:
        '{count, plural, one {# E-Mail hat keinen E-Mail-Verlauf, in den sie gehört. Öffnen Sie sie einzeln.} other {# E-Mails haben keinen E-Mail-Verlauf, in den sie gehören. Öffnen Sie sie einzeln.}}',
      needs_person:
        '{count, plural, one {# E-Mail braucht eine Entscheidung von Ihnen. Öffnen Sie sie einzeln.} other {# E-Mails brauchen eine Entscheidung von Ihnen. Öffnen Sie sie einzeln.}}',
      scanning:
        '{count, plural, one {# E-Mail wird noch auf Schadsoftware geprüft.} other {# E-Mails werden noch auf Schadsoftware geprüft.}}',
      folder_missing: '{count, plural, one {Bei # E-Mail fehlt ein Ordner.} other {Bei # E-Mails fehlt ein Ordner.}}',
      too_many: 'Höchstens {max} E-Mails lassen sich auf einmal ablegen.',
    },
    confirmTitle: '{count, plural, one {# E-Mail wie vorgeschlagen ablegen?} other {# E-Mails wie vorgeschlagen ablegen?}}',
    confirmSummary: '{files, plural, one {# Datei} other {# Dateien}} und {texts, plural, one {# E-Mail-Text} other {# E-Mail-Texte}}',
    destination: {
      folder: 'In „{label}“: {count}',
      root: 'In Dateien (oberste Ebene): {count}',
      new_folder: 'In den neuen Ordner „{label}“: {count}',
      thread: 'In E-Mail-Verlauf „{label}“: {count}',
      new_thread: 'Als neuer E-Mail-Verlauf „{label}“',
    },
    confirm: 'Ablegen',
    cancel: 'Abbrechen',
    dismissTitle: '{count, plural, one {# E-Mail verwerfen?} other {# E-Mails verwerfen?}}',
    dismissText: 'Verworfene E-Mails lassen sich 7 Tage lang wiederherstellen.',
    dismissConfirm: 'Verwerfen',
  },

  refusals: {
    stale: 'Diese E-Mail hat sich inzwischen geändert. Sie wurde neu geladen; bitte prüfen und erneut entscheiden.',
    part_not_waiting: 'Ein Teil dieser E-Mail wartet nicht mehr. Sie wurde neu geladen.',
    part_unknown: 'Ein Teil dieser E-Mail ist nicht mehr da. Sie wurde neu geladen.',
    scan_not_clean: 'Ein Anhang hat keine saubere Prüfung auf Schadsoftware.',
    type_not_accepted: 'Dieser Dateityp wird in diesem Büro nicht abgelegt.',
    name_stop:
      'Die Namensprüfung hat einen Namen angehalten. Bestätigen Sie ihn mit „Trotzdem ablegen“ oder wählen Sie einen anderen Namen.',
    risk_not_acknowledged: 'Bestätigen Sie die Warnung vor dem Ablegen.',
    sender_not_acknowledged: 'Bestätigen Sie die nicht bestätigte Domain vor dem Ablegen.',
    acknowledgement_in_bulk: 'Diese E-Mail braucht Ihre Bestätigung. Öffnen Sie sie einzeln.',
    card_carries_acknowledgement: 'Dafür braucht es eine Bestätigung, die nur Sie geben können. Öffnen Sie die E-Mail.',
    name_taken:
      'Ein Dokument dieses Namens liegt schon im Projekt. Legen Sie die Datei als seine nächste Fassung ab oder benennen Sie sie um.',
    target_unknown: 'Der Ordner oder E-Mail-Verlauf ist nicht mehr da.',
    thread_full: 'Der E-Mail-Verlauf ist voll. Legen Sie den Text als neuen E-Mail-Verlauf ab.',
    unreadable: 'Der Text konnte nicht gelesen werden und lässt sich daher nicht ablegen.',
    nothing_to_mask: 'In diesem Text gibt es nichts unkenntlich zu machen.',
    not_restorable: 'Diese E-Mail lässt sich nicht mehr wiederherstellen.',
    gone: 'Die Datei ist nicht mehr da.',
    original_not_clean: 'Das Original hat die Prüfung auf Schadsoftware nicht bestanden und lässt sich nicht herunterladen.',
    mail_not_received_here: 'Diese Installation empfängt keine E-Mails.',
    unknown: 'Das hat nicht geklappt. Bitte erneut versuchen.',
  },

  failures: {
    screened: 'von der Inhaltsprüfung zurückgehalten',
    type: 'der Dateityp ist nicht erlaubt',
    size: 'die Datei ist zu groß',
    quota: 'der Speicher des Büros ist voll',
    access: 'Sie dürfen in diesen Ordner nicht ablegen',
    name_taken: 'der Name ist schon vergeben',
    unreadable: 'die Datei konnte nicht gelesen werden',
    digest_mismatch: 'die Datei hat sich beim Ablegen verändert',
    unavailable: 'der Speicher war nicht erreichbar',
    thread_document_gone: 'der E-Mail-Verlauf ist nicht mehr da',
    scan_not_clean: 'die Prüfung auf Schadsoftware ist nicht bestanden',
    project_closed: 'das Projekt ist abgeschlossen',
    type_not_accepted: 'dieser Dateityp wird in diesem Büro nicht abgelegt',
  },

  address: {
    dialogTitle: 'Per E-Mail senden',
    dialogDescription:
      'Leiten Sie E-Mails mit Unterlagen an die E-Mail-Adresse des Projekts weiter. Sie warten im E-Mail-Eingang, bis jemand sie ablegt.',
    label: 'E-Mail-Adresse des Projekts',
    copy: 'Kopieren',
    saveContact: 'Als Kontakt sichern',
    contactName: 'Piloti · {project}',
    contactNote: 'E-Mails an diese Adresse warten in Piloti, bis jemand sie ablegt.',
    rules: {
      held: 'Abgelegt wird erst, wenn eine Person es bestätigt.',
      trust: 'Jede E-Mail zeigt, ob die Domain des Absenders bestätigt ist.',
      scanned: 'Anhänge werden auf Schadsoftware geprüft, bevor jemand sie ablegen kann.',
    },
    guide: 'Anleitung',
    helpUrl: 'https://piloti.at/e-mail-eingang/',
    none: 'Dieses Projekt hat noch keine E-Mail-Adresse.',
    noneMember: 'Bitten Sie jemanden, der das Projekt verwaltet, sie in den Projekteinstellungen zu erzeugen.',
    create: 'Adresse erzeugen',
    createBusy: 'Wird erzeugt …',
    unavailable: 'Diese Installation empfängt keine E-Mails.',
    loadError: 'Die E-Mail-Adresse des Projekts konnte nicht geladen werden.',
    lastReceived: 'Zuletzt eingegangen {time}',
    nothingReceived: 'Noch keine E-Mail eingegangen',
    dropped:
      '{count, plural, one {# automatische Antwort oder Zustellbericht in den letzten 30 Tagen, nicht angezeigt} other {# automatische Antworten oder Zustellberichte in den letzten 30 Tagen, nicht angezeigt}}',
    rotate: 'Neue Adresse erzeugen …',
    rotateTitle: 'Neue Adresse erzeugen?',
    rotateText:
      'Die bisherige Adresse funktioniert ab sofort nicht mehr; E-Mails an sie werden abgewiesen. Wer einem E-Mail-Verlauf dieses Projekts folgt, folgt ihm danach nicht mehr. Geben Sie die neue Adresse an alle weiter, die Unterlagen an dieses Projekt senden.',
    rotateConfirm: 'Neue Adresse erzeugen',
    switchOff: 'Ausschalten …',
    switchOffTitle: 'E-Mail-Adresse des Projekts ausschalten?',
    switchOffText: 'E-Mails an diese Adresse werden ab sofort abgewiesen. Was schon im E-Mail-Eingang wartet, bleibt dort.',
    switchOffConfirm: 'Ausschalten',
    cancel: 'Abbrechen',
    rotated: 'Neue Adresse erzeugt',
    switchedOff: 'E-Mail-Adresse des Projekts ausgeschaltet',
    created: 'E-Mail-Adresse des Projekts erzeugt',
    ownDomain: {
      share: '{percent} % der E-Mails Ihres Büros der letzten 30 Tage waren von Ihrer Domain bestätigt',
      missing: 'Ihre Domain signiert ihre E-Mails nicht – so richten Sie es ein',
      explain:
        'E-Mails, die Ihre Domain signiert, tragen „Domain bestätigt“. Nicht signierte E-Mails Ihrer Kolleginnen und Kollegen brauchen vor dem Ablegen eine Bestätigung.',
      helpUrl: 'https://piloti.at/e-mail-eingang/#dkim',
    },
  },

  follow: {
    offer: 'Diesem E-Mail-Verlauf folgen',
    thread: 'E-Mail-Verlauf „{name}“',
    explain:
      'Antworten von bestätigten Domains, die schon im E-Mail-Verlauf schreiben, werden ohne Klick angefügt. Anhänge warten weiter hier.',
    busy: 'Wird eingerichtet …',
    following: 'Sie folgen „{name}“',
    undo: 'Rückgängig',
    failed: 'Das Folgen hat nicht geklappt. Bitte erneut versuchen.',
  },
}
