/**
 * Rechtsdokumente — Deutsch (maßgebliche Sprachfassung für den
 * österreichischen Markt). Strukturelles Gegenstück zu `./en.ts`.
 *
 * Betreiberangaben sind bewusste Platzhalter in [KLAMMERN] — sie MÜSSEN vor
 * dem Produktivbetrieb vervollständigt werden. Diese Texte entstanden im
 * Rahmen des Compliance-Reviews 2026-07 (docs/compliance/) und sind
 * Vorlagen, keine Rechtsberatung: vor Verwendung anwaltlich prüfen lassen.
 */

import type { LegalContent } from '../types'

const OPERATOR = '[Name des Betreibers — z. B. Piloti Check GmbH]'
const ADDRESS = '[Straße, Nummer, PLZ, Ort, Österreich]'
const EMAIL = '[Kontakt-E-Mail-Adresse]'

export const de: LegalContent = {
  imprint: {
    title: 'Impressum',
    updated: '2026-07-10',
    intro:
      'Offenlegung gemäß §5 E-Commerce-Gesetz (ECG), §25 Mediengesetz und §63 Gewerbeordnung.',
    sections: [
      {
        heading: 'Betreiber dieses Dienstes',
        paragraphs: [
          `${OPERATOR}, ${ADDRESS}.`,
          `Kontakt: ${EMAIL}`,
          'Firmenbuchnummer: [FN-Nummer], Firmenbuchgericht: [Gericht]. UID: [ATU-Nummer].',
          'Unternehmensgegenstand: [z. B. IT-Dienstleistungen / Software as a Service]. Aufsichtsbehörde gemäß ECG: [zuständige Bezirksverwaltungsbehörde]. Anwendbare gewerberechtliche Vorschriften: Gewerbeordnung 1994, abrufbar unter ris.bka.gv.at.',
        ],
      },
      {
        heading: 'Zweck des Dienstes',
        paragraphs: [
          'Piloti ist ein KI-gestütztes Recherchewerkzeug, das Baufachleute dabei unterstützt, Informationen aus den österreichischen OIB-Richtlinien und den im Rechtsinformationssystem des Bundes (RIS) veröffentlichten Rechtsquellen zu finden und zu überprüfen. Piloti erbringt keine Rechtsberatung; siehe Nutzungsbedingungen und KI-Transparenzhinweis.',
        ],
      },
      {
        heading: 'Online-Streitbeilegung',
        paragraphs: [
          'Verbraucher können Beschwerden an die Online-Streitbeilegungsplattform der EU richten: https://ec.europa.eu/odr. Beschwerden können auch an die oben genannte E-Mail-Adresse gerichtet werden.',
        ],
      },
      {
        heading: 'Haftung für Inhalte',
        paragraphs: [
          'Die von diesem Dienst erzeugten Antworten werden von einem KI-System generiert und können fehlerhaft oder unvollständig sein. Sie ersetzen weder die Prüfung der anwendbaren Vorschriften noch fachliche Beratung. Maßgeblich sind in jedem Fall die zitierten Primärquellen (OIB-Richtlinien, RIS).',
        ],
      },
    ],
  },

  privacy: {
    title: 'Datenschutzerklärung',
    updated: '2026-07-10',
    intro:
      'Diese Erklärung informiert gemäß Verordnung (EU) 2016/679 (DSGVO) darüber, wie personenbezogene Daten bei der Nutzung von Piloti verarbeitet werden.',
    sections: [
      {
        heading: '1. Verantwortlicher',
        paragraphs: [
          `Verantwortlicher im Sinne des Art. 4 Z 7 DSGVO: ${OPERATOR}, ${ADDRESS}, ${EMAIL}.`,
          'Wird Piloti über Ihren Arbeitgeber bzw. Ihre Organisation bereitgestellt, bestimmt diese Organisation die Zwecke der Verarbeitung der Projektinhalte in ihrem Arbeitsbereich; insoweit handelt der Betreiber als Auftragsverarbeiter im Auftrag der Organisation, und ein Auftragsverarbeitungsvertrag (Art. 28 DSGVO) regelt das Verhältnis.',
        ],
      },
      {
        heading: '2. Welche Daten wir verarbeiten',
        list: [
          'Konto- und Organisationsdaten: Name, E-Mail-Adresse, Organisationszugehörigkeit, Rollen und Berechtigungen. Die Identitätsverwaltung erfolgt über unseren Identitätsdienstleister WorkOS (AuthKit); wir führen bewusst keine eigene lokale Kopie Ihres Identitätsprofils.',
          'Inhaltsdaten: Ihre Chat-Fragen und die für Sie erzeugten Antworten, Rechercheberichte, von Ihnen hochgeladene Projektdokumente (Pläne, Bescheide, Spezifikationen — die selbst personenbezogene Daten enthalten können) sowie aus Ihren Interaktionen abgeleitete Projekt- und Organisationsnotizen (Memory).',
          'Nutzungs- und Abrechnungsdaten: ein Nutzungsledger, das je KI-Anfrage das angeforderte und das tatsächlich antwortende KI-Modell, Token-Zahlen und Kosten erfasst, zugeordnet zu Organisation, Projekt und Nutzer.',
          'Audit-Daten: privilegierte administrative Aktionen (z. B. Modellkonfigurations-Änderungen, Budgetänderungen, Löschungen, Legal Holds) werden mit handelnder Person, Zeitstempel, IP-Adresse und User-Agent protokolliert.',
          'Technische Daten: Server-Logs, Session-Cookie (Authentifizierung), Cookie für die Spracheinstellung.',
        ],
      },
      {
        heading: '3. Zwecke und Rechtsgrundlagen (Art. 6 DSGVO)',
        list: [
          'Bereitstellung des Dienstes, Beantwortung Ihrer Fragen, Speicherung Ihrer Projekte — Art. 6 Abs. 1 lit. b (Vertragserfüllung).',
          'Sicherheit, Zugriffskontrolle, Audit-Trails, Missbrauchsvermeidung (Rate-Limits, Zulassungssteuerung) — Art. 6 Abs. 1 lit. f (berechtigtes Interesse an sicherem, nachvollziehbarem Betrieb).',
          'Nutzungsmessung und Budgetdurchsetzung — Art. 6 Abs. 1 lit. b und f.',
          'Erfüllung rechtlicher Pflichten (z. B. Aufbewahrung bei Legal Hold, Rechnungswesen) — Art. 6 Abs. 1 lit. c.',
        ],
      },
      {
        heading: '4. KI-Verarbeitung und Empfänger Ihrer Inhalte',
        paragraphs: [
          'Zur Erzeugung von Antworten werden Ihre Chat-Nachrichten, relevante Auszüge Ihrer hochgeladenen Dokumente und abgerufene Vorschriftenpassagen über das API-Gateway OpenRouter, Inc. (USA) an externe KI-Modellanbieter übermittelt. Aus Ihren Fragen abgeleitete Web-Recherche-Anfragen gehen an den Suchdienst Tavily. Identität und Anmeldung werden von WorkOS, Inc. (USA) abgewickelt.',
        ],
        notice:
          'Wichtig: Welches KI-Modell — und damit welcher vorgelagerte Modellanbieter (z. B. DeepSeek, OpenAI, Anthropic, Google, Meta, Mistral und weitere im OpenRouter-Katalog gelistete Anbieter) — Ihre Anfragen verarbeitet, kann von den Administratorinnen und Administratoren Ihrer Organisation zur Laufzeit konfiguriert werden. Der gesamte KI-Verkehr läuft stets über OpenRouter und niemals über ein anderes Gateway; der tatsächliche nachgelagerte Anbieter — und damit der Ort dieser Verarbeitung (auch außerhalb der EU/des EWR möglich) — hängt jedoch vom Modell ab, das Ihre Organisation auswählt. Jede Modelländerung wird validiert, versioniert, der handelnden Administratorin bzw. dem Administrator zugeordnet und ist nachvollziehbar; das Modell, das eine Anfrage tatsächlich beantwortet hat, wird protokolliert. Die aktuelle Liste externer Dienste finden Sie auf der Seite „Subunternehmer".',
      },
      {
        heading: '5. Drittlandübermittlungen (Art. 44 ff DSGVO)',
        paragraphs: [
          'Mehrere Dienstleister haben ihren Sitz in den USA oder anderen Drittländern, und das von Ihrer Organisation gewählte KI-Modell kann außerhalb der EU/des EWR betrieben werden. Übermittlungen stützen sich auf Angemessenheitsbeschlüsse (einschließlich des EU-US Data Privacy Framework, soweit der Anbieter zertifiziert ist) und/oder Standardvertragsklauseln. Details je Anbieter finden Sie auf der Seite „Subunternehmer". Die Administratorinnen und Administratoren Ihrer Organisation können die wählbaren Modelle einschränken.',
        ],
      },
      {
        heading: '6. Speicherung, Aufbewahrung und Löschung',
        paragraphs: [
          'Projektinhalte werden in unserer Anwendungsdatenbank, im Objektspeicher (hochgeladene Dokumente) und in einem Vektorindex (Dokument-Embeddings) gespeichert — alles in eigener Infrastruktur betrieben. Beim Löschen eines Projekts wird es zunächst als gelöscht markiert und ist während einer Karenzfrist wiederherstellbar; danach entfernt eine automatisierte Bereinigung es dauerhaft aus allen Speichern (Datenbank, Objektspeicher, Vektorindex und zugehörige Berechtigungsdatensätze). Die Löschung kann durch einen Legal Hold (Einschränkung nach Art. 18 DSGVO) ausgesetzt werden, den die Compliance-Rolle Ihrer Organisation setzt; jedes Setzen und Aufheben wird im Audit-Trail protokolliert.',
          'Nutzungsledger- und Audit-Datensätze werden zu Rechenschafts- und Abrechnungszwecken so lange aufbewahrt, wie es der Vertrag der Organisation und gesetzliche Aufbewahrungsfristen erfordern.',
        ],
      },
      {
        heading: '7. Cookies',
        paragraphs: [
          'Piloti verwendet ausschließlich technisch notwendige Cookies: einen verschlüsselten Session-Cookie für die Anmeldung (WorkOS AuthKit) und einen Cookie für Ihre Spracheinstellung. Es werden keine Werbe- oder seitenübergreifenden Tracking-Cookies gesetzt. Da nur technisch notwendige Cookies zum Einsatz kommen, ist kein Cookie-Einwilligungsbanner erforderlich (§165 TKG 2021).',
        ],
      },
      {
        heading: '8. Ihre Rechte',
        paragraphs: [
          'Ihnen stehen die Rechte auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21) zu. Soweit eine Verarbeitung auf Einwilligung beruht, können Sie diese jederzeit widerrufen. Wird Piloti über Ihre Organisation bereitgestellt, richten Sie Anfragen bitte zunächst an Ihre Organisation; wir unterstützen die Organisation bei der Erfüllung.',
          `Zur Ausübung Ihrer Rechte wenden Sie sich an ${EMAIL}. Sie haben zudem das Recht auf Beschwerde bei der österreichischen Datenschutzbehörde, Barichgasse 40–42, 1030 Wien, dsb.gv.at, oder Ihrer örtlichen Aufsichtsbehörde.`,
        ],
      },
      {
        heading: '9. Datensicherheit (Art. 32 DSGVO)',
        paragraphs: [
          'Der Zugriff ist durch Single Sign-on mit optionaler Mehr-Faktor-Authentifizierung, rollenbasierte Berechtigungen und bei jeder Anfrage durchgesetzte Mandantentrennung geschützt. Administrative Aktionen werden audit-protokolliert. Transportverschlüsselung (TLS) schützt Daten bei der Übertragung. Interne Dienst-zu-Dienst-Aufrufe werden mit eigenen Tokens authentifiziert.',
        ],
      },
      {
        heading: '10. Änderungen',
        paragraphs: [
          'Wir aktualisieren diese Erklärung, wenn sich der Dienst oder seine Anbieter ändern, und weisen oben das Datum der letzten Überarbeitung aus. Wesentliche Änderungen, die Organisationen betreffen, werden deren Administratorinnen und Administratoren angekündigt.',
        ],
      },
    ],
  },

  terms: {
    title: 'Nutzungsbedingungen',
    updated: '2026-07-10',
    intro:
      'Diese Bedingungen regeln die Nutzung von Piloti. Vorlage — vor Produktivbetrieb anwaltlich prüfen und vervollständigen.',
    sections: [
      {
        heading: '1. Leistungsumfang',
        paragraphs: [
          'Piloti ist ein KI-gestützter Rechercheassistent für österreichisches Baurecht (OIB-Richtlinien und RIS-Rechtsquellen). Piloti ruft Vorschrifteninhalte und von Ihrer Organisation bereitgestellte Projektdokumente ab, fasst sie zusammen und zitiert sie.',
        ],
      },
      {
        heading: '2. Keine Rechtsberatung',
        paragraphs: [
          'Piloti erbringt keine Rechtsberatung und ersetzt nicht die Beurteilung qualifizierter Fachleute wie Architektinnen und Architekten, Ziviltechnikerinnen und Ziviltechnikern oder Rechtsanwältinnen und Rechtsanwälten. Antworten werden von KI erzeugt, können fehlerhaft, unvollständig oder veraltet sein und müssen vor der Verwendung für Planungs-, Genehmigungs- oder Bauentscheidungen anhand der zitierten Primärquellen überprüft werden. Die Verantwortung für Entscheidungen auf Grundlage von Piloti-Ausgaben verbleibt bei den Nutzenden und ihrer Organisation.',
        ],
      },
      {
        heading: '3. Konten und Organisationen',
        paragraphs: [
          'Der Zugang erfordert ein Konto innerhalb einer Organisation. Organisations-Administratorinnen und -Administratoren verwalten Mitgliedschaften, Rollen, Projekte, Budgets und die KI-Modellkonfiguration ihrer Organisation und sind für diese Entscheidungen verantwortlich.',
        ],
      },
      {
        heading: '4. KI-Modellauswahl',
        paragraphs: [
          'Organisations-Administratorinnen und -Administratoren können die von ihrer Organisation genutzten KI-Modelle zur Laufzeit aus dem validierten Katalog auswählen. Der Betreiber leitet den gesamten KI-Verkehr über sein konfiguriertes Gateway (OpenRouter); eine Modelländerung kann niemals das Gateway oder dessen Zugangsdaten ändern. Der gewählte vorgelagerte Modellanbieter verarbeitet jedoch Organisationsinhalte wie in der Datenschutzerklärung und im KI-Transparenzhinweis beschrieben. Die Organisation ist für ihre Modellauswahl einschließlich etwaiger Folgen für den Verarbeitungsort verantwortlich; jede Änderung wird protokolliert und ist umkehrbar.',
        ],
      },
      {
        heading: '5. Zulässige Nutzung',
        list: [
          'Keine rechtswidrigen Inhalte; keine Verletzung von Rechten Dritter durch hochgeladene Dokumente.',
          'Keine Versuche, Mandantentrennung, Authentifizierung, Rate-Limits oder Nutzungsbudgets zu umgehen.',
          'Keine Nutzung des Dienstes zur Erzeugung von Inhalten, die gegen geltendes Recht verstoßen.',
          'Hochgeladene Dokumente sind auf Material zu beschränken, zu dessen Verarbeitung die Organisation berechtigt ist.',
        ],
      },
      {
        heading: '6. Verfügbarkeit und Support',
        paragraphs: [
          'Der Dienst wird ohne zugesichertes Service-Level bereitgestellt, sofern nicht schriftlich anderes vereinbart ist. Geplante Wartungen und Abhängigkeiten von externen Anbietern (Identität, KI-Modelle, Websuche) können die Verfügbarkeit beeinträchtigen. [Vereinbarte SLA-/Support-Regelungen einfügen, falls zutreffend.]',
        ],
      },
      {
        heading: '7. Daten und Löschung',
        paragraphs: [
          'Organisationen bleiben Eigentümer ihrer Inhalte. Gelöschte Projekte sind während einer Karenzfrist wiederherstellbar und werden danach dauerhaft aus allen Speichern entfernt, sofern kein Legal Hold besteht. Details in der Datenschutzerklärung.',
        ],
      },
      {
        heading: '8. Haftung',
        paragraphs: [
          'Die Haftung für leichte Fahrlässigkeit ist im gesetzlich zulässigen Umfang ausgeschlossen; zwingende Haftung (z. B. für Personenschäden, nach dem Produkthaftungsgesetz) bleibt unberührt. Der Betreiber haftet nicht für Entscheidungen, die entgegen Punkt 2 im Vertrauen auf KI-generierte Ausgaben getroffen wurden. [Haftungsbeschränkungsklausel anwaltlich vervollständigen.]',
        ],
      },
      {
        heading: '9. Schlussbestimmungen',
        paragraphs: [
          'Es gilt österreichisches Recht unter Ausschluss der Verweisungsnormen und des UN-Kaufrechts. Gerichtsstand: [zuständiges Gericht]; für Verbraucher gelten zwingende Verbrauchergerichtsstände. Sollten einzelne Bestimmungen unwirksam sein, bleibt der Rest wirksam.',
        ],
      },
    ],
  },

  'ai-transparency': {
    title: 'KI-Transparenzhinweis',
    updated: '2026-07-10',
    intro:
      'Information gemäß Art. 50 der Verordnung (EU) 2024/1689 (KI-Verordnung) über das KI-System, mit dem Sie bei der Nutzung von Piloti interagieren.',
    sections: [
      {
        heading: 'Sie interagieren mit einem KI-System',
        paragraphs: [
          'Piloti beantwortet Ihre Fragen mit großen Sprachmodellen (LLMs). Chat-Antworten, Rechercheberichte und Rechtsgrundlagen-Karten sind KI-generierte Inhalte. Piloti kennzeichnet die zitierten Quellen, sodass jede Aussage anhand der zugrunde liegenden OIB-Richtlinie oder RIS-Fundstelle überprüft werden kann.',
        ],
      },
      {
        heading: 'Was das System tut',
        paragraphs: [
          'Piloti ruft Passagen aus den OIB-Richtlinien, österreichischen Rechtsquellen (RIS) und Ihren Projektdokumenten ab, führt optional Web-Recherchen durch und erstellt mit KI-Modellen eine Antwort mit Zitaten. Eine asynchrone Memory-Funktion kann aus Interaktionen Notizen auf Projekt- und Organisationsebene ableiten, um künftige Antworten zu verbessern; organisationsweite Memory-Einträge durch die KI sind standardmäßig deaktiviert.',
        ],
      },
      {
        heading: 'Grenzen und menschliche Aufsicht',
        paragraphs: [
          'KI-generierte Antworten können falsch, unvollständig oder veraltet sein, auch wenn sie überzeugend klingen. Piloti ist ein Recherchewerkzeug und als KI-Anwendung mit begrenztem Risiko eingestuft: Es trifft keine Entscheidungen über Gebäude, Genehmigungen oder Personen — die fachliche Prüfung jeder Antwort anhand der zitierten Primärquelle ist Teil der bestimmungsgemäßen Verwendung. Verwenden Sie Piloti-Ausgaben nicht als alleinige Grundlage sicherheitsrelevanter Planungsentscheidungen.',
        ],
      },
      {
        heading: 'Welche KI-Modelle eingesetzt werden',
        paragraphs: [
          'Standardmäßig nutzt Piloti Modelle, die über das API-Gateway OpenRouter geleitet werden (Referenzmodell: DeepSeek). Verschiedene interne Funktionen (Intent-Erkennung, Rückfragen, Recherche, Tiefenrecherche, Memory-Reflexion) können unterschiedliche Modelle verwenden.',
        ],
        notice:
          'Die Modellwahl ist dynamisch: Administratorinnen und Administratoren Ihrer Organisation können jede Funktion jederzeit auf ein anderes KI-Modell aus dem OpenRouter-Katalog umstellen, ohne dass eine neue Version des Dienstes erscheint. Jede Änderung wird gegen den Katalog validiert, versioniert, der handelnden Person zugeordnet und ist umkehrbar; für jede einzelne KI-Anfrage wird im Nutzungsledger festgehalten, welches Modell die Antwort tatsächlich erzeugt hat. Das Gateway (OpenRouter) und dessen Zugangsdaten können durch eine Modellauswahl niemals geändert werden — nur, welches Modell hinter diesem Gateway Ihre Organisation bedient.',
      },
      {
        heading: 'Nachvollziehbarkeit',
        paragraphs: [
          'Für jede Antwort protokolliert Piloti, welches Modell die Anfrage bedient hat, die verbrauchten Tokens und die Kosten, zugeordnet zu Organisation, Projekt und Nutzer. Administrative Änderungen der Modellkonfiguration erscheinen im Audit-Log der Organisation.',
        ],
      },
      {
        heading: 'Fragen',
        paragraphs: [
          `Bei Fragen zum KI-System, seinen Modellen oder diesem Hinweis wenden Sie sich an ${EMAIL}.`,
        ],
      },
    ],
  },

  subprocessors: {
    title: 'Externe Dienste & Subunternehmer',
    updated: '2026-07-10',
    intro:
      'Alle externen Dienste, die bei der Nutzung von Piloti Daten verarbeiten können, sowie die vom Betreiber selbst betriebene Infrastruktur. Diese Seite setzt die in der Datenschutzerklärung genannte Transparenzzusage um.',
    sections: [
      {
        heading: 'Externe Auftragsverarbeiter',
        table: {
          headers: ['Dienst', 'Zweck', 'Verarbeitete Daten', 'Standort', 'Erforderlich?'],
          rows: [
            [
              'WorkOS, Inc.',
              'Identität & Anmeldung (SSO, MFA), Autorisierung, Audit-Log-Speicherung',
              'Name, E-Mail, Organisationszugehörigkeit, Rollen, Anmeldeereignisse, Audit-Ereignisse (inkl. IP-Adresse)',
              'USA',
              'Ja',
            ],
            [
              'OpenRouter, Inc.',
              'KI-Gateway für alle Sprachmodell-, Embedding- und Bildmodell-Anfragen',
              'Chat-Nachrichten, Dokumentauszüge, abgerufene Vorschriftenpassagen, erzeugte Antworten',
              'USA (Gateway); vorgelagerter Modellanbieter variiert — siehe Hinweis unten',
              'Ja',
            ],
            [
              'Vorgelagerte KI-Modellanbieter (via OpenRouter, z. B. DeepSeek, OpenAI, Anthropic, Google, Meta, Mistral)',
              'Betrieb des von Ihrer Organisation gewählten KI-Modells',
              'Gleiche Inhalte wie OpenRouter',
              'Abhängig vom gewählten Modell (auch außerhalb EU/EWR möglich)',
              'Jeweils eines, je Organisation gewählt',
            ],
            [
              'Tavily',
              'Websuche für Recherchefragen',
              'Aus Ihren Fragen abgeleitete (KI-generierte) Suchanfragen',
              'USA',
              'Ja (für Web-Recherche)',
            ],
            [
              'Weitere Suchdienste (Exa, Serper/Google Scholar, DuckDuckGo, Polymarket)',
              'Alternative/optionale Suchwerkzeuge',
              'Aus Ihren Fragen abgeleitete Suchanfragen',
              'USA / verschieden',
              'Optional (nur falls konfiguriert)',
            ],
            [
              'Modal Labs',
              'Isolierte Code-Ausführung bei Tiefenrecherchen',
              'Code und Daten, die der Recherche-Agent ausführt',
              'USA',
              'Optional (nur falls konfiguriert)',
            ],
            [
              'NVIDIA (integrate.api.nvidia.com)',
              'Embeddings und Bild-/Tabellenextraktion aus Dokumenten (Standardkonfiguration; die Produktions-Referenzkonfiguration leitet dies stattdessen über OpenRouter)',
              'Dokument-Textabschnitte und Seitenbilder',
              'USA',
              'Abhängig von der Deployment-Konfiguration',
            ],
            [
              'Moonshot AI (Kimi)',
              'Alternative KI-Modellkonfiguration',
              'Chat-Nachrichten und Dokumentauszüge',
              'China',
              'Optional (Nicht-Standard-Konfiguration)',
            ],
            [
              'OpenAI, Inc. (direkt)',
              'Alternative Modellkonfiguration; Fallback für die Projekt-Zusammenfassung',
              'Chat-Nachrichten, Dokumentauszüge, Projektprofil-Text',
              'USA',
              'Optional (nur falls konfiguriert)',
            ],
            [
              'Hosting-Anbieter',
              'Betrieb der Anwendung, Datenbanken und des Objektspeichers',
              'Alle Anwendungsdaten',
              '[Ergänzen: Anbieter & Region]',
              'Ja',
            ],
          ],
        },
        notice:
          'Dynamische Modellanbieter: Da Organisations-Administratorinnen und -Administratoren das KI-Modell zur Laufzeit wechseln können (siehe KI-Transparenzhinweis), ist der tatsächliche vorgelagerte Modellanbieter nicht fest. Der gesamte KI-Verkehr läuft stets über OpenRouter; die Menge möglicher vorgelagerter Anbieter ist auf den OpenRouter-Katalog beschränkt; die für Ihre Organisation aktive Auswahl ist für Ihre Administratorinnen und Administratoren einsehbar, jede Änderung wird audit-protokolliert, und das antwortende Modell wird je Anfrage festgehalten.',
      },
      {
        heading: 'Selbst betriebene Infrastruktur (keine Drittverarbeitung)',
        table: {
          headers: ['Komponente', 'Zweck', 'Gespeicherte Daten'],
          rows: [
            ['PostgreSQL', 'Anwendungsdatenbank', 'Projekte, Konversationen, Memory, Nutzungsledger, Konfiguration'],
            ['MinIO (S3-kompatibel)', 'Objektspeicher', 'Hochgeladene Dokumente'],
            ['ChromaDB', 'Vektorindex', 'Embeddings von Dokumenten und Vorschriften'],
            ['Dragonfly (Redis-kompatibel)', 'Cache, Rate-Limiting', 'Kurzlebige Betriebsdaten'],
          ],
        },
      },
      {
        heading: 'Optionale Telemetrie (standardmäßig deaktiviert)',
        paragraphs: [
          'Die Codebasis unterstützt optionale Tracing-/Monitoring-Integrationen, die inaktiv sind, solange der Betreiber sie nicht ausdrücklich konfiguriert. Wird eine davon für ein Deployment aktiviert, wird diese Seite entsprechend aktualisiert, denn sie würden die unten genannten Daten erhalten:',
        ],
        list: [
          'LangSmith (LangChain, USA) — vollständige KI-Eingaben und -Antworten, falls Tracing aktiviert wird.',
          'OpenTelemetry/Phoenix-Trace-Export — KI-Anfrage-Traces, nur an einen vom Betreiber konfigurierten Endpunkt.',
          'Datadog RUM (USA) — Browser-Performance-/Nutzungstelemetrie, falls vom Deployment eingebunden.',
          'Weights & Biases (USA) — Evaluierungsläufe; derzeit mit keinem Codepfad verbunden.',
        ],
      },
      {
        heading: 'Entwicklungs- und Build-Dienste (keine Nutzerinhalte)',
        paragraphs: [
          'Die folgenden Dienste werden für Entwicklung und Build von Piloti genutzt. Sie verarbeiten Quellcode und Build-Artefakte, niemals Ihre Eingaben, Dokumente oder Kontodaten:',
        ],
        list: [
          'GitHub (USA) — Quellcode-Hosting, CI-Pipelines, Sicherheits-Scans.',
          'SonarSource / SonarQube Cloud (EU/CH) — statische Analyse des Quellcodes.',
          'Paket-Registries und Basis-Images (PyPI, npm, Docker Hub, NVIDIA NGC, Debian-/Node-Mirrors) — Software-Abhängigkeiten, die zur Build-Zeit geladen werden.',
          'Google Fonts — Schriften werden einmalig zur Build-Zeit geladen und selbst gehostet; Ihr Browser kontaktiert bei der Nutzung von Piloti niemals Google.',
        ],
      },
      {
        heading: 'Änderungen dieser Liste',
        paragraphs: [
          'Der Betreiber aktualisiert diese Seite, bevor neue Subunternehmer eingebunden werden, die Organisationsinhalte verarbeiten. Organisations-Administratorinnen und -Administratoren werden über wesentliche Änderungen informiert.',
        ],
      },
    ],
  },
}
