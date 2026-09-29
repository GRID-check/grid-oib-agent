/**
 * Piloti next to general AI assistants an office may already use, and next to
 * researching by hand. Piloti leads each page: what it does for an office in
 * Austria comes first, the other tool's fit after it and briefly. Each column
 * on the other side says only what that vendor's own pages say, read in the
 * month `checked` names. No prices for tools that do not publish a stable one
 * on the page we read.
 */
import type { LandingEntry } from '../../lib/landing'

export const vergleichAllgemein: LandingEntry[] = [
  {
    slug: 'chatgpt',
    checked: '2026-09',
    related: ['vergleich/microsoft-copilot', 'vergleich/perplexity', 'vergleich/ris-und-google', 'glossar/oib-richtlinien', 'anwendungen/gebaeudeklasse'],
    de: {
      title: 'ChatGPT für Baurecht in Österreich? Piloti im Vergleich',
      description:
        'ChatGPT oder Piloti für Baurecht in Österreich? Piloti zitiert Landesbauordnung und OIB-Richtlinie je Bundesland, geprüft und direkt im Projekt.',
      heading: 'ChatGPT oder Piloti für Baurecht?',
      lede: 'Piloti beantwortet Planungsfragen österreichischer Projekte aus den Landesbauordnungen und den OIB-Richtlinien, mit Bundesland, Ausgabe und geprüfter Fundstelle. ChatGPT schreibt in vielen Büros schon Mails und Zusammenfassungen. Hier, was beim Baurecht den Unterschied macht.',
      note: 'Angaben zu ChatGPT laut OpenAI (openai.com, help.openai.com), gelesen im September 2026. Preise nennen wir nicht, weil sie je Tarif und Region wechseln.',
      answer:
        'Für Baurecht in Österreich ist Piloti die bessere Wahl: Es zieht die Bauordnung des Bundeslands und die dort geltende OIB-Ausgabe heran, prüft jede Fundstelle gegen den Quelltext und hält das Ergebnis im Projekt fest. ChatGPT bleibt ein gutes Werkzeug für Texte.',
      blocks: [
        {
          kind: 'text',
          title: 'Was Piloti beim Baurecht leistet',
          body: [
            'Sie fragen, wie Sie eine Kollegin fragen würden: „Welche Gebäudeklasse hat das, und was heißt das für die Fluchtwege?“ Piloti zieht die Bauordnung des Bundeslands heran, in dem das Projekt liegt, dazu die OIB-Richtlinien und bei Bedarf Bundesgesetze wie das ASchG. Die Antwort beginnt mit dem Ergebnis, danach folgen Begründung, Annahmen und Fundstelle.',
            'Jede Fundstelle wird gegen den Quelltext geprüft, bevor sie anklickbar erscheint. Landesrecht zitiert Piloti so, wie ein Bescheid es nennt, etwa „Bauordnung für Wien, § …“, und die RIS-Quelle öffnet sich an der markierten Stelle. Fehlt ein entscheidender Fakt wie die Gebäudeklasse, fragt Piloti einmal nach oder nennt die Annahme.',
          ],
        },
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'ChatGPT',
          rows: [
            {
              label: 'Wofür gebaut',
              a: 'Planungsfragen österreichischer Projekte, belegt, bis zum Aktenvermerk und zur Freigabe',
              b: 'Allgemeiner Assistent für Text, Recherche, Analyse und Code',
            },
            {
              label: 'Baurecht',
              a: 'Die neun Landesbauordnungen aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Bundesgesetze wie das ASchG',
              b: 'Kein eigener Bestand; antwortet aus dem Modell, aus einer Websuche oder aus Ihren Dateien',
            },
            {
              label: 'Bundesland und Ausgabe',
              a: 'Fragt nach dem Bundesland oder nennt die Annahme; nennt die OIB-Ausgabe, die dort gilt, wenn sie den Wert verändert',
              b: 'Nur so gut, wie Sie beides in der Frage angeben und die Quelle selbst prüfen',
            },
            {
              label: 'Belege',
              a: 'Fundstelle wie in einem Bescheid, vor dem Anzeigen gegen den Quelltext geprüft; RIS-Quellen öffnen an der markierten Stelle',
              b: 'Links bei Websuche und angebundenen Firmenquellen; ohne Quelle kann ein Sprachmodell Fundstellen erfinden',
            },
            {
              label: 'Projekt und Team',
              a: 'Projekte mit Plänen, Dateien, Fassungen, Projektgedächtnis, Aufgaben und Freigabe im Posteingang',
              b: 'Unterhaltungen; in ChatGPT Business laut OpenAI Anbindung von Firmenwissen wie SharePoint und Google Drive, mit Links zurück zur Quelle',
            },
            {
              label: 'Training',
              a: 'Kein Training mit Büro-Daten',
              b: 'Laut OpenAI: Business und Enterprise standardmäßig kein Training; Free und Plus standardmäßig an, in den Einstellungen abschaltbar',
            },
          ],
          note: 'Angaben zu ChatGPT laut OpenAI, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Österreichisches Baurecht als Grundlage: die neun Landesbauordnungen aus dem RIS und die OIB-Richtlinien, zitiert bis zum Paragrafen oder Punkt.',
              'Bundesland und Ausgabe als Teil der Antwort. Fehlt das Bundesland oder die Gebäudeklasse, fragt Piloti nach oder nennt die Annahme.',
              'Geprüfte Fundstellen: Jede wird gegen den Quelltext abgeglichen, bevor sie erscheint.',
              'Pläne als Bild: Piloti sieht Grundriss und Schnitt an und markiert, welche Zeichnung auf dem Blatt es gelesen hat.',
              'Das Projekt als Arbeitsort: Aufgaben, Tiefenrecherche mit Bericht, Aktenvermerke zur Freigabe und ein Gedächtnis für das schon Geklärte.',
            ],
          },
          right: {
            title: 'Wofür ChatGPT gut passt',
            items: [
              'Texte: Mails an Bauherr:innen, Baubeschreibungen, Zusammenfassungen langer Bescheide oder Gutachten.',
              'Breite: Excel-Formeln, Übersetzungen, Code, weit über das Baurecht hinaus.',
              'Sofort nutzbar, mit öffentlichen Tarifen.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Warum eine gute Formulierung nicht reicht',
          body: [
            'Eine Frage wie „Wie lang darf der Fluchtweg hier sein?“ hat in Österreich nicht eine Antwort. Sie hängt vom Bundesland ab, von der OIB-Ausgabe, die das Land für verbindlich erklärt hat, und von der Gebäudeklasse. Laut OIB-Übersicht gilt die Ausgabe 2023 in Wien, Kärnten, Niederösterreich, Oberösterreich und Tirol ganz oder teilweise, in den anderen vier Ländern im Allgemeinen noch die Ausgabe 2019. Ein allgemeines Sprachmodell hat das nicht verlässlich parat und sagt selten dazu, von welcher Fassung es ausgeht. Piloti nennt die Ausgabe, die im Bundesland gilt, wenn sie den Wert verändert.',
            'Dazu kommt das Zitat. Ein Sprachmodell schreibt Paragrafen, die plausibel klingen, auch wenn es sie so nicht gibt. Piloti gleicht jede Fundstelle vor dem Anzeigen mit dem Quelltext ab, und ein Klick führt an die Stelle im RIS oder in der OIB-Richtlinie.',
            'Ausführlicher dazu im Journal-Beitrag „ChatGPT für Baurecht? Wo es an Grenzen stößt“.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Die Verantwortung für den Entwurf bleibt beim Planungsbüro. Piloti nennt zu jeder Antwort die Quellen, damit Sie sie mit einem Klick prüfen, und fragt nach, wenn ein entscheidender Fakt fehlt. Jede Antwort lässt sich als Word herunterladen und in den Akt legen.',
          ],
        },
      ],
      faq: [
        {
          q: 'Kann ich ChatGPT für Baurecht in Österreich nutzen?',
          a: 'Für Begriffe und einen ersten Überblick ja. ChatGPT bringt aber keinen eigenen Bestand an Landesbauordnungen und OIB-Richtlinien mit; jede Fundstelle müssten Sie selbst im RIS nachschlagen. Piloti zieht das Landesrecht des Projekts heran und prüft jede Fundstelle gegen den Quelltext, bevor sie erscheint.',
        },
        {
          q: 'Ist ChatGPT im Planungsbüro DSGVO-konform?',
          a: 'Das hängt vom Tarif und von Ihrer Vereinbarung mit OpenAI ab, nicht vom Werkzeug allein. Laut OpenAI werden Business- und Enterprise-Daten standardmäßig nicht zum Training verwendet, in Free und Plus schon, abschaltbar in den Einstellungen; wer Pläne oder Namen von Bauherr:innen in ein privates Konto kopiert, sollte das wissen. Piloti trainiert keine Modelle mit Büro-Daten, und das Büroarchiv sieht kein anderes Büro.',
        },
        {
          q: 'Welche ChatGPT-Alternative passt für Architekten in Österreich?',
          a: 'Für Fragen, deren Antwort in eine Einreichung oder einen Aktenvermerk geht, braucht es österreichisches Baurecht, Bundesland-Logik und geprüfte Fundstellen. Dafür ist Piloti gebaut, samt Projekt, Aufgaben und Freigabe. Für Texte und allgemeine Fragen bleibt ChatGPT eine gute Ergänzung.',
        },
      ],
    },
    en: {
      title: 'ChatGPT for Austrian building law? Piloti compared',
      description:
        'ChatGPT or Piloti for Austrian building law? Piloti cites the state building code and OIB guideline for each state, checked and inside the project.',
      heading: 'ChatGPT or Piloti for building law?',
      lede: 'Piloti answers planning questions on Austrian projects from the state building codes and the OIB guidelines, with state, edition and a checked citation. Many offices already use ChatGPT for emails and summaries. Here is what makes the difference for building law.',
      note: 'ChatGPT details as stated by OpenAI (openai.com, help.openai.com), read in September 2026. We do not list prices, because they vary by plan and region.',
      answer:
        'For Austrian building law, Piloti is the better choice: it draws on the state’s building code and the OIB edition in force there, checks every citation against the source text and records the result in the project. ChatGPT remains a good tool for writing.',
      blocks: [
        {
          kind: 'text',
          title: 'What Piloti does for building law',
          body: [
            'You ask the way you would ask a colleague: “Which building class is this, and what does that mean for the escape routes?” Piloti draws on the building code of the state the project is in, the OIB guidelines and, where needed, federal law such as the ASchG. The answer starts with the result, followed by reasoning, assumptions and citation.',
            'Every citation is checked against the source text before it appears as a link. Piloti cites state law the way an official decision does, for example “Bauordnung für Wien, § …”, and the RIS source opens at the marked passage. If a deciding fact such as the building class is missing, Piloti asks once or states its assumption.',
          ],
        },
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'ChatGPT',
          rows: [
            {
              label: 'Built for',
              a: 'Planning questions on Austrian projects, with evidence, through to the file note and approval',
              b: 'General assistant for writing, research, analysis and code',
            },
            {
              label: 'Building law',
              a: 'The nine state building codes from RIS, OIB guidelines, register of standards, federal law such as ASchG',
              b: 'No body of its own; answers from the model, a web search or your files',
            },
            {
              label: 'State and edition',
              a: 'Asks for the state or states its assumption; names the OIB edition in force there when it changes the value',
              b: 'Only as good as your question states both and you check the source yourself',
            },
            {
              label: 'Evidence',
              a: 'Citation the way an official decision cites, checked against the source text before it is shown; RIS sources open at the marked passage',
              b: 'Links with web search and connected company sources; without a source, a language model can invent citations',
            },
            {
              label: 'Project and team',
              a: 'Projects with drawings, files, versions, project memory, tasks and approval in the inbox',
              b: 'Conversations; in ChatGPT Business, according to OpenAI, company knowledge such as SharePoint and Google Drive can be connected, with links back to the source',
            },
            {
              label: 'Training',
              a: 'No training on office data',
              b: 'According to OpenAI: Business and Enterprise not used for training by default; Free and Plus on by default, can be switched off in settings',
            },
          ],
          note: 'ChatGPT details as stated by OpenAI, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where Piloti is ahead',
            items: [
              'Austrian building law as the foundation: the nine state building codes from RIS and the OIB guidelines, cited down to section or clause.',
              'State and edition as part of the answer. If the state or the building class is missing, Piloti asks or states its assumption.',
              'Checked citations: each one is matched against the source text before it appears.',
              'Drawings as images: Piloti looks at plan and section and marks which drawing on the sheet it read.',
              'The project as the place of work: tasks, in-depth research with a report, file notes sent for approval, and a memory of what is already settled.',
            ],
          },
          right: {
            title: 'What ChatGPT is good for',
            items: [
              'Writing: emails to clients, building descriptions, summaries of long permits or expert reports.',
              'Breadth: spreadsheet formulas, translations, code, far beyond building law.',
              'Ready to use, with public plans.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Why good phrasing is not enough',
          body: [
            'A question like “How long may the escape route be here?” has no single answer in Austria. It depends on the state, on the OIB edition that state has declared binding, and on the building class. According to the OIB overview, the 2023 edition applies in whole or in part in Vienna, Carinthia, Lower Austria, Upper Austria and Tyrol, and in the other four states the 2019 edition generally still applies. A general language model does not have this reliably to hand and rarely says which version it assumes. Piloti names the edition in force in the state when it changes the value.',
            'Then there is the citation. A language model writes sections that sound plausible even when they do not exist in that form. Piloti matches every citation against the source text before showing it, and one click leads to the passage in RIS or in the OIB guideline.',
            'More on this in our journal article “ChatGPT for building law? Where it falls short”.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Responsibility for the design stays with the planning office. Piloti names the source of every answer so that you can check it in one click, and asks when a deciding fact is missing. Every answer can be downloaded as Word and filed.',
          ],
        },
      ],
      faq: [
        {
          q: 'Can I use ChatGPT for building law in Austria?',
          a: 'For terms and a first overview, yes. But ChatGPT brings no body of state building codes and OIB guidelines of its own; you would have to look every citation up in RIS yourself. Piloti draws on the project’s state law and checks every citation against the source text before it appears.',
        },
        {
          q: 'Is ChatGPT GDPR-compliant for a planning office?',
          a: 'That depends on the plan and on your agreement with OpenAI, not on the tool alone. According to OpenAI, Business and Enterprise data is not used for training by default; on Free and Plus it is, and that can be switched off in settings. Anyone copying drawings or clients’ names into a personal account should know this. Piloti does not train models on office data, and no other office sees the office archive.',
        },
        {
          q: 'Which ChatGPT alternative fits architects in Austria?',
          a: 'For questions whose answer goes into a submission or a file note, you need Austrian building law, state logic and checked citations. Piloti is built for that, with project, tasks and approval. For writing and general questions, ChatGPT remains a good complement.',
        },
      ],
    },
  },
  {
    slug: 'microsoft-copilot',
    checked: '2026-09',
    related: ['vergleich/chatgpt', 'vergleich/notebooklm', 'anwendungen/bueroarchiv', 'baurecht/wien'],
    de: {
      title: 'Microsoft Copilot für Architekten: Piloti im Vergleich',
      description:
        'Microsoft Copilot oder Piloti im Planungsbüro? Piloti bringt österreichisches Baurecht, die OIB-Ausgabe je Bundesland und Freigaben ins Projekt.',
      heading: 'Microsoft Copilot oder Piloti?',
      lede: 'Piloti beantwortet Planungsfragen aus den neun Landesbauordnungen und den OIB-Richtlinien und führt sie im Projekt bis zum freigegebenen Aktenvermerk. Copilot steckt in vielen Büros schon in Microsoft 365. Hier, was jedes Werkzeug für Baurecht und Planung leistet.',
      note: 'Gemeint ist Microsoft Copilot, früher Microsoft 365 Copilot. Angaben laut Microsoft (microsoft.com, learn.microsoft.com), gelesen im September 2026.',
      answer:
        'Für Fragen zum österreichischen Baurecht ist Piloti die bessere Wahl: Es bringt die Landesbauordnungen aus dem RIS und die OIB-Richtlinien mit, nennt die Ausgabe, die im Bundesland gilt, und führt die Antwort bis zur Freigabe im Projekt. Copilot passt für Mails und Dateien in Microsoft 365.',
      blocks: [
        {
          kind: 'text',
          title: 'Was Piloti im Planungsbüro übernimmt',
          body: [
            'Piloti arbeitet mit der Bauordnung und den Bautechnikvorschriften des Landes, in dem Ihr Projekt steht, für Wien etwa auch mit der Wiener Bautechnikverordnung 2023, dem Wiener Garagengesetz 2008 und den MA 37 Merkblättern. Es zitiert so, wie ein Bescheid es tut, und öffnet die RIS-Quelle an der markierten Stelle.',
            'Aus der Frage wird Arbeit im Projekt: „Mach den Einreichcheck bis Freitag“ läuft als Aufgabe unter Ihrem Namen und Ihren Rechten, eine Tiefenrecherche legt ihren Bericht mit Befundmatrix unter „Berichte“ ab, und ein Aktenvermerk geht zur Freigabe in den Posteingang.',
          ],
        },
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'Microsoft Copilot',
          rows: [
            {
              label: 'Wofür gebaut',
              a: 'Planungsfragen österreichischer Projekte, belegt, bis zum Aktenvermerk und zur Freigabe',
              b: 'Assistent in Microsoft 365, von Word und Outlook bis Teams',
            },
            {
              label: 'Wissensbasis',
              a: 'Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Büroarchiv, Projektdokumente, Web',
              b: 'Daten der Organisation in Microsoft 365 über Microsoft Graph: Dokumente, E-Mails, Kalender, Chats, Besprechungen; Websuche über Bing',
            },
            {
              label: 'Berechtigungen',
              a: 'Aufgaben laufen unter Ihrem Namen und Ihren Rechten; das Büroarchiv sieht kein anderes Büro',
              b: 'Zeigt laut Microsoft nur, was die Person sehen darf',
            },
            {
              label: 'Baurecht',
              a: 'Bundesland und OIB-Ausgabe als Teil der Antwort, Fundstelle bis zum Paragrafen oder Punkt',
              b: 'Kein eigener Bestand an österreichischem Baurecht; antwortet aus Ihren Dokumenten und aus dem Web',
            },
            {
              label: 'Genauigkeit',
              a: 'Fundstellen vor dem Anzeigen gegen den Quelltext geprüft',
              b: 'Microsoft schreibt selbst, dass Antworten nicht garantiert zu 100 % sachlich richtig sind',
            },
            {
              label: 'Projektarbeit',
              a: 'Projekte mit Plänen, Fassungen, Projektgedächtnis, Aufgaben und Freigabe im Posteingang',
              b: 'Arbeitet in Ihren Dateien und Anwendungen; Ablage und Freigabe regeln Sie in SharePoint und Teams wie bisher',
            },
            {
              label: 'Training',
              a: 'Kein Training mit Büro-Daten',
              b: 'Laut Microsoft kein Training der Basismodelle mit Eingaben, Antworten und über Microsoft Graph abgerufenen Daten',
            },
          ],
          note: 'Angaben zu Microsoft Copilot laut Microsoft, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Österreichisches Baurecht als eigene Grundlage: neun Landesbauordnungen aus dem RIS und die OIB-Richtlinien.',
              'Die Ausgabe, die im Bundesland gilt. Piloti nennt sie, wenn sie den Wert verändert, und fragt nach, wenn Bundesland oder Gebäudeklasse fehlen.',
              'Pläne als Bild: Piloti sieht Grundriss und Schnitt an und markiert, welche Zeichnung auf dem Blatt es gelesen hat.',
              'Ein Ablauf für Planungsfragen: Tiefenrecherche mit Bericht im Projekt, Befunde als offene Punkte, Aktenvermerke mit Freigeben, Änderungen anfordern oder Ablehnen.',
            ],
          },
          right: {
            title: 'Wofür Copilot gut passt',
            items: [
              'Das Büro-Wissen, wo es schon liegt: Protokolle, Mails, Besprechungen und Dokumente in Microsoft 365, ohne Umzug.',
              'Eingebaut in Word, Outlook und Teams: Mails zusammenfassen, Besprechungen nachbereiten, Entwürfe schreiben.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Woher Copilot baurechtliche Antworten nimmt',
          body: [
            'Copilot antwortet aus zwei Quellen: aus den Daten Ihrer Organisation und aus dem Web über Bing. Liegt in Ihrem SharePoint die aktuelle Fassung der Bauordnung, findet Copilot sie. Liegt dort eine alte, findet es die alte. Welche OIB-Ausgabe in welchem Bundesland verbindlich ist, entnimmt Copilot dem, was es gerade findet.',
            'Piloti zieht je Bundesland die Landesgesetze aus dem RIS heran und nennt die OIB-Ausgabe, die dort laut OIB-Übersicht gilt, wenn sie den Wert verändert. Das Zitat lautet so, wie ein Bescheid es schreibt: „Bauordnung für Wien, § …“.',
          ],
        },
        {
          kind: 'text',
          title: 'Wie beides zusammenpasst',
          body: [
            'Copilot und Piloti schließen einander nicht aus. Für Mails, Besprechungsnotizen und die eigenen Microsoft-365-Dateien ist Copilot das nähere Werkzeug, für die Frage, was ein Projekt in Salzburg oder Tirol erfüllen muss, Piloti.',
            'Dokumente aus SharePoint oder vom Dateiserver kommen durch Hochladen ins Projekt oder ins Büroarchiv, auch als ganzer Ordner: PDF, Word, Excel, PowerPoint, CSV und Bilder. Was dort liegt, zieht Piloti neben dem Baurecht heran, und das Büroarchiv sieht kein anderes Büro.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Die Verantwortung für den Entwurf bleibt beim Planungsbüro. Piloti nennt zu jeder Antwort die Quellen, damit Sie sie prüfen können, und fragt nach, wenn ein entscheidender Fakt wie das Bundesland fehlt.',
          ],
        },
      ],
      faq: [
        {
          q: 'Kann Microsoft Copilot österreichisches Baurecht?',
          a: 'Copilot hat keinen eigenen Bestand an Landesbauordnungen und OIB-Richtlinien. Es antwortet aus Ihren Dateien in Microsoft 365 und aus dem Web über Bing, also so gut wie die Fassungen, die es dort findet. Piloti zieht das Landesrecht des Projekts aus dem RIS und die OIB-Richtlinien heran und prüft jede Fundstelle gegen den Quelltext.',
        },
        {
          q: 'Was kostet Microsoft Copilot?',
          a: 'Microsoft nennt auf seiner US-Website für die Enterprise-Variante 30 US-Dollar je Nutzer:in und Monat bei jährlicher Zahlung; die Business-Variante setzt eine Microsoft-365-Business-Lizenz voraus, und Copilot Chat ist für berechtigte Microsoft-365-Nutzer:innen ohne Aufpreis enthalten. Pilotbüros vereinbaren die Bedingungen direkt mit uns Gründern.',
        },
        {
          q: 'Trainiert Microsoft mit den Daten aus Copilot?',
          a: 'Laut Microsoft werden Eingaben, Antworten und über Microsoft Graph abgerufene Daten nicht zum Training der Basismodelle verwendet. Piloti trainiert ebenfalls keine Modelle mit Büro-Daten, und Pläne bleiben Eigentum des Büros.',
        },
        {
          q: 'Wo verarbeitet Copilot die Daten?',
          a: 'Microsoft verarbeitet Copilot-Daten europäischer Kunden laut eigener Angabe innerhalb seiner europäischen Datengrenze, mit Ausnahmen für einzelne Modellanbieter. Wie Piloti mit Daten umgeht, steht in der Datenschutzerklärung: kein Training mit Büro-Daten, Pläne bleiben Eigentum des Büros, das Büroarchiv sieht kein anderes Büro.',
        },
      ],
    },
    en: {
      title: 'Microsoft Copilot for architects: Piloti compared',
      description:
        'Microsoft Copilot or Piloti in a planning office? Piloti brings Austrian building law, the OIB edition for each state and approvals into the project.',
      heading: 'Microsoft Copilot or Piloti?',
      lede: 'Piloti answers planning questions from the nine state building codes and the OIB guidelines and carries them in the project through to the approved file note. Copilot is already built into Microsoft 365 in many offices. Here is what each tool does for building law and planning.',
      note: 'This means Microsoft Copilot, formerly Microsoft 365 Copilot. Details as stated by Microsoft (microsoft.com, learn.microsoft.com), read in September 2026.',
      answer:
        'For questions on Austrian building law, Piloti is the better choice: it brings the state building codes from RIS and the OIB guidelines, names the edition in force in the state, and carries the answer through to approval in the project. Copilot fits emails and files in Microsoft 365.',
      blocks: [
        {
          kind: 'text',
          title: 'What Piloti takes on in a planning office',
          body: [
            'Piloti works with the building code and building-technology rules of the state your project is in, for Vienna also the Building Technology Ordinance 2023, the Vienna Garage Act 2008 and the MA 37 guidance sheets. It cites the way an official decision does and opens the RIS source at the marked passage.',
            'A question becomes work in the project: “Do the submission check by Friday” runs as a task under your name and your permissions, in-depth research files its report with a findings matrix under “Reports”, and a file note goes to the inbox for approval.',
          ],
        },
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'Microsoft Copilot',
          rows: [
            {
              label: 'Built for',
              a: 'Planning questions on Austrian projects, with evidence, through to the file note and approval',
              b: 'Assistant in Microsoft 365, from Word and Outlook to Teams',
            },
            {
              label: 'Knowledge base',
              a: 'State law from RIS, OIB guidelines, register of standards, office archive, project documents, web',
              b: 'The organisation’s Microsoft 365 data via Microsoft Graph: documents, email, calendar, chats, meetings; web search via Bing',
            },
            {
              label: 'Permissions',
              a: 'Tasks run under your name and your permissions; no other office sees the office archive',
              b: 'According to Microsoft, shows only what the user has permission to see',
            },
            {
              label: 'Building law',
              a: 'State and OIB edition as part of the answer, citation down to section or clause',
              b: 'No body of Austrian building law of its own; answers from your documents and the web',
            },
            {
              label: 'Accuracy',
              a: 'Citations checked against the source text before they are shown',
              b: 'Microsoft itself says responses aren’t guaranteed to be 100 % factual',
            },
            {
              label: 'Project work',
              a: 'Projects with drawings, versions, project memory, tasks and approval in the inbox',
              b: 'Works in your files and apps; filing and approval stay in SharePoint and Teams as before',
            },
            {
              label: 'Training',
              a: 'No training on office data',
              b: 'According to Microsoft, prompts, responses and data accessed through Microsoft Graph aren’t used to train foundation models',
            },
          ],
          note: 'Microsoft Copilot details as stated by Microsoft, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where Piloti is ahead',
            items: [
              'Austrian building law as its own foundation: nine state building codes from RIS and the OIB guidelines.',
              'The edition in force in the state. Piloti names it when it changes the value, and asks when the state or building class is missing.',
              'Drawings as images: Piloti looks at plan and section and marks which drawing on the sheet it read.',
              'A workflow for planning questions: in-depth research with a report in the project, findings as open points, file notes with Approve, Request changes or Reject.',
            ],
          },
          right: {
            title: 'What Copilot is good for',
            items: [
              'Your office’s knowledge where it already lives: minutes, emails, meetings and documents in Microsoft 365, without moving anything.',
              'Built into Word, Outlook and Teams: summarising emails, following up meetings, writing drafts.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Where Copilot’s building-law answers come from',
          body: [
            'Copilot answers from two sources: your organisation’s data and the web via Bing. If your SharePoint holds the current version of the building code, Copilot finds it. If it holds an old one, it finds the old one. Which OIB edition is binding in which state, Copilot takes from whatever it happens to find.',
            'Piloti draws on each state’s laws from RIS and names the OIB edition in force there according to the OIB overview when it changes the value. The citation reads the way an official decision writes it: “Bauordnung für Wien, § …”.',
          ],
        },
        {
          kind: 'text',
          title: 'How the two fit together',
          body: [
            'Copilot and Piloti do not exclude each other. For emails, meeting notes and your own Microsoft 365 files, Copilot is the closer tool; for what a project in Salzburg or Tyrol must meet, Piloti.',
            'Documents from SharePoint or the file server come in by upload to the project or the office archive, including whole folders: PDF, Word, Excel, PowerPoint, CSV and images. Piloti draws on what is there alongside building law, and no other office sees the office archive.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Responsibility for the design stays with the planning office. Piloti names the source of every answer so that you can check it, and asks when a deciding fact such as the state is missing.',
          ],
        },
      ],
      faq: [
        {
          q: 'Does Microsoft Copilot handle Austrian building law?',
          a: 'Copilot has no body of state building codes and OIB guidelines of its own. It answers from your files in Microsoft 365 and from the web via Bing, so it is as good as the versions it finds there. Piloti draws on the project’s state law from RIS and the OIB guidelines and checks every citation against the source text.',
        },
        {
          q: 'What does Microsoft Copilot cost?',
          a: 'On its US website, Microsoft lists $30 per user per month, paid yearly, for the Enterprise variant; the Business variant requires a Microsoft 365 Business licence, and Copilot Chat is included at no extra cost for eligible Microsoft 365 users. Pilot offices agree terms directly with us, the founders.',
        },
        {
          q: 'Does Microsoft train on Copilot data?',
          a: 'According to Microsoft, prompts, responses and data accessed through Microsoft Graph are not used to train foundation models. Piloti does not train models on office data either, and drawings remain the office’s property.',
        },
        {
          q: 'Where does Copilot process data?',
          a: 'Microsoft says it processes Copilot data of European customers within its European data boundary, with exceptions for individual model providers. How Piloti handles data is set out in its privacy policy: no training on office data, drawings remain the office’s property, and no other office sees the office archive.',
        },
      ],
    },
  },
  {
    slug: 'notebooklm',
    checked: '2026-09',
    related: ['vergleich/chatgpt', 'vergleich/ris-und-google', 'glossar/oib-richtlinien', 'anwendungen/bueroarchiv'],
    de: {
      title: 'NotebookLM (Gemini Notebook) für Baurecht: Vergleich',
      description:
        'NotebookLM (Gemini Notebook) oder Piloti für Baurecht in Österreich? Piloti bringt Landesbauordnungen und OIB-Richtlinien mit, Sie sammeln nichts.',
      heading: 'NotebookLM oder Piloti?',
      lede: 'Piloti bringt das österreichische Baurecht mit; NotebookLM, das Google inzwischen Gemini Notebook nennt, antwortet aus den Quellen, die Sie selbst hinzufügen. Beide zitieren. Der Unterschied liegt darin, wer die Quellen sammelt und wer im Blick hat, welche Fassung im Bundesland gilt.',
      note: 'Angaben zu NotebookLM (Gemini Notebook) laut Google, gelesen im September 2026.',
      answer:
        'Für Baurecht in Österreich ist Piloti die bessere Wahl: Die Landesbauordnungen aus dem RIS und die OIB-Richtlinien sind schon da, Piloti nennt die Ausgabe, die im Bundesland gilt, und bettet die Antwort in die Projektarbeit ein. NotebookLM (Gemini Notebook) passt für Sammlungen, die Sie selbst zusammenstellen.',
      blocks: [
        {
          kind: 'text',
          title: 'Was Piloti mitbringt',
          body: [
            'Mit Piloti beginnt die Arbeit bei der Frage, nicht beim Sammeln. Die neun Landesbauordnungen und verwandtes Landesrecht aus dem RIS, die OIB-Richtlinien, ein Normenverzeichnis und Bundesgesetze wie ASchG und Arbeitsstättenverordnung stehen bereit. Dazu kommen Ihr Büroarchiv, das kein anderes Büro sieht, und die Dokumente des Projekts.',
            'Die Antwort beginnt mit dem Ergebnis als kopierbarem Wert, danach folgen Begründung, Annahmen und Fundstelle bis Paragraf, Punkt oder Seite, etwa „Pkt. 3.5.2 · S. 7“. Prüfungen nach Gebäudeklasse erscheinen als Tabelle mit Quelle und Ergebnis je Zeile.',
          ],
        },
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'NotebookLM (Gemini Notebook)',
          rows: [
            {
              label: 'Prinzip',
              a: 'Österreichisches Baurecht ist schon da, dazu Ihr Büroarchiv und Ihre Projektdokumente',
              b: 'Antworten auf Grundlage der Quellen, die Sie in ein Notizbuch geben',
            },
            {
              label: 'Quellen',
              a: 'Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Bundesgesetze; Uploads als PDF, Word, Excel, PowerPoint, CSV, Bild oder ganzer Ordner',
              b: 'PDFs, Websites, YouTube, Audio, Google Docs und Slides; bis 500.000 Wörter oder 200 MB je Quelle',
            },
            {
              label: 'Bundesland und Ausgabe',
              a: 'Zieht die Gesetze des Bundeslands heran und nennt die OIB-Ausgabe, die dort gilt',
              b: 'Sie entscheiden, welche Fassung Sie hinzufügen; bis 50 Quellen je Notizbuch im kostenlosen Tarif, 100 bis 600 in höheren',
            },
            {
              label: 'Belege',
              a: 'Fundstelle bis Paragraf, Punkt oder Seite, vor dem Anzeigen gegen den Quelltext geprüft',
              b: 'Zitate im Text, die auf die Stelle in Ihrer Quelle verweisen',
            },
            {
              label: 'Zusammenarbeit',
              a: 'Projekte mit Fassungen, Aufgaben, Projektgedächtnis und Freigabe im Posteingang',
              b: 'Notizbücher lassen sich teilen',
            },
            {
              label: 'Training',
              a: 'Kein Training mit Büro-Daten',
              b: 'Laut Google werden hochgeladene Daten nie zum Training verwendet',
            },
          ],
          note: 'Angaben zu NotebookLM (Gemini Notebook) laut Google, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Die Quellen sind schon da: neun Landesbauordnungen und verwandtes Landesrecht aus dem RIS, OIB-Richtlinien, für Wien auch Bautechnikverordnung 2023, Garagengesetz 2008 und MA 37 Merkblätter.',
              'Die Ausgabe folgt dem Bundesland. Laut OIB-Übersicht gilt die Ausgabe 2023 nicht überall; Piloti nennt die Ausgabe, die im Bundesland gilt, wenn sie den Wert verändert.',
              'Rückfragen bei fehlenden Fakten: Fehlt die Gebäudeklasse oder das Bundesland, fragt Piloti nach oder nennt die Annahme.',
              'Fragen werden zu Arbeit im Projekt: Aufgaben, Tiefenrecherche mit Bericht, Aktenvermerk zur Freigabe.',
            ],
          },
          right: {
            title: 'Wofür NotebookLM gut passt',
            items: [
              'Sammlungen, deren Quellen Sie selbst bestimmen: Wettbewerbsunterlagen, Fachvorträge, Literatur zu einem Entwurfsthema.',
              'Viele Formate, auch Video und Audio, etwa die Aufzeichnung eines Vortrags zu einer Novelle.',
              'Sofort nutzbar, kostenlos oder in Google Workspace enthalten.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Was ein Baurechts-Notizbuch an Pflege braucht',
          body: [
            'Wer NotebookLM für Baurecht nutzt, baut sein eigenes Regelwerk: die OIB-Richtlinien in der Ausgabe, die im Bundesland gilt, die Bauordnung und die Bautechnikvorschriften jedes Landes, in dem das Büro plant, dazu Merkblätter. In Wien sind das die Bauordnung für Wien und die Wiener Bautechnikverordnung 2023, in Salzburg das Bautechnikgesetz 2015 und das Baupolizeigesetz 1997, in Tirol die Tiroler Bauordnung 2022. Neun Bundesländer, neun Sammlungen.',
            'Dann beginnt die Pflege. Laut OIB-Übersicht ist die OIB-Richtlinie 6 in der Ausgabe 2025 bisher nur in Tirol und Wien in Kraft, die Ausgabe 2027 wird vorbereitet, und Landesgesetze werden novelliert. Jede neue Fassung muss jemand im Büro bemerken, hinzufügen und die alte aus dem Notizbuch nehmen. Übersieht man das, zitiert das Notizbuch sauber aus einer veralteten Quelle. Mit Piloti stellen Sie die Frage, und das Landesrecht des Projekts ist schon zur Hand.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Die Verantwortung für den Entwurf bleibt beim Planungsbüro. Piloti nennt zu jeder Antwort die Quellen, damit Sie sie prüfen können, und fragt nach, wenn ein entscheidender Fakt wie das Bundesland fehlt. Was der Bebauungsplan für Ihr Grundstück festlegt, liest Piloti aus dem Plan im Projekt; fehlt er, sagt es, wo Sie nachsehen.',
          ],
        },
      ],
      faq: [
        {
          q: 'Ist NotebookLM dasselbe wie Gemini Notebook?',
          a: 'Ja. Google führt NotebookLM inzwischen unter dem Namen Gemini Notebook. Das Prinzip: Antworten auf Grundlage der Quellen, die Sie in ein Notizbuch geben, mit Zitaten im Text.',
        },
        {
          q: 'Kann ich die OIB-Richtlinien in NotebookLM hochladen?',
          a: 'Ja, als PDF wie jedes andere Dokument. Sie wählen dann selbst die Ausgabe, die im Bundesland Ihres Projekts gilt, und tauschen sie aus, wenn sich das ändert. Laut OIB-Übersicht gilt die Ausgabe 2023 nicht in allen Bundesländern; maßgeblich ist die Bautechnikverordnung oder das Gesetz des Landes. Piloti nennt die Ausgabe, die im Bundesland gilt, von sich aus.',
        },
        {
          q: 'Wie viele Quellen passen in ein Notizbuch?',
          a: 'Laut Google bis 50 Quellen je Notizbuch im kostenlosen Tarif und 100 bis 600 in höheren Tarifen, jede bis 500.000 Wörter oder 200 MB. Beim Baurecht ist selten die Menge die Grenze, eher die Pflege: welche Fassung gerade gilt.',
        },
        {
          q: 'Verwendet Google meine Dokumente zum Training?',
          a: 'Laut Google werden hochgeladene Daten nie zum Training verwendet. Auch Piloti trainiert keine Modelle mit Büro-Daten, und Pläne bleiben Eigentum des Büros.',
        },
      ],
    },
    en: {
      title: 'NotebookLM (Gemini Notebook) for building law: compared',
      description:
        'NotebookLM (Gemini Notebook) or Piloti for Austrian building law? Piloti brings the state building codes and OIB guidelines, so you collect nothing.',
      heading: 'NotebookLM or Piloti?',
      lede: 'Piloti brings Austrian building law with it; NotebookLM, which Google now calls Gemini Notebook, answers from the sources you add yourself. Both cite. The difference lies in who collects the sources and who keeps track of which version applies in the state.',
      note: 'NotebookLM (Gemini Notebook) details as stated by Google, read in September 2026.',
      answer:
        'For Austrian building law, Piloti is the better choice: the state building codes from RIS and the OIB guidelines are already there, Piloti names the edition in force in the state, and it places the answer in the project work. NotebookLM (Gemini Notebook) fits collections you put together yourself.',
      blocks: [
        {
          kind: 'text',
          title: 'What Piloti brings',
          body: [
            'With Piloti, the work starts with the question, not with collecting. The nine state building codes and related state law from RIS, the OIB guidelines, a register of standards and federal law such as the ASchG and the Workplace Ordinance are ready. Add your office archive, which no other office sees, and the project’s documents.',
            'The answer starts with the result as a copyable value, followed by reasoning, assumptions and citation down to section, clause or page, for example “Pkt. 3.5.2 · S. 7”. Checks by building class appear as a table with source and result per row.',
          ],
        },
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'NotebookLM (Gemini Notebook)',
          rows: [
            {
              label: 'Principle',
              a: 'Austrian building law is already there, plus your office archive and your project documents',
              b: 'Answers grounded in the sources you add to a notebook',
            },
            {
              label: 'Sources',
              a: 'State law from RIS, OIB guidelines, register of standards, federal law; uploads as PDF, Word, Excel, PowerPoint, CSV, image or whole folder',
              b: 'PDFs, websites, YouTube, audio, Google Docs and Slides; up to 500,000 words or 200 MB per source',
            },
            {
              label: 'State and edition',
              a: 'Draws on the state’s laws and names the OIB edition in force there',
              b: 'You decide which version you add; up to 50 sources per notebook on the free plan, 100 to 600 on higher plans',
            },
            {
              label: 'Evidence',
              a: 'Citation down to section, clause or page, checked against the source text before it is shown',
              b: 'Inline citations pointing to the passage in your source',
            },
            {
              label: 'Collaboration',
              a: 'Projects with versions, tasks, project memory and approval in the inbox',
              b: 'Notebooks can be shared',
            },
            {
              label: 'Training',
              a: 'No training on office data',
              b: 'According to Google, uploaded data is never used for training',
            },
          ],
          note: 'NotebookLM (Gemini Notebook) details as stated by Google, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where Piloti is ahead',
            items: [
              'The sources are already there: nine state building codes and related state law from RIS, the OIB guidelines, and for Vienna also the Building Technology Ordinance 2023, the Garage Act 2008 and the MA 37 guidance sheets.',
              'The edition follows the state. According to the OIB overview the 2023 edition does not apply everywhere; Piloti names the edition in force in the state when it changes the value.',
              'Questions back when facts are missing: if the building class or the state is missing, Piloti asks or states its assumption.',
              'Questions become work in the project: tasks, in-depth research with a report, a file note sent for approval.',
            ],
          },
          right: {
            title: 'What NotebookLM is good for',
            items: [
              'Collections whose sources you choose yourself: competition documents, lectures, the literature on a design topic.',
              'Many formats, including video and audio, such as the recording of a talk on an amendment.',
              'Ready to use, free or included in Google Workspace.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'What a building-law notebook takes to maintain',
          body: [
            'Using NotebookLM for building law means building your own rulebook: the OIB guidelines in the edition in force in the state, the building code and building-technology rules of every state the office plans in, and guidance sheets. In Vienna that is the Bauordnung für Wien and the Wiener Bautechnikverordnung 2023, in Salzburg the Bautechnikgesetz 2015 and the Baupolizeigesetz 1997, in Tyrol the Tiroler Bauordnung 2022. Nine states, nine collections.',
            'Then the maintenance starts. According to the OIB overview, the 2025 edition of OIB guideline 6 is so far in force only in Tyrol and Vienna, the 2027 edition is being prepared, and state laws are amended. Someone in the office has to notice each new version, add it and take the old one out of the notebook. Miss that, and the notebook cites cleanly from an outdated source. With Piloti you ask the question, and the project’s state law is already to hand.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Responsibility for the design stays with the planning office. Piloti names the source of every answer so that you can check it, and asks when a deciding fact such as the state is missing. What the zoning plan fixes for your plot, Piloti reads from the plan in the project; if it is missing, Piloti tells you where to look.',
          ],
        },
      ],
      faq: [
        {
          q: 'Is NotebookLM the same as Gemini Notebook?',
          a: 'Yes. Google now offers NotebookLM under the name Gemini Notebook. The principle: answers grounded in the sources you add to a notebook, with inline citations.',
        },
        {
          q: 'Can I upload the OIB guidelines to NotebookLM?',
          a: 'Yes, as a PDF like any other document. You then choose the edition in force in your project’s state yourself, and replace it when that changes. According to the OIB overview, the 2023 edition does not apply in every state; what counts is the state’s building-technology ordinance or law. Piloti names the edition in force in the state on its own.',
        },
        {
          q: 'How many sources fit in a notebook?',
          a: 'According to Google, up to 50 sources per notebook on the free plan and 100 to 600 on higher plans, each up to 500,000 words or 200 MB. For building law the limit is rarely the quantity, rather the upkeep: which version currently applies.',
        },
        {
          q: 'Does Google use my documents for training?',
          a: 'According to Google, uploaded data is never used for training. Piloti does not train models on office data either, and drawings remain the office’s property.',
        },
      ],
    },
  },
  {
    slug: 'perplexity',
    checked: '2026-09',
    related: ['vergleich/chatgpt', 'vergleich/ris-und-google', 'glossar/ris', 'baurecht/wien'],
    de: {
      title: 'Perplexity für Baurecht in Österreich? Piloti im Vergleich',
      description:
        'Perplexity oder Piloti für Baurecht? Piloti zieht Landesbauordnung aus dem RIS und OIB-Richtlinie je Bundesland heran, mit geprüfter Fundstelle.',
      heading: 'Perplexity oder Piloti?',
      lede: 'Piloti zieht für jede Planungsfrage das Landesrecht des Projekts aus dem RIS und die OIB-Richtlinien heran und recherchiert bei Bedarf auch im Web. Perplexity sucht im Web und nennt zu jeder Antwort die Quellen. Beim Baurecht entscheidet, welche Fassung im Bundesland gilt.',
      note: 'Angaben zu Perplexity laut Perplexity (perplexity.ai), gelesen im September 2026. Preise nennen wir nicht, weil sie je Tarif wechseln.',
      answer:
        'Für Baurecht in Österreich ist Piloti die bessere Wahl: Es zieht das Landesgesetz und die OIB-Ausgabe heran, die im Bundesland des Projekts gelten, prüft jede Fundstelle gegen den Quelltext und arbeitet im Projekt. Perplexity passt für aktuelle Recherche im offenen Web.',
      blocks: [
        {
          kind: 'text',
          title: 'Was Piloti beim Baurecht leistet',
          body: [
            'Piloti zieht die Gesetze des Bundeslands heran, in dem Ihr Projekt liegt, und die OIB-Richtlinien in der Ausgabe, die dort gilt. Dazu kommen Bundesgesetze wie ASchG, UVP-G und Gewerbeordnung, Ihr Büroarchiv und die Projektdokumente. Wo das Web weiterhilft, etwa bei Herstellerangaben, recherchiert Piloti auch dort und verlinkt jede Quelle.',
            'Jede Fundstelle wird gegen den Quelltext geprüft, bevor sie erscheint; RIS-Quellen öffnen sich an der markierten Stelle. Fehlt ein entscheidender Fakt wie die Gebäudeklasse, fragt Piloti einmal nach, statt zu raten.',
          ],
        },
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'Perplexity',
          rows: [
            {
              label: 'Prinzip',
              a: 'Österreichisches Baurecht als Grundlage, dazu Büroarchiv, Projektdokumente und Websuche',
              b: 'Antworten aus dem Web, mit Quellen zu jeder Antwort',
            },
            {
              label: 'Quellen',
              a: 'Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Bundesgesetze wie ASchG, UVP-G und Gewerbeordnung',
              b: 'Offenes Web; in Spaces zusätzlich eigene Dateien',
            },
            {
              label: 'Websuche',
              a: 'Ja, jede Quelle verlinkt, neben dem Baurecht',
              b: 'Kern des Produkts',
            },
            {
              label: 'Bundesland und Ausgabe',
              a: 'Zieht die Gesetze des Bundeslands heran und nennt die OIB-Ausgabe, die dort gilt',
              b: 'Hängt davon ab, welche Seiten die Suche findet und ob Sie beides in der Frage angeben',
            },
            {
              label: 'Belege',
              a: 'Fundstelle bis Paragraf, Punkt oder Seite, gegen den Quelltext geprüft; RIS-Quellen öffnen an der markierten Stelle',
              b: 'Links zu den Webseiten, aus denen die Antwort stammt',
            },
            {
              label: 'Projektarbeit',
              a: 'Projekte mit Plänen, Fassungen, Aufgaben, Projektgedächtnis und Freigabe',
              b: 'Spaces verbinden Websuche und eigene Dateien zu einem Thema',
            },
            {
              label: 'Training',
              a: 'Kein Training mit Büro-Daten',
              b: 'Laut Perplexity: Enterprise-Daten kein Training; in Free und Pro ist die Nutzung zur Verbesserung der Modelle standardmäßig an und abschaltbar',
            },
          ],
          note: 'Angaben zu Perplexity laut Perplexity, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Landesrecht aus dem RIS statt der Seite, die in der Suche oben steht. Piloti zieht die Gesetze des Bundeslands heran, in dem das Projekt liegt.',
              'OIB-Richtlinien mit Punkt und Seite, in der Ausgabe, die dort gilt.',
              'Fundstellen werden gegen den Quelltext geprüft, bevor sie erscheinen.',
              'Websuche inklusive: Jede Quelle ist verlinkt, und die Antwort zeigt, ob eine Aussage aus dem Baurecht, dem Büro, dem Projekt oder dem Web stammt.',
              'Das Projekt: Pläne, Aufgaben, Aktenvermerke zur Freigabe und ein Gedächtnis für das schon Geklärte.',
            ],
          },
          right: {
            title: 'Wofür Perplexity gut passt',
            items: [
              'Aktuelles aus dem Web: Förderungen, Herstellerangaben, Marktberichte, eine Novelle, über die gerade berichtet wird.',
              'Breite Recherche und Nachrichten weit über das Baurecht hinaus, mit Quellen bei jeder Antwort.',
              'Sofort nutzbar, auch im kostenlosen Tarif.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Warum das Web beim Baurecht wenig verlässlich ist',
          body: [
            'Baurechtliche Antworten stehen im Web oft in PDFs unterschiedlichen Alters: ein Merkblatt einer Landesregierung, das vor einer Novelle geschrieben wurde, ein Vortrag bei der Kammer, eine Herstellerseite, die OIB-Richtlinie in der Ausgabe 2019 neben der von 2023. Eine Suche ordnet nach Relevanz, nicht danach, welche Fassung heute im Bundesland verbindlich ist.',
            'Dazu kommen neun Bauordnungen. Eine Seite über das Wiener Baurecht beantwortet keine Frage zu einem Projekt in Vorarlberg, auch wenn sie in der Suche oben steht. Perplexity nennt die Quelle; ob sie für Ihr Bundesland und Ihre Ausgabe gilt, prüfen Sie selbst. Piloti geht vom Bundesland des Projekts aus und nennt die Ausgabe, die dort gilt.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Die Verantwortung für den Entwurf bleibt beim Planungsbüro. Piloti nennt zu jeder Antwort die Quellen, damit Sie sie prüfen können, und fragt nach, wenn ein entscheidender Fakt fehlt. Einen Heizwärmebedarf berechnet Piloti nicht; es sagt, welche Anforderung gilt und wie ein Wert dazu steht.',
          ],
        },
      ],
      faq: [
        {
          q: 'Kann Perplexity Fragen zum österreichischen Baurecht beantworten?',
          a: 'Es findet dazu Seiten im Web und nennt sie als Quellen. Ob die gefundene Fassung für Ihr Bundesland und die dort geltende OIB-Ausgabe stimmt, entscheidet die Suche nicht. Piloti geht vom Landesrecht des Projekts aus dem RIS aus und prüft jede Fundstelle gegen den Quelltext.',
        },
        {
          q: 'Welche Quellen nutzt Perplexity?',
          a: 'Das offene Web, mit Links zu den Seiten, aus denen die Antwort stammt. In Spaces lassen sich laut Perplexity Websuche und eigene Dateien verbinden. Einen eigenen Bestand an Landesbauordnungen und OIB-Richtlinien nennt Perplexity nicht.',
        },
        {
          q: 'Verwendet Perplexity meine Fragen zum Training?',
          a: 'Laut Perplexity werden Enterprise-Daten nicht zum Training verwendet. In Free und Pro ist die Speicherung von Daten zur Verbesserung der Modelle standardmäßig an und lässt sich abschalten. Piloti trainiert keine Modelle mit Büro-Daten.',
        },
        {
          q: 'Recherchiert Piloti auch im Web?',
          a: 'Ja. Neben den Landesgesetzen aus dem RIS, den OIB-Richtlinien und Ihren Dokumenten sucht Piloti im Web und verlinkt jede Quelle. In der Antwort sehen Sie, ob eine Aussage aus dem Baurecht, aus Ihrem Büro, aus dem Projekt oder aus dem Web stammt.',
        },
      ],
    },
    en: {
      title: 'Perplexity for Austrian building law? Piloti compared',
      description:
        'Perplexity or Piloti for building law? Piloti draws on the state building code from RIS and the OIB guideline for each state, with a checked citation.',
      heading: 'Perplexity or Piloti?',
      lede: 'For every planning question, Piloti draws on the project’s state law from RIS and the OIB guidelines, and researches the web as well where that helps. Perplexity searches the web and names the sources for every answer. For building law, what decides is which version applies in the state.',
      note: 'Perplexity details as stated by Perplexity (perplexity.ai), read in September 2026. We do not list prices, because they vary by plan.',
      answer:
        'For Austrian building law, Piloti is the better choice: it draws on the state law and the OIB edition in force in the project’s state, checks every citation against the source text and works inside the project. Perplexity fits current research on the open web.',
      blocks: [
        {
          kind: 'text',
          title: 'What Piloti does for building law',
          body: [
            'Piloti draws on the laws of the state your project is in and on the OIB guidelines in the edition in force there. Add federal law such as the ASchG, the UVP-G and the Trade Act, your office archive and the project documents. Where the web helps, for manufacturer data for example, Piloti researches there too and links every source.',
            'Every citation is checked against the source text before it appears; RIS sources open at the marked passage. If a deciding fact such as the building class is missing, Piloti asks once instead of guessing.',
          ],
        },
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'Perplexity',
          rows: [
            {
              label: 'Principle',
              a: 'Austrian building law as the foundation, plus office archive, project documents and web search',
              b: 'Answers from the web, with sources for every answer',
            },
            {
              label: 'Sources',
              a: 'State law from RIS, OIB guidelines, register of standards, federal law such as ASchG, UVP-G and the Trade Act',
              b: 'Open web; in Spaces also your own files',
            },
            {
              label: 'Web search',
              a: 'Yes, every source linked, alongside building law',
              b: 'The core of the product',
            },
            {
              label: 'State and edition',
              a: 'Draws on the state’s laws and names the OIB edition in force there',
              b: 'Depends on which pages the search finds and whether your question states both',
            },
            {
              label: 'Evidence',
              a: 'Citation down to section, clause or page, checked against the source text; RIS sources open at the marked passage',
              b: 'Links to the web pages the answer comes from',
            },
            {
              label: 'Project work',
              a: 'Projects with drawings, versions, tasks, project memory and approval',
              b: 'Spaces combine web search and your own files around a topic',
            },
            {
              label: 'Training',
              a: 'No training on office data',
              b: 'According to Perplexity: Enterprise data not used for training; on Free and Pro, use for model improvement is on by default and can be switched off',
            },
          ],
          note: 'Perplexity details as stated by Perplexity, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where Piloti is ahead',
            items: [
              'State law from RIS instead of whichever page ranks first. Piloti draws on the laws of the state the project is in.',
              'OIB guidelines with clause and page, in the edition in force there.',
              'Citations are checked against the source text before they appear.',
              'Web search included: every source is linked, and the answer shows whether a statement comes from building law, the office, the project or the web.',
              'The project: drawings, tasks, file notes sent for approval, and a memory of what is already settled.',
            ],
          },
          right: {
            title: 'What Perplexity is good for',
            items: [
              'What is current on the web: subsidies, manufacturer data, market reports, an amendment that is in the news.',
              'Broad research and news far beyond building law, with sources for every answer.',
              'Ready to use, including on the free plan.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Why the web is unreliable for building law',
          body: [
            'Building-law answers on the web often sit in PDFs of varying age: a state government guidance sheet written before an amendment, a talk at the chamber, a manufacturer’s page, the 2019 edition of an OIB guideline next to the 2023 one. A search ranks by relevance, not by which version is binding in the state today.',
            'Then there are nine building codes. A page on Vienna’s building law answers no question about a project in Vorarlberg, even if it ranks first. Perplexity names the source; whether it applies to your state and your edition is yours to check. Piloti starts from the project’s state and names the edition in force there.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Responsibility for the design stays with the planning office. Piloti names the source of every answer so that you can check it, and asks when a deciding fact is missing. Piloti does not calculate a heating demand; it says which requirement applies and how a value stands against it.',
          ],
        },
      ],
      faq: [
        {
          q: 'Can Perplexity answer questions on Austrian building law?',
          a: 'It finds web pages on the topic and names them as sources. Whether the version it found is right for your state and the OIB edition in force there, the search does not decide. Piloti starts from the project’s state law from RIS and checks every citation against the source text.',
        },
        {
          q: 'What sources does Perplexity use?',
          a: 'The open web, with links to the pages the answer comes from. According to Perplexity, Spaces combine web search with your own files. Perplexity does not name a body of state building codes and OIB guidelines of its own.',
        },
        {
          q: 'Does Perplexity use my questions for training?',
          a: 'According to Perplexity, Enterprise data is not used for training. On Free and Pro, data retention for model improvement is on by default and can be switched off. Piloti does not train models on office data.',
        },
        {
          q: 'Does Piloti also research the web?',
          a: 'Yes. Alongside state law from RIS, the OIB guidelines and your documents, Piloti searches the web and links every source. In the answer you see whether a statement comes from building law, from your office, from the project or from the web.',
        },
      ],
    },
  },
  {
    slug: 'ris-und-google',
    checked: '2026-09',
    related: ['glossar/ris', 'glossar/oib-richtlinien', 'baurecht/wien', 'vergleich/perplexity', 'anwendungen/einreichcheck'],
    de: {
      title: 'Baurecht selbst recherchieren: RIS, OIB, Google oder Piloti',
      description:
        'Baurecht selbst recherchieren im RIS, auf der OIB-Website und mit Google, oder mit Piloti? Was Piloti übernimmt und wie es ins RIS zurückführt.',
      heading: 'Baurecht selbst recherchieren oder mit Piloti?',
      lede: 'Piloti nimmt Ihnen das Zusammensuchen ab und führt Sie für jede Fundstelle an die amtliche Quelle zurück. Das RIS ist die amtliche Quelle für Landesrecht, die OIB-Website die für die Richtlinien, beide frei zugänglich. Hier, was Piloti daraus für ein Projekt macht.',
      note: 'RIS: Rechtsinformationssystem des Bundes (ris.bka.gv.at). OIB: Österreichisches Institut für Bautechnik (oib.or.at). Angaben zu den OIB-Ausgaben laut OIB-Übersicht zum Inkrafttreten.',
      answer:
        'Piloti übernimmt die Arbeit rund um das RIS: Es sucht die Bestimmungen aus dem Landesrecht des Projekts und aus den OIB-Richtlinien in der dort geltenden Ausgabe zusammen, verbindet sie mit den Plänen und hält das Ergebnis als Aktenvermerk fest. Jede Fundstelle führt zurück ins RIS, die amtliche und freie Quelle für den Originaltext.',
      blocks: [
        {
          kind: 'text',
          title: 'Was Piloti übernimmt',
          body: [
            'Piloti holt die einschlägigen Bestimmungen aus dem Landesrecht des Projekts und aus den OIB-Richtlinien zusammen, legt sie neben Grundriss, Schnitt und das schon Geklärte und schreibt das Ergebnis mit Begründung, Annahmen und Fundstelle auf. Fehlt ein entscheidender Fakt wie die Gebäudeklasse, fragt es einmal nach oder nennt die Annahme.',
            'Landesrecht zitiert Piloti so, wie ein Bescheid es nennt, und öffnet die RIS-Quelle in Piloti an der markierten Stelle. OIB-Fundstellen tragen Punkt und Seite, etwa „Pkt. 3.5.2 · S. 7“. Der Weg zum Originaltext ist damit ein Klick.',
          ],
        },
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'Eigene Recherche (RIS, OIB, Google)',
          rows: [
            {
              label: 'Quellen',
              a: 'Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Büroarchiv, Projektdokumente, Web',
              b: 'RIS für Landes- und Bundesrecht, OIB-Website für die Richtlinien, Google für alles andere',
            },
            {
              label: 'Verbindlichkeit',
              a: 'Zitiert ins RIS und in die OIB-Richtlinie und öffnet die Stelle; maßgeblich bleibt der Originaltext',
              b: 'Direkt an der amtlichen Quelle',
            },
            {
              label: 'Bundesland und Ausgabe',
              a: 'Zieht die Gesetze des Bundeslands heran und nennt die OIB-Ausgabe, die dort gilt',
              b: 'Sie suchen die Landesvorschrift und prüfen in der OIB-Übersicht und im Landesrecht, welche Ausgabe gilt',
            },
            {
              label: 'Pläne',
              a: 'Sieht Grundriss und Schnitt als Bild an und markiert die gelesene Zeichnung',
              b: 'Sie legen Plan und Vorschrift selbst nebeneinander',
            },
            {
              label: 'Dokumentation',
              a: 'Antwort mit Begründung, Annahmen und Fundstelle, als Word; Aktenvermerk zur Freigabe',
              b: 'Sie schreiben den Aktenvermerk selbst',
            },
            {
              label: 'Projektgedächtnis',
              a: 'Befunde werden Fakten und offene Punkte im Projekt; Folgefragen bauen darauf auf',
              b: 'Sie halten selbst fest, was geklärt ist',
            },
          ],
        },
        {
          kind: 'split',
          left: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Das Zusammensuchen: Piloti holt die einschlägigen Bestimmungen aus dem Landesrecht des Projekts und aus den OIB-Richtlinien zusammen.',
              'Die Ausgabe: Piloti nennt die OIB-Ausgabe, die im Bundesland gilt, wenn sie den Wert verändert.',
              'Die Verbindung zum Projekt: Pläne, Bescheide und frühere Klärungen liegen im selben Projekt wie die Antwort.',
              'Die Dokumentation: Begründung, Annahmen und Fundstelle stehen in der Antwort, als Word herunterladbar oder als Aktenvermerk zur Freigabe.',
            ],
          },
          right: {
            title: 'Wofür die eigene Recherche gut passt',
            items: [
              'Der Originaltext ohne Zwischenschicht: Im RIS lesen Sie die Bestimmung im amtlichen Wortlaut.',
              'Kostenlos und ohne Anmeldung, im RIS wie auf der OIB-Website.',
              'Der Blick auf das Umfeld: was neben der gesuchten Bestimmung steht.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Was an der eigenen Recherche Arbeit macht',
          body: [
            'Das RIS beantwortet die Frage, was ein Gesetz sagt, sehr gut. Die Arbeit liegt davor und danach. Davor: herausfinden, welche Vorschrift überhaupt gilt. Eine Frage zum Brandschutz führt in Wien über die Bauordnung für Wien und die Wiener Bautechnikverordnung 2023 zur OIB-Richtlinie 2 in der Ausgabe 2023. In Salzburg führt sie über das Bautechnikgesetz 2015 laut OIB-Übersicht zur Ausgabe 2019, weil Salzburg die Ausgabe 2023 bisher nicht für verbindlich erklärt hat.',
            'Danach: die Bestimmung mit dem Grundriss, der Gebäudeklasse und dem schon Geklärten verbinden und das Ergebnis so festhalten, dass eine Kollegin es in einem Jahr nachvollziehen kann. Genau diese Schritte übernimmt Piloti, und das RIS bleibt die Stelle, an der Sie den Wortlaut lesen.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Auslegung und Abwägung im Einzelfall bleiben beim Planungsbüro. Piloti nennt zu jeder Antwort die Fundstellen und öffnet das RIS an der markierten Stelle, damit Sie den Originaltext mit einem Klick lesen. Was der Bebauungsplan für Ihr Grundstück festlegt, liest Piloti aus dem Plan im Projekt; fehlt er, sagt es, wo Sie nachsehen.',
          ],
        },
      ],
      faq: [
        {
          q: 'Wo finde ich die Bauordnung meines Bundeslands?',
          a: 'Im RIS, dem Rechtsinformationssystem des Bundes, unter dem Landesrecht des jeweiligen Bundeslands. Die Namen unterscheiden sich: In Wien ist es die Bauordnung für Wien, in der Steiermark das Steiermärkische Baugesetz, in Vorarlberg das Baugesetz, in Kärnten die Kärntner Bauordnung 1996. Die technischen Anforderungen stehen oft in einer eigenen Bautechnikvorschrift; Piloti zieht beides für das Bundesland des Projekts heran.',
        },
        {
          q: 'Welche OIB-Richtlinien gelten in meinem Bundesland?',
          a: 'Das OIB veröffentlicht auf seiner Website eine Übersicht, welche Ausgabe in welchem Bundesland in Kraft ist. Laut dieser Übersicht gilt die Ausgabe 2023 in Wien, Kärnten und Niederösterreich für alle sechs Richtlinien, in Oberösterreich und Tirol für die Richtlinien 1 bis 5; in den übrigen Ländern gilt im Allgemeinen noch die Ausgabe 2019. Maßgeblich ist das Landesrecht, das Ausnahmen und Übergänge festlegen kann.',
        },
        {
          q: 'Ist Google für Baurecht verlässlich?',
          a: 'Google findet schnell Merkblätter, Fachartikel und Gesetzestexte, sortiert aber nach Relevanz, nicht nach Geltung. Ein Treffer kann eine alte Fassung, eine andere OIB-Ausgabe oder ein anderes Bundesland betreffen. Die geltende Fassung steht im RIS und auf der OIB-Website, und dorthin verweist Piloti mit jeder Fundstelle.',
        },
        {
          q: 'Brauche ich das RIS noch, wenn ich Piloti nutze?',
          a: 'Ja, und Piloti bringt Sie schneller hin: Es zitiert ins RIS und öffnet die Quelle an der markierten Stelle. Für eine Antwort, die in eine Einreichung oder einen Aktenvermerk geht, lesen Sie dort den Originaltext, ohne die Stelle erst suchen zu müssen.',
        },
      ],
    },
    en: {
      title: 'Research building law yourself: RIS, OIB, Google or Piloti',
      description:
        'Research Austrian building law yourself in RIS, on the OIB website and Google, or with Piloti? What Piloti takes on and how it leads back into RIS.',
      heading: 'Research building law yourself, or with Piloti?',
      lede: 'Piloti does the gathering for you and leads you back to the official source for every citation. RIS is the official source for state law, the OIB website the one for the guidelines, both freely accessible. Here is what Piloti makes of them for a project.',
      note: 'RIS: the Austrian federal legal information system (ris.bka.gv.at). OIB: Austrian Institute of Construction Engineering (oib.or.at). OIB editions as stated in the OIB overview of entry into force.',
      answer:
        'Piloti takes on the work around RIS: it gathers the provisions from the project’s state law and from the OIB guidelines in the edition in force there, connects them to the drawings and records the result as a file note. Every citation leads back into RIS, the official and free source for the original text.',
      blocks: [
        {
          kind: 'text',
          title: 'What Piloti takes on',
          body: [
            'Piloti pulls together the relevant provisions from the project’s state law and the OIB guidelines, sets them next to plan, section and what is already settled, and writes the result down with reasoning, assumptions and citation. If a deciding fact such as the building class is missing, it asks once or states its assumption.',
            'Piloti cites state law the way an official decision does and opens the RIS source inside Piloti at the marked passage. OIB citations carry clause and page, for example “Pkt. 3.5.2 · S. 7”. The way to the original text is one click.',
          ],
        },
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'Own research (RIS, OIB, Google)',
          rows: [
            {
              label: 'Sources',
              a: 'State law from RIS, OIB guidelines, register of standards, office archive, project documents, web',
              b: 'RIS for state and federal law, the OIB website for the guidelines, Google for everything else',
            },
            {
              label: 'Authority',
              a: 'Cites into RIS and the OIB guideline and opens the passage; the original text remains decisive',
              b: 'Directly at the official source',
            },
            {
              label: 'State and edition',
              a: 'Draws on the state’s laws and names the OIB edition in force there',
              b: 'You find the state rule and check in the OIB overview and the state law which edition applies',
            },
            {
              label: 'Drawings',
              a: 'Looks at plan and section as an image and marks the drawing it read',
              b: 'You put drawing and rule side by side yourself',
            },
            {
              label: 'Documentation',
              a: 'Answer with reasoning, assumptions and citation, as Word; file note sent for approval',
              b: 'You write the file note yourself',
            },
            {
              label: 'Project memory',
              a: 'Findings become facts and open points in the project; follow-up questions build on them',
              b: 'You record yourself what is settled',
            },
          ],
        },
        {
          kind: 'split',
          left: {
            title: 'Where Piloti is ahead',
            items: [
              'The gathering: Piloti pulls the relevant provisions together from the project’s state law and the OIB guidelines.',
              'The edition: Piloti names the OIB edition in force in the state when it changes the value.',
              'The link to the project: drawings, permits and earlier clarifications sit in the same project as the answer.',
              'The documentation: reasoning, assumptions and citation are in the answer, downloadable as Word or sent as a file note for approval.',
            ],
          },
          right: {
            title: 'What your own research is good for',
            items: [
              'The original text with no layer in between: in RIS you read the provision in its official wording.',
              'Free and without sign-in, in RIS as on the OIB website.',
              'The view of the surroundings: what stands next to the provision you were looking for.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'What makes your own research work',
          body: [
            'RIS answers the question of what a law says very well. The work lies before and after. Before: finding out which rule applies at all. A fire-safety question in Vienna leads through the Bauordnung für Wien and the Wiener Bautechnikverordnung 2023 to OIB guideline 2 in the 2023 edition. In Salzburg it leads through the Bautechnikgesetz 2015 to the 2019 edition, according to the OIB overview, because Salzburg has not yet declared the 2023 edition binding.',
            'After: connecting the provision to the floor plan, the building class and what is already settled, and recording the result so that a colleague can follow it a year later. These are the steps Piloti takes on, and RIS stays the place where you read the wording.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Interpretation and judgement in the individual case stay with the planning office. Piloti gives the citation for every answer and opens RIS at the marked passage, so that you read the original text in one click. What the zoning plan fixes for your plot, Piloti reads from the plan in the project; if it is missing, Piloti tells you where to look.',
          ],
        },
      ],
      faq: [
        {
          q: 'Where do I find my state’s building code?',
          a: 'In RIS, the federal legal information system, under the state law of the state concerned. The names differ: in Vienna it is the Bauordnung für Wien, in Styria the Steiermärkisches Baugesetz, in Vorarlberg the Baugesetz, in Carinthia the Kärntner Bauordnung 1996. The technical requirements are often in a separate building-technology rule; Piloti draws on both for the project’s state.',
        },
        {
          q: 'Which OIB guidelines apply in my state?',
          a: 'The OIB publishes an overview on its website of which edition is in force in which state. According to that overview, the 2023 edition applies in Vienna, Carinthia and Lower Austria for all six guidelines, in Upper Austria and Tyrol for guidelines 1 to 5; in the other states the 2019 edition generally still applies. The state law is decisive and can set exceptions and transitions.',
        },
        {
          q: 'Is Google reliable for building law?',
          a: 'Google quickly finds guidance sheets, articles and legal texts, but ranks by relevance, not by validity. A hit can concern an old version, another OIB edition or another state. The version in force is in RIS and on the OIB website, and that is where every Piloti citation points.',
        },
        {
          q: 'Do I still need RIS if I use Piloti?',
          a: 'Yes, and Piloti gets you there faster: it cites into RIS and opens the source at the marked passage. For an answer that goes into a submission or a file note, you read the original text there without having to find the passage first.',
        },
      ],
    },
  },
]
