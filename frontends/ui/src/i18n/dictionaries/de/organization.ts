import type { en } from '../en'

/** The organization management page (admin). */
export const organization: typeof en.organization = {
  title: 'Organisation',
  subtitle: 'Verwalten Sie Ihre Organisation, ihre Mitglieder und Zugriffe.',
  loading: 'Organisation wird geladen…',
  memberSubtitle: 'Ihr Verbrauch und Ihre Organisation auf einen Blick.',
  backToApp: 'Zurück zu den Projekten',
  nav: {
    label: 'Organisationsbereiche',
    overview: 'Übersicht',
    access: 'Personen & Zugriff',
    models: 'Modelle',
    budgets: 'Nutzung & Budgets',
    storage: 'Speicher',
    compliance: 'Compliance',
    enterprise: 'Enterprise',
  },
  /** Seitentitel der Bereichsrouten — eine Überschrift pro Route, nicht pro Karte. */
  sections: {
    overview: {
      title: 'Übersicht',
      subtitle:
        'Ihre Organisation auf einen Blick — Name, Domains, Mitglieder und die Piloti-Einstellungen, die für alle darin gelten.',
    },
    access: {
      title: 'Personen & Zugriff',
      subtitle:
        'Wer in der Organisation ist, welche Rolle die Einzelnen haben und was diese Rolle erlaubt.',
    },
    models: {
      title: 'Modelle',
      subtitle:
        'Mit welchem Modell jeder Teil des Agenten arbeitet — und ob dafür der Plattformschlüssel oder Ihr eigener verwendet wird.',
    },
    budgets: {
      title: 'Nutzung & Budgets',
      subtitle:
        'LLM-Ausgaben im Verhältnis zu den Limits, gegen die sie geprüft werden. Administratoren sehen die gesamte Organisation, alle anderen ihren eigenen Verbrauch.',
    },
    storage: {
      title: 'Speicher',
      subtitle:
        'Wie viel Dokumentenspeicher diese Organisation belegt und welches Kontingent ihn begrenzt.',
    },
    compliance: {
      title: 'Compliance',
      subtitle:
        'Der Audit-Trail jeder privilegierten Änderung, dazu Legal Holds und Löschungen, mit denen Sie für Ihre Daten geradestehen.',
    },
    enterprise: {
      title: 'Enterprise',
      subtitle:
        'SSO, Directory Sync, Domain-Verifizierung und Audit-Log-Streaming — die WorkOS-Steuerung, die nur Administratoren berühren dürfen.',
    },
  },
  /** Personen & Zugriff: Mitgliederverzeichnis, Rollenkatalog, Berechtigungsübersicht. */
  access: {
    people: {
      title: 'Personen',
      description: 'Alle Mitglieder der Organisation und die Rolle, die ihnen zugewiesen wurde.',
      columnName: 'Name',
      columnEmail: 'E-Mail',
      columnRole: 'Rolle',
      columnStatus: 'Status',
      noRole: 'Keine Rolle',
      empty: 'Dieser Organisation ist noch niemand beigetreten.',
      loadError:
        'Das Mitgliederverzeichnis konnte gerade nicht geladen werden. Rollen lassen sich unten trotzdem ändern.',
    },
    roles: {
      title: 'Rollen',
      description: 'Die Rollen, die diese Organisation vergeben kann, und was jede davon freischaltet.',
      // Singular/Plural wählt hier die Komponente. Neue gezählte Strings
      // schreiben stattdessen einen Plural-Block (siehe `i18n/translate.ts`).
      permissionCountOne: '1 Berechtigung',
      permissionCountOther: '{count} Berechtigungen',
      platformNotice:
        'Nur für Plattform-Personal. Diese Rollen liegen in der Organisation „GRID Platform“ und können hier nicht vergeben werden.',
    },
    permissions: {
      title: 'Berechtigungen',
      description:
        'Jede Berechtigung, die die Organisation kennt, und die Rollen, die sie vergeben.',
      columnPermission: 'Berechtigung',
      grantedBy: 'Vergeben durch',
      noRoles: 'Keine Rolle vergibt dies',
      deprecated: 'Veraltet',
    },
    tiers: {
      org: 'Organisation',
      project: 'Projekt',
      skill: 'Skill-Zeitplan',
      platform: 'Plattform',
    },
    notAllowed: {
      title: 'Sie können hier keine Personen verwalten',
      description:
        'Für die Verwaltung von Personen und Rollen wird die Berechtigung „Personen und Rollen verwalten“ benötigt. Ein Organisations-Admin kann sie vergeben.',
    },
  },
  overview: {
    title: 'Übersicht',
    description: 'Ihre Organisation auf einen Blick.',
    name: 'Name',
    id: 'Organisations-ID',
    domains: 'Domains',
    noDomains: 'Keine verifizierten Domains',
    created: 'Erstellt',
    members: 'Mitglieder',
    membersCapped: '{count}+',
    pendingInvites: 'Ausstehende Einladungen',
  },
  settings: {
    title: 'Organisationseinstellungen',
    description: 'Piloti-spezifische Einstellungen für Ihre Organisation.',
    displayName: 'Anzeigename',
    displayNameHint: 'Wird innerhalb von Piloti angezeigt. Leer lassen, um den WorkOS-Organisationsnamen zu verwenden.',
    displayNamePlaceholder: 'z. B. Acme Architektur GmbH',
    defaultLocale: 'Standardsprache für neue Mitglieder',
    defaultLocaleHint: 'Neue Mitglieder starten in dieser Sprache, bis sie ihre eigene wählen.',
    chatEffort: 'Standard-Aufwand für neue Chats',
    chatEffortHint:
      'Wie lange Piloti in einem neuen Chat nachdenkt. Jedes Mitglied kann den Aufwand im Chat selbst verstellen; das hier ist nur der Startwert.',
    webSearch: 'Websuche',
    webSearchHint:
      'Erlaubt den Agenten, das öffentliche Web zu durchsuchen. Wenn deaktiviert, verschwinden Websuche-Tools aus der Auswahl und werden serverseitig für alle Mitglieder blockiert.',
    save: 'Änderungen speichern',
    saving: 'Wird gespeichert…',
    saved: 'Organisationseinstellungen gespeichert',
    saveError: 'Die Organisationseinstellungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
    loadError: 'Die Organisationseinstellungen konnten gerade nicht geladen werden. Bitte laden Sie die Seite neu.',
  },
  /**
   * Organisation → Anweisungen: der Anweisungsblock, unter dem jede Antwort
   * dieser Organisation geschrieben wird. Der Hinweis nennt die Grenze
   * ausdrücklich, weil sie der Punkt ist: stehende Vorlieben zu Form, Fokus und
   * Ablauf — keine Regel, die Piloti aushebelt, und kein normativer Wert.
   */
  instructions: {
    title: 'Anweisungen',
    description:
      'Was Piloti für Ihre Organisation dauerhaft beachten soll. Wird bei jeder Anfrage mitgegeben.',
    label: 'Stehende Anweisungen',
    placeholder:
      'z. B. Antworten zuerst mit dem Ergebnis, dann mit der Begründung. Standardmäßig Wien annehmen, wenn kein Bundesland genannt ist. Bei Prüfaufträgen immer eine Mängelliste anhängen.',
    hint: 'Stehende Vorlieben zu Form, Fokus und Ablauf. Sie setzen Pilotis eigene Regeln nie außer Kraft und liefern nie einen normativen Wert — eine OIB-Anforderung stammt aus der Richtlinie, nie aus diesem Feld.',
    remaining: '{used} von {max} Zeichen',
    overCap: '{over} Zeichen zu viel. Bitte kürzen Sie den Text, bevor Sie speichern.',
    save: 'Anweisungen speichern',
    saving: 'Wird gespeichert…',
    saved: 'Anweisungen gespeichert',
    clear: 'Löschen',
    cleared: 'Anweisungen gelöscht',
    saveError: 'Die Anweisungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
    loadError: 'Die Anweisungen konnten gerade nicht geladen werden. Bitte laden Sie die Seite neu.',
  },
  members: {
    title: 'Mitglieder',
    description: 'Laden Sie Personen ein, weisen Sie Rollen zu und verwalten Sie den Zugriff.',
  },
  advanced: {
    title: 'Erweitert',
    description: 'Enterprise-Zugriffssteuerung. Es werden nur Optionen angezeigt, die Ihre Rolle verwalten kann.',
    sso: 'Single Sign-On (SSO)',
    ssoDescription: 'Verbinden Sie einen Identitätsanbieter, damit sich Mitglieder über Ihren IdP anmelden.',
    directory: 'Directory Sync (SCIM)',
    directoryDescription: 'Mitglieder automatisch aus Ihrem Verzeichnis bereitstellen und entfernen.',
    domains: 'Domain-Verifizierung',
    domainsDescription: 'Verifizieren Sie Domains, die Ihrer Organisation gehören.',
    auditLogs: 'Audit-Log-Streaming',
    auditLogsDescription: 'Streamen Sie Audit-Ereignisse an Ihr SIEM oder Ihren Logging-Anbieter.',
  },
  notAdmin: {
    title: 'Sie benötigen Administratorrechte',
    description:
      'Nur Organisations-Administratoren können die Organisation verwalten. Wenden Sie sich an einen Administrator, wenn Sie Zugriff benötigen.',
  },
  models: {
    title: 'KI-Modellkonfiguration',
    description:
      'Wählen Sie, mit welchem OpenRouter-Modell jede Agentengruppe arbeitet. Änderungen gelten sofort für neue Unterhaltungen; jeder Speichervorgang erzeugt eine neue Version, zu der Sie zurückkehren können.',
    defaultModel: 'Plattform-Standard',
    defaultBadge: 'Standard',
    overrideBadge: 'Override',
    discard: 'Änderungen verwerfen',
    unsavedChanges: 'Ungespeicherte Änderungen — als neue Version speichern oder verwerfen.',
    change: 'Ändern',
    searchPlaceholder: 'Geeignete Modelle suchen…',
    noResults: 'Keine geeigneten Modelle entsprechen Ihrer Suche.',
    contextWindow: 'Kontext',
    creditsPerRequest: '≈ {credits} Punkte pro Anfrage',
    resetToDefault: 'Standard verwenden',
    comment: 'Änderungsnotiz (optional)',
    commentPlaceholder: 'Warum ändern Sie die Modelle?',
    save: 'Als neue Version speichern',
    saving: 'Wird gespeichert…',
    saved: 'Modellkonfiguration gespeichert',
    saveError: 'Die Modellkonfiguration konnte nicht gespeichert werden.',
    history: 'Versionsverlauf',
    historyEmpty: 'Noch keine Versionen — die Organisation nutzt die Plattform-Standards.',
    version: 'Version',
    activeBadge: 'Aktiv',
    activate: 'Aktivieren',
    activated: 'Version aktiviert',
    activateError: 'Diese Version konnte nicht aktiviert werden.',
    activateTitle: 'Für die gesamte Organisation aktivieren?',
    activateDescription:
      'Setzt {target} sofort als Produktionsmodell für alle Mitglieder Ihrer Organisation — wirksam für neue Unterhaltungen. Sie können jederzeit zu einer anderen Version zurückkehren.',
    activateConfirm: 'Jetzt aktivieren',
    defaultsTarget: 'die Plattform-Standards',
    useDefaults: 'Overrides deaktivieren (Plattform-Standards verwenden)',
    loadError: 'Die Modellkonfiguration konnte nicht geladen werden.',
    byokCatalogHint:
      'Ihr Organisationsschlüssel ({provider}) ist aktiv: Die Auswahl zeigt die Modelle, die IHR Provider-Konto anbietet, und der gesamte Traffic wird darüber abgerechnet. Wird der Schlüssel entfernt, gilt wieder der Plattformkatalog.',
    pickerLoadError: 'Die Modellliste konnte nicht geladen werden.',
    saveErrorZdrUnavailable:
      'Die Zero-Data-Retention-Liste konnte nicht geladen werden; die Modelle ließen sich daher nicht prüfen. Es wurde nichts gespeichert – bitte versuchen Sie es gleich noch einmal.',
    zdrTitle: 'Zero Data Retention',
    zdrHint:
      'Standardmäßig aktiv. Jede Anfrage, die Piloti für Ihre Organisation über OpenRouter an ein KI-Modell sendet, geht ausschließlich an Endpunkte, die weder Prompts noch Antworten speichern: Chat- und Rechercheantworten, Rückfragen, das Lesen von Dokumenten beim Hochladen (Beschreibungen von Zeichnungen, Texterkennung, Embeddings, Zusammenfassungen, Klassifizierung), das Reranking von Suchergebnissen, Titel und Zusammenfassungen von Unterhaltungen, Konsistenzprüfungen und Skill-Prüfungen. Kann die Einstellung nicht gelesen werden, gilt die Beschränkung trotzdem, und nur Modelle mit einem solchen Endpunkt sind auswählbar. Wo ein Modell in der EU betrieben wird, wird dieser Standort bevorzugt. Nicht erfasst: Websuchanfragen gehen an den Websuche-Anbieter (Tavily), der kein Modellanbieter ist.',
    zdrNotApplicable:
      'Der eigene {provider}-Schlüssel Ihrer Organisation ist aktiv; Anfragen gehen daher direkt an diesen Anbieter und nicht über OpenRouter. Ob dort Daten gespeichert werden, regelt Ihr Vertrag mit {provider}; Piloti kann das nicht durchsetzen. Ihre gespeicherte Einstellung bleibt erhalten und gilt wieder, sobald Sie zum Plattformschlüssel oder zu einem OpenRouter-Schlüssel wechseln.',
    zdrEnabled: 'Zero Data Retention ist aktiviert',
    zdrDisabled: 'Zero Data Retention ist deaktiviert',
    zdrError: 'Zero Data Retention konnte nicht geändert werden. Bitte versuchen Sie es erneut.',
    zdrErrorForbidden:
      'Sie können Zero Data Retention nicht ändern: Dafür brauchen Sie die Berechtigung „KI-Modelle verwalten“, und die Modellkonfiguration muss für Ihre Organisation freigeschaltet sein.',
    zdrDisableTitle: 'Zero Data Retention deaktivieren?',
    zdrDisableDescription:
      'Ohne Zero Data Retention dürfen die Modellanbieter hinter OpenRouter die Prompts, hochgeladenen Dokumente, Zeichnungen und Antworten Ihrer Organisation speichern und – je nach Anbieter – zum Training ihrer Modelle verwenden. Das gilt ab der nächsten Anfrage für alle Mitglieder Ihrer Organisation.',
    zdrDisableAcknowledge:
      'Mir ist bewusst, dass Prompts, Dokumente, Zeichnungen und Antworten dieser Organisation dann von Modellanbietern gespeichert und zum Training verwendet werden können.',
    zdrDisableConfirm: 'Zero Data Retention deaktivieren',
    zdrOffTitle: 'Zero Data Retention ist deaktiviert',
    zdrOffBody:
      'Die Modellanbieter hinter OpenRouter dürfen Prompts, Dokumente, Zeichnungen und Antworten Ihrer Organisation speichern und – je nach Anbieter – zum Training verwenden. Sie können die Einstellung oben jederzeit ohne Bestätigung wieder aktivieren.',
    zdrBlockedSummary:
      '{count, plural, one {# Aufgabe kann} other {# Aufgaben können}} mit dem aktuellen Modell nicht unter Zero Data Retention laufen. Siehe die markierten Zeilen unten.',
    zdrBlockedNotZdr:
      '{model} ({source}) hat keinen Zero-Data-Retention-Endpunkt. Anfragen für diese Aufgabe werden abgelehnt, bis Sie hier ein ZDR-fähiges Modell wählen.',
    zdrBlockedCapability:
      '{model} ({source}) hat zwar Zero-Data-Retention-Endpunkte, aber keiner unterstützt, was diese Aufgabe benötigt. Anfragen für diese Aufgabe werden abgelehnt, bis Sie hier ein anderes Modell wählen.',
    zdrSource: {
      org: 'Ihre Auswahl',
      platform: 'Plattform-Standard',
      workflow: 'Workflow-Konfiguration',
    },
    zdrCoverageUnknown:
      'Die Zero-Data-Retention-Liste konnte nicht geladen werden; ob das Modell jeder Aufgabe einen ZDR-Endpunkt hat, ist daher unbekannt. Anfragen bleiben auf ZDR-Endpunkte beschränkt; Anfragen ohne passenden Endpunkt werden abgelehnt.',
    zdrUnresolved:
      'Das Standardmodell dieser Aufgabe konnte nicht ermittelt werden; ob es einen Zero-Data-Retention-Endpunkt hat, ist unbekannt.',
    zdrListUnavailable:
      'Die Zero-Data-Retention-Liste konnte nicht geladen werden; deshalb kann gerade kein Modell angeboten werden. Bitte versuchen Sie es gleich noch einmal.',
    noZdrResults: 'Kein Modell mit Zero-Data-Retention-Endpunkt passt zu Ihrer Suche.',
    noZdrMark: 'Kein Zero-Data-Retention-Endpunkt',
    rejection: {
      unknown_group: 'Diese Aufgabe gibt es nicht mehr.',
      not_in_catalog: '{model} ist nicht im Modellkatalog.',
      not_zdr: '{model} hat keinen Zero-Data-Retention-Endpunkt.',
      zdr_endpoint_lacks_capability:
        'Kein Zero-Data-Retention-Endpunkt von {model} unterstützt, was diese Aufgabe benötigt.',
      no_text_input: 'Das Modell nimmt keine Texteingabe an.',
      no_image_input: 'Das Modell nimmt keine Bilder an; diese Aufgabe braucht ein Vision-Modell.',
      context_too_small: 'Das Kontextfenster ({actual} Tokens) ist kleiner als die geforderten {required}.',
      missing_parameter: 'Das Modell unterstützt „{parameter}“ nicht, das diese Aufgabe braucht.',
      reasoning_mandatory: 'Das Modell erfordert Reasoning; für diese Aufgabe ist Reasoning deaktiviert.',
    },
  },
  byok: {
    title: 'LLM-API-Schlüssel (BYOK)',
    description:
      'Bringen Sie Ihren eigenen LLM-Provider-Schlüssel mit: Research-Traffic wird über Ihr Provider-Konto abgerechnet und der Schlüssel pro Organisation verschlüsselt in WorkOS Vault abgelegt. Schlüssel werden vor der Aktivierung live geprüft; Rotation und Widerruf werden auditiert.',
    loading: 'Zugangsdaten werden geladen…',
    loadError: 'Die LLM-Zugangsdaten konnten nicht geladen werden.',
    noCredential: 'Kein Organisationsschlüssel verbunden — Piloti nutzt den Plattformschlüssel.',
    storageVaultNote:
      'Neue Schlüssel werden verschlüsselt in WorkOS Vault unter dem Schlüsselkontext Ihrer Organisation gespeichert.',
    storageLocalNote: 'Neue Schlüssel werden mit dem lokalen Schlüssel dieser Installation verschlüsselt gespeichert.',
    activeBadge: 'Aktiv',
    standbyBadge: 'Gespeichert, nicht in Verwendung',
    modeTitle: 'Eigenen Schlüssel verwenden',
    modeByokHint:
      'Research-Traffic läuft über Ihren Schlüssel und wird über Ihr Provider-Konto abgerechnet. Die Modellauswahl zeigt die Modelle Ihres Providers.',
    modePlatformHint:
      'Research-Traffic läuft über den Piloti-Plattform-Service. Ihr Schlüssel bleibt sicher gespeichert und kann jederzeit wieder aktiviert werden.',
    modeByokSet: 'Auf eigenen Schlüssel umgestellt — neue Unterhaltungen nutzen ihn innerhalb einer Minute.',
    modePlatformSet: 'Auf den Piloti-Plattform-Service umgestellt — Ihr Schlüssel bleibt gespeichert, wird aber nicht verwendet.',
    modeError: 'Der Provider-Modus konnte nicht geändert werden.',
    keyLabel: 'Schlüssel',
    storageLabel: 'Speicherung',
    storageVault: 'WorkOS Vault (Verschlüsselung pro Organisation)',
    storageLocal: 'Lokaler verschlüsselter Speicher',
    baseUrl: 'Basis-URL',
    baseUrlHint: 'HTTPS-Endpunkt einer OpenAI-kompatiblen API (z. B. Ihre Azure-OpenAI-Ressource oder Ihr Gateway).',
    lastVerified: 'Zuletzt geprüft',
    lastUsed: 'Zuletzt verwendet',
    connectTitle: 'Organisationsschlüssel verbinden',
    rotateTitle: 'Schlüssel rotieren',
    provider: 'Provider',
    providers: {
      openrouter: 'OpenRouter',
      openai: 'OpenAI',
      'azure-openai': 'Azure OpenAI',
      custom: 'Eigener (OpenAI-kompatibel)',
    },
    label: 'Bezeichnung',
    labelPlaceholder: 'z. B. Firmen-OpenRouter-Konto',
    // Labels for the BYOK key field, not a key. detect-secrets matches on the
    // `apiKey` identifier regardless of the value being German UI copy.
    apiKey: 'API-Schlüssel', // pragma: allowlist secret
    apiKeyPlaceholder: 'sk-…', // pragma: allowlist secret
    apiKeyHint:
      'Wird vor dem Speichern beim Provider geprüft. Nach dem Speichern nie wieder angezeigt.', // pragma: allowlist secret
    connect: 'Prüfen & verbinden',
    rotate: 'Prüfen & rotieren',
    saving: 'Wird geprüft…',
    connected: 'Organisationsschlüssel verbunden — neue Unterhaltungen nutzen ihn sofort.',
    rotated: 'Schlüssel rotiert — der vorherige Schlüssel wurde widerrufen.',
    saveError: 'Der Schlüssel konnte nicht gespeichert werden.',
    verify: 'Prüfen',
    verified: 'Schlüssel geprüft — {count, plural, one {# Modell} other {# Modelle}} sichtbar.',
    verifyError: 'Die Prüfung ist fehlgeschlagen.',
    revoke: 'Widerrufen',
    revokeConfirm:
      'Organisationsschlüssel widerrufen? Research-Traffic fällt innerhalb einer Minute auf den Plattformschlüssel zurück.',
    revoked: 'Schlüssel widerrufen — es wird wieder der Plattformschlüssel verwendet.',
    revokeError: 'Der Schlüssel konnte nicht widerrufen werden.',
    history: 'Schlüsselverlauf',
    revokedOn: 'erstellt {date}',
  },
  /** Speicher: belegte Bytes im Verhältnis zum Kontingent, das Uploads stoppt. */
  storage: {
    title: 'Dokumentenspeicher',
    description:
      'Jedes hochgeladene Dokument wird aufbewahrt, damit es erneut gelesen, neu eingebettet und geprüft werden kann. Das Kontingent verhindert, dass eine Organisation den gemeinsamen Speicher füllt.',
    used: 'Belegt',
    ofQuota: '{used} von {quota}',
    noQuota: '{used} belegt (kein Kontingent)',
    overQuota: 'Kontingent erreicht — neue Uploads werden abgelehnt, bis Platz frei wird',
    nearQuota: 'Fast voll — neue Uploads werden bald abgelehnt',
    projectDocuments: 'Projektdokumente',
    archivDocuments: 'Organisations-Archiv',
    /** Count-neutral: wird auch bei genau einem Dokument gerendert. */
    documentCount: 'Dokumente: {count}',
    setByPlatform:
      'Ihr Speicherkontingent wird von Piloti festgelegt. Wenden Sie sich an den Support, wenn Sie mehr Platz benötigen.',
    loadError: 'Speichernutzung konnte nicht geladen werden.',
  },
  budgets: {
    title: 'Verbrauch & Budgets',
    description:
      'Verbrauch pro Modell im Verhältnis zu Ihren Organisationslimits. Jede Anfrage wird während der Ausführung erfasst; Limits werden vor jeder Anfrage durchgesetzt.',
    memberTitle: 'Ihr Verbrauch',
    memberDescription:
      'Ihr eigener Verbrauch im Verhältnis zu Ihren Organisationslimits. Ist ein Budget aufgebraucht, wird der Chat pausiert, bis eine Administratorin oder ein Administrator das Limit erhöht.',
    today: 'Heute',
    thisMonth: 'Dieser Monat',
    ofLimit: '{spent} von {limit}',
    noLimit: '{spent} (kein Limit)',
    creditsValue: '{value} Punkte',
    tokensValue: '{value} Tokens',
    unitCredits: 'Punkte',
    unitTokens: 'Tokens',
    ownKeyNote:
      'Ihre Organisation arbeitet mit einem eigenen Anbieterschlüssel. Der Verbrauch wird in Tokens auf Ihrer eigenen Rechnung gezählt; Piloti berechnet dafür keine Punkte.',
    overLimit: 'Budget ausgeschöpft — neue Anfragen werden blockiert',
    legendTitle: 'Verbrauch nach Modell',
    legendEmpty: 'In diesem Zeitraum wurde noch keine LLM-Nutzung erfasst.',
    trendTitle: 'Letzte 30 Tage',
    trendEmpty: 'In den letzten 30 Tagen wurde keine Nutzung erfasst.',
    otherModels: 'Weitere Modelle',
    tooltipRequests: '{count, plural, one {# Anfrage} other {# Anfragen}}',
    limitsTitle: 'Organisationslimits',
    limitsDescription:
      'Bis Sie eigene Limits festlegen, gilt das Kontingent Ihres Plans. Limits werden in Punkten angegeben und vor jeder Anfrage durchgesetzt.',
    limitsDescriptionTokens:
      'Es gilt kein Limit, bis Sie eines festlegen. Limits werden in Tokens auf Ihrem eigenen Schlüssel angegeben und vor jeder Anfrage durchgesetzt.',
    dailyLimit: 'Tageslimit ({unit})',
    monthlyLimit: 'Monatslimit ({unit})',
    noLimitPlaceholder: 'Kein Limit',
    saveLimits: 'Limits speichern',
    limitsSaved: 'Budgetlimits gespeichert',
    limitsSaveError: 'Die Budgetlimits konnten nicht gespeichert werden.',
    membersTitle: 'Mitglieder — Verbrauch & Limits',
    membersDescription:
      'Verbrauch pro Mitglied mit optionalen individuellen Obergrenzen. Ein Mitgliedslimit überschreitet nie die Organisationslimits und gilt zusätzlich zu ihnen.',
    colMember: 'Mitglied',
    limitLabel: 'Limit',
    setLimit: 'Limit festlegen',
    noUsageYet: 'noch kein Verbrauch',
    scopedTitle: 'Projektlimits',
    scopedDescription:
      'Optionale Obergrenzen pro Projekt, einstellbar durch Projekt- und Organisations-Administratoren. Ein Projektlimit darf die Organisationslimits nicht überschreiten und gilt zusätzlich zu ihnen.',
    scopeMember: 'Mitglied',
    scopeProject: 'Projekt',
    subjectMemberPlaceholder: 'WorkOS-Benutzer-ID (user_…)',
    subjectProjectPlaceholder: 'Projekt-ID (UUID)',
    addPolicy: 'Limit festlegen',
    policySaved: 'Limit gespeichert',
    policySaveError: 'Dieses Limit konnte nicht gespeichert werden.',
    activePolicies: 'Aktive spezifische Limits',
    noPolicies: 'Keine Mitglieder- oder Projektlimits festgelegt.',
    selectMember: 'Mitglied auswählen…',
    selectProject: 'Projekt auswählen…',
    subjectGone: 'nicht mehr verfügbar',
    removePolicy: 'Entfernen',
    policyRemoved: 'Limit entfernt — es gelten wieder die Organisationslimits.',
    policyRemoveError: 'Dieses Limit konnte nicht entfernt werden.',
    perDay: 'Tag',
    perMonth: 'Monat',
    loadError: 'Die Verbrauchsdaten konnten nicht geladen werden.',
  },
  audit: {
    title: 'Audit-Logs',
    description:
      'Jede privilegierte Änderung — Budgets, Modellkonfiguration, Einstellungen, Legal Holds — wird im WorkOS-Audit-Trail Ihrer Organisation erfasst. Der Viewer öffnet sich in einem neuen Tab und kann Ereignisse exportieren.',
    open: 'Audit-Logs ansehen',
    error: 'Der Audit-Log-Viewer konnte nicht geöffnet werden.',
  },
}
