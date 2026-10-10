/**
 * Who Piloti is built for: one page per kind of office. Each says what the
 * office's week looks like, what Piloti takes on and what not. The weeks are
 * invented examples and say so; nothing here is a customer report.
 */
import type { LandingEntry } from '../../lib/landing'

export const fuer: LandingEntry[] = [
  {
    slug: 'architekturbueros',
    checked: '2026-09',
    related: ['anwendungen/einreichcheck', 'anwendungen/bestand', 'anwendungen/bueroarchiv', 'vergleich/chatgpt', 'glossar/gebaeudeklasse'],
    de: {
      title: 'KI für Architekturbüros in Österreich – Piloti',
      description:
        'KI für Architekturbüros in Österreich: Piloti ist der Arbeitsbereich für Projekte, Unterlagen und Baurecht, mit geprüfter Fundstelle zu jeder Antwort.',
      heading: 'KI für Architekturbüros: was Piloti im Büro übernimmt',
      lede: 'Zwischen Entwurf und Einreichung liegt eine lange Reihe kleiner Rechtsfragen. Piloti ist für genau diese Strecke gebaut: für die Frage, die Fundstelle und das, was danach im Akt stehen muss.',
      answer:
        'Piloti ist ein KI-Werkzeug für Architekturbüros in Österreich, das Planungsfragen aus Landesbauordnungen, OIB-Richtlinien, Büroarchiv und Projektunterlagen beantwortet, mit gegen den Quelltext geprüfter Fundstelle, und daraus Arbeit im Projekt macht: Aktenvermerke, Einreichchecks, offene Punkte.',
      blocks: [
        {
          kind: 'list',
          title: 'Was Piloti übernimmt',
          items: [
            'Antworten mit Fundstelle, zitiert wie ein Bescheid, etwa „Bauordnung für Wien, § …“ oder „Pkt. 3.5.2 · S. 7“, gegen den Quelltext geprüft, bevor sie erscheinen. Die Quelle öffnet sich an der markierten Stelle.',
            'Eigene Arbeitsweisen für Gebäudeklasse, Brandschutz, Einreichcheck, Bestand, Bebauung, Wärmeschutz, Barrierefreiheit und Aufenthaltsräume, jede mit ihrem eigenen Ablauf.',
            'Grundrisse, Schnitte und Fotos sieht Piloti als Bild an, wenn die Zeichnung zählt, und sagt, welche Zeichnung auf dem Blatt es gelesen hat.',
            'Das Büroarchiv: frühere Projekte, Aktenvermerke, eigene Checklisten, für kein anderes Büro sichtbar.',
            'Entwürfe für Aktenvermerk, Protokoll, Checkliste und Flächenaufstellung, im Gespräch überarbeitet, mit Fassungen und Freigabe im Eingang.',
          ],
        },
        {
          kind: 'text',
          title: 'Der Alltag in einem österreichischen Architekturbüro',
          body: [
            'Ein Dachausbau in Wien, ein Wohnbau in Niederösterreich, ein Wettbewerb in der Steiermark: Viele Büros planen in mehreren Bundesländern gleichzeitig, und jedes hat seine eigene Bauordnung und seinen eigenen Stand bei den OIB-Richtlinien. Die Fragen sind oft klein, aber sie kommen ständig: Welche Gebäudeklasse? Reicht der Fluchtweg? Ist das noch ein Aufenthaltsraum?',
            'Die Antworten liegen verstreut. Im RIS, in den Richtlinien, in einem Aktenvermerk von 2019, im Kopf der Kollegin, die das schon dreimal durchgemacht hat. Wer fragt, unterbricht jemanden; wer nicht fragt, riskiert einen Verbesserungsauftrag.',
          ],
        },
        {
          kind: 'steps',
          title: 'Eine Woche mit Piloti',
          body: 'Ein erfundenes Beispiel, kein Kundenbericht. So kann die Arbeit in einem Büro mit Projekten in zwei Bundesländern aussehen.',
          items: [
            {
              name: 'Montag',
              body: 'Dachausbau im Wiener Bestand. Piloti stuft zuerst das Vorhaben ein, dann die Gebäudeklasse, und fragt nach dem einen Wert, der fehlt: ob der Dachraum bisher ausgebaut war.',
            },
            {
              name: 'Dienstag',
              body: 'Zwei Varianten für das Stiegenhaus eines Wohnbaus in Niederösterreich. Piloti stellt sie in Tabs nebeneinander, mit der Fundstelle für jede Anforderung und einem Ergebnis je Zeile.',
            },
            {
              name: 'Mittwoch',
              body: 'Nach dem Termin bei der Baubehörde schreibt die Projektleitung ihre Stichworte ins Gespräch. Piloti entwirft den Aktenvermerk, das Team korrigiert ihn im Gespräch, die Büroleitung gibt ihn frei.',
            },
            {
              name: 'Donnerstag',
              body: '„Mach den Einreichcheck bis Freitag.“ Die Aufgabe läuft unter dem Namen und mit den Berechtigungen der Planerin, die sie gestellt hat.',
            },
            {
              name: 'Freitag',
              body: 'Zwei Unterlagen fehlen. Sie stehen als offene Punkte im Projekt; einen davon, eine Frage an die Gemeinde, macht „Klären“ zur eigenen Aufgabe.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Ihre Daten',
          body: [
            'Mit den Daten Ihres Büros werden keine Modelle trainiert, Ihre Dateien bleiben Ihr Eigentum, und Ihr Büroarchiv ist für kein anderes Büro sichtbar. Die Einzelheiten stehen in der Datenschutzerklärung.',
          ],
        },
        {
          kind: 'text',
          title: 'Pilotphase',
          body: [
            'Piloti ist in der Pilotphase mit ausgewählten Büros. Wenn Sie sehen wollen, was es in Ihrem Büro übernimmt, schicken Sie uns über „Mit einer echten Frage testen“ eine Frage aus einem laufenden Projekt.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Entwurf, Zeichnung und Verantwortung bleiben bei Ihnen; Piloti liefert die Fundstellen, damit Ihr Büro jede Aussage nachprüfen kann. Der Einreichcheck stellt die Vollständigkeit des Pakets fest, und einen Heizwärmebedarf berechnet Piloti nicht, es sagt, welche Anforderung gilt und wie ein Wert dazu steht. Fehlt eine entscheidende Angabe, etwa der Bebauungsplan, fragt Piloti danach.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche Rechtsquellen nutzt Piloti für Architekturbüros?',
          a: 'Die neun Landesbauordnungen und zugehöriges Landesrecht aus dem RIS, die OIB-Richtlinien, ein Normenverzeichnis und Bundesrecht wie ASchG, Arbeitsstättenverordnung oder Denkmalschutzgesetz. Dazu kommen Ihr Büroarchiv, die Unterlagen des Projekts und eine Webrecherche, bei der jede Quelle verlinkt ist.',
        },
        {
          q: 'Wie schnell antwortet Piloti?',
          a: 'Eine typische Antwort braucht etwa 30 s. Eine Tiefenrecherche dauert länger: Sie beginnt mit einem Rechercheplan, den Sie bearbeiten, und endet mit einem Bericht im Projekt.',
        },
        {
          q: 'Werden unsere Dateien zum Training verwendet?',
          a: 'Nein. Mit Daten aus Ihrem Büro werden keine Modelle trainiert, Zeichnungen bleiben Eigentum des Büros, und Ihr Büroarchiv sieht kein anderes Büro. Die Einzelheiten stehen in der Datenschutzerklärung.',
        },
        {
          q: 'Was kostet Piloti für ein Architekturbüro?',
          a: 'Piloti arbeitet derzeit mit ausgewählten Pilotbüros. Pilotbüros vereinbaren die Bedingungen direkt mit uns Gründern; der erste Schritt ist eine echte Frage aus einem laufenden Projekt.',
        },
        {
          q: 'Kann Piloti unsere Bürostandards berücksichtigen?',
          a: 'Ja, über eigene Arbeitsweisen im Skill-Editor und über ständige Anweisungen. Die Anweisungen regeln Form und Schwerpunkt der Antworten, nie einen normativen Wert.',
        },
      ],
    },
    en: {
      title: 'AI for architecture offices in Austria – Piloti',
      description:
        'AI for architecture offices in Austria: Piloti answers building law questions from state codes, OIB guidelines and your drawings, with checked citations.',
      heading: 'AI for architecture offices: what Piloti takes on',
      lede: 'Between design and submission lies a long string of small legal questions. Piloti is built for exactly that stretch: the question, the citation, and what then has to go into the file.',
      answer:
        'Piloti is an AI tool for architecture offices in Austria that answers planning questions from state building codes, OIB guidelines, the office archive and project documents, with citations checked against the source text, and turns them into work in the project: file notes, submission checks, open points.',
      blocks: [
        {
          kind: 'list',
          title: 'What Piloti takes on',
          items: [
            'Answers with citations, the way a permit names them, for example “Bauordnung für Wien, § …” or “Pkt. 3.5.2 · S. 7”, checked against the source text before they appear. The source opens at the marked passage.',
            'Its own ways of working for building class, fire safety, submission check, existing buildings, plot rules, thermal protection, accessibility and habitable rooms, each with its own sequence.',
            'Piloti looks at floor plans, sections and photos as images when the drawing matters, and says which drawing on the sheet it read.',
            'The office archive: past projects, file notes, your own checklists, visible to no other office.',
            'Drafts of file notes, minutes, checklists and area schedules, revised in the conversation, with versions and approval in the inbox.',
          ],
        },
        {
          kind: 'text',
          title: 'Daily life in an Austrian architecture office',
          body: [
            'A roof conversion in Vienna, a housing block in Lower Austria, a competition in Styria: many offices work in several states at once, and each has its own building code and its own status on the OIB guidelines. The questions are often small, but they never stop: which building class? Is the escape route enough? Is that still a habitable room?',
            'The answers are scattered. In the RIS, in the guidelines, in a file note from 2019, in the head of the colleague who has been through it three times. Asking interrupts someone; not asking risks a request for rectification.',
          ],
        },
        {
          kind: 'steps',
          title: 'A week with Piloti',
          body: 'An invented example, not a customer report. This is what work can look like in an office with projects in two states.',
          items: [
            {
              name: 'Monday',
              body: 'Roof conversion in an existing Vienna building. Piloti first classifies the project, then the building class, and asks for the one value that is missing: whether the roof space was converted before.',
            },
            {
              name: 'Tuesday',
              body: 'Two options for the staircase of a housing block in Lower Austria. Piloti sets them side by side in tabs, with the citation for each requirement and a result per row.',
            },
            {
              name: 'Wednesday',
              body: 'After the meeting at the building authority, the project lead types her notes into the conversation. Piloti drafts the file note, the team corrects it in the conversation, the office lead approves it.',
            },
            {
              name: 'Thursday',
              body: '“Do the submission check by Friday.” The task runs under the name and with the permissions of the planner who set it.',
            },
            {
              name: 'Friday',
              body: 'Two documents are missing. They sit as open points in the project; “Klären” turns one of them, a question for the municipality, into its own task.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Your data',
          body: [
            'No models are trained on your office’s data, your drawings remain your property, and your office archive is visible to no other office. The details are in the privacy policy.',
          ],
        },
        {
          kind: 'text',
          title: 'Pilot phase',
          body: [
            'Piloti is in its pilot phase with selected offices. If you want to see what it takes on in your office, send us a question from a live project via “Try it with a real question”.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Design, drawing and responsibility stay with you; Piloti supplies the citations so your office can check every answer. The submission check establishes that the package is complete, and Piloti does not calculate a heating demand: it says which requirement applies and how a value compares. If a deciding fact is missing, such as the development plan, Piloti asks for it.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which legal sources does Piloti use for architecture offices?',
          a: 'The nine state building codes and related state law from the RIS, the OIB guidelines, a register of standards and federal law such as the ASchG, the workplace regulation or the monument protection act. Add your office archive, the project documents and web research with every source linked.',
        },
        {
          q: 'How fast does Piloti answer?',
          a: 'A typical answer takes about 30 s. In-depth research takes longer: it starts with a research plan you edit and ends with a report in the project.',
        },
        {
          q: 'Are our drawings used for training?',
          a: 'No. No models are trained on data from your office, drawings remain the office’s property, and no other office sees your archive. The details are in the privacy policy.',
        },
        {
          q: 'What does Piloti cost for an architecture office?',
          a: 'Piloti currently works with selected pilot offices. Pilot offices agree terms directly with us founders; the first step is a real question from a live project.',
        },
        {
          q: 'Can Piloti follow our office standards?',
          a: 'Yes, through your own ways of working in the skill editor and through standing instructions. The instructions govern the form and focus of answers, never a normative value.',
        },
      ],
    },
  },
  {
    slug: 'ziviltechniker-ingenieurbueros',
    checked: '2026-09',
    related: ['anwendungen/brandschutz', 'anwendungen/waermeschutz', 'anwendungen/pruefbericht-aktenvermerk', 'fuer/architekturbueros', 'glossar/brandabschnitt'],
    de: {
      title: 'KI für Ziviltechniker und Ingenieurbüros – Piloti',
      description:
        'KI für Ziviltechniker und Ingenieurbüros im Bauwesen: Piloti recherchiert Anforderungen aus Landesrecht und OIB-Richtlinien, mit belegten Berichten.',
      heading: 'KI für Ziviltechniker:innen und Ingenieurbüros',
      lede: 'Wer eine Stellungnahme unterschreibt, braucht mehr als eine plausible Antwort: die Fundstelle, die Annahme und die Grenze der Aussage. Piloti ist darauf gebaut, alle drei offen zu legen.',
      answer:
        'Für Ziviltechniker:innen und Ingenieurbüros im Bauwesen recherchiert Piloti die Anforderungen aus Landesrecht, OIB-Richtlinien und Bundesrecht, trennt dabei Anforderung und Nachweis und legt Ergebnisse als belegte Berichte mit Befundmatrix im Projekt ab. Berechnungen, Bemessung und Unterschrift bleiben bei Ihnen.',
      blocks: [
        {
          kind: 'list',
          title: 'Was Piloti übernimmt',
          items: [
            'Tiefenrecherche: Piloti schlägt einen Rechercheplan vor, Sie bearbeiten ihn, der Bericht landet im Projekt unter „Berichte“, mit Urteil und Befundmatrix, als PDF oder Word exportierbar.',
            'Brandschutz: Brandabschnitte, Fluchtwege und Feuerwiderstand, sobald die Gebäudeklasse steht, getrennt nach dem, was die Richtlinie verlangt, und dem, ob dieses Gebäude es erfüllt.',
            'Wärme- und Schallschutz: U-Wert-, HWB- und Schallanforderungen, zuerst geklärt, ob Neubau oder Bestand.',
            'Prüfungen nach Gebäudeklasse als Tabelle mit Fundstelle und Ergebnis je Zeile, etwa „2 erfüllt · 1 offen“, und Varianten in Tabs, etwa zwei Bundesländer nebeneinander.',
            'Eigene Arbeitsweisen im Skill-Editor, damit wiederkehrende Prüfungen so ablaufen, wie Ihr Büro sie macht.',
          ],
        },
        {
          kind: 'text',
          title: 'Die Lage in Ziviltechnik- und Ingenieurbüros',
          body: [
            'Brandschutzplanung, Bauphysik, Tragwerksplanung, Prüfberichte, Gutachten: Ziviltechniker:innen und Ingenieurbüros arbeiten oft für Architekturbüros und Bauherren in mehreren Bundesländern, meist mit wenig Zeit und hoher Haftung. Jede Aussage im Bericht muss sich auf eine Fundstelle stützen, und die Fundstelle muss im Land und in der Ausgabe stimmen, die für das Projekt gilt.',
            'Genau dort entsteht der Aufwand: Die OIB-Richtlinien gelten laut OIB-Übersicht nicht überall in derselben Ausgabe, die Länder ergänzen eigene Regeln, und im Bestand gilt oft etwas anderes als im Neubau. Das eigentliche Fachwissen ist da; es ist das Nachschlagen und Belegen, das Tage frisst.',
          ],
        },
        {
          kind: 'steps',
          title: 'Eine Woche mit Piloti',
          body: 'Ein erfundenes Beispiel, kein Kundenbericht. So kann eine Woche in einem Büro für Brandschutz und Bauphysik aussehen.',
          items: [
            {
              name: 'Montag',
              body: 'Ein Architekturbüro schickt einen Wohnbau in Gebäudeklasse 4 in Niederösterreich. Piloti übernimmt die bestätigte Gebäudeklasse aus dem Projekt und stellt die Brandschutzanforderungen als Tabelle zusammen.',
            },
            {
              name: 'Dienstag',
              body: 'Tiefenrecherche zu einer Aufstockung, die in Wien und in Graz geplant wird. Sie streichen einen Punkt aus dem vorgeschlagenen Rechercheplan und ergänzen einen; danach liegt der Bericht im Projekt.',
            },
            {
              name: 'Mittwoch',
              body: 'Sanierung eines Schulgebäudes: Piloti klärt zuerst, ob Neubau- oder Bestandsanforderungen an den Wärmeschutz gelten. Den HWB rechnen Sie wie immer in Ihrer Software.',
            },
            {
              name: 'Donnerstag',
              body: 'Der Entwurf des Prüfberichts wird im Gespräch überarbeitet. Jede Fassung bleibt erhalten; die Kollegin fordert Änderungen an, dann wird freigegeben.',
            },
            {
              name: 'Freitag',
              body: '„Prüf das jeden Montag“: Piloti geht die offenen Punkte des Wohnbaus ab jetzt jede Woche neu durch.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Daten und Vertraulichkeit',
          body: [
            'Unterlagen Ihrer Auftraggeber bleiben im Projekt, Ihr Büroarchiv ist für kein anderes Büro sichtbar, mit den Daten wird kein Modell trainiert, und Dateien bleiben Eigentum des Büros. Die Einzelheiten für Ihre Verträge stehen in der Datenschutzerklärung.',
          ],
        },
        {
          kind: 'text',
          title: 'Pilotphase',
          body: [
            'Piloti ist in der Pilotphase mit ausgewählten Büros. Der beste Test ist eine Frage, die Sie diese Woche ohnehin beantworten müssen: Schicken Sie sie über „Mit einer echten Frage testen“.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Berechnung, Bemessung und Unterschrift bleiben bei Ihnen; Piloti recherchiert die Anforderung und legt jede Fundstelle offen, damit Sie sie prüfen können. Verweist eine Richtlinie auf eine ÖNORM, nennt Piloti sie, und den Normtext schlagen Sie in Ihrer Lizenz nach. Ein von Piloti geschriebenes Dokument wird zur zitierbaren Quelle, sobald Ihr Büro es freigibt und veröffentlicht.',
          ],
        },
      ],
      faq: [
        {
          q: 'Kann Piloti ein Gutachten oder eine Stellungnahme schreiben?',
          a: 'Piloti entwirft Dokumente wie Aktenvermerk, Protokoll oder Checkliste und legt Tiefenrecherchen als Bericht mit Befundmatrix ab. Fachliche Aussage, Verantwortung und Unterschrift bleiben bei Ihnen; ein Entwurf wird erst zur Quelle, wenn Ihr Büro ihn freigibt.',
        },
        {
          q: 'Rechnet Piloti den HWB oder U-Werte?',
          a: 'Die Berechnung bleibt in Ihrer Fachsoftware. Piloti klärt, welche Wärmeschutzanforderung gilt, ob Neubau oder Bestand, nennt die Fundstelle und stellt Ihre gerechneten Werte dem Grenzwert gegenüber, mit Ergebnis je Bauteil.',
        },
        {
          q: 'Wie geht Piloti mit ÖNORMen um?',
          a: 'Piloti nennt die Norm, auf die eine Richtlinie oder ein Gesetz verweist, an der Stelle, an der sie zählt. Den Normtext schlagen Sie in Ihrer eigenen Lizenz nach.',
        },
        {
          q: 'Wie geht Piloti mit unterschiedlichen OIB-Ausgaben um?',
          a: 'Piloti sagt, welche Ausgabe im Bundesland des Projekts gilt, wenn das die Antwort verändert. Zwei Länder kann es in Tabs nebeneinanderstellen. Übergangsregeln prüfen Sie in der Bautechnikvorschrift des Landes.',
        },
      ],
    },
    en: {
      title: 'AI for civil engineers and consulting engineers – Piloti',
      description:
        'AI for civil engineers and engineering offices in Austria: Piloti researches requirements from state law and OIB guidelines and files cited reports.',
      heading: 'AI for civil engineers and engineering offices',
      lede: 'Anyone who signs an expert statement needs more than a plausible answer: the citation, the assumption and the limit of the statement. Piloti is built to lay all three open.',
      answer:
        'For civil engineers (Ziviltechniker:innen) and engineering offices in construction, Piloti researches requirements from state law, OIB guidelines and federal law, separates requirement from evidence, and files results as cited reports with a findings matrix in the project. Calculations, design and signature stay with you.',
      blocks: [
        {
          kind: 'list',
          title: 'What Piloti takes on',
          items: [
            'In-depth research: Piloti proposes a research plan, you edit it, and the report lands in the project under “Berichte”, with verdict and findings matrix, exportable as PDF or Word.',
            'Fire safety: fire compartments, escape routes and fire resistance once the building class stands, separating what the guideline demands from whether this building meets it.',
            'Thermal and sound insulation: U-value, HWB and sound requirements, after first settling whether it is new build or existing.',
            'Checks by building class as tables with a citation and a result per row, for example “2 met · 1 open”, and options in tabs, such as two states side by side.',
            'Your own ways of working in the skill editor, so that recurring checks run the way your office does them.',
          ],
        },
        {
          kind: 'text',
          title: 'The situation in civil and consulting engineering offices',
          body: [
            'Fire safety design, building physics, structural design, inspection reports, expert opinions: civil engineers and engineering offices often work for architecture offices and clients in several states, usually with little time and high liability. Every statement in a report must rest on a citation, and the citation must be right for the state and edition that apply to the project.',
            'That is where the effort lies: per the OIB overview, the OIB guidelines do not apply in the same edition everywhere, states add their own rules, and existing buildings often follow different rules from new builds. The expertise is there; it is looking things up and citing them that eats days.',
          ],
        },
        {
          kind: 'steps',
          title: 'A week with Piloti',
          body: 'An invented example, not a customer report. This is what a week can look like in a fire safety and building physics office.',
          items: [
            {
              name: 'Monday',
              body: 'An architecture office sends a housing block in building class 4 in Lower Austria. Piloti takes the confirmed building class from the project and compiles the fire safety requirements as a table.',
            },
            {
              name: 'Tuesday',
              body: 'In-depth research on an added storey planned in both Vienna and Graz. You strike one point from the proposed research plan and add one; then the report is in the project.',
            },
            {
              name: 'Wednesday',
              body: 'Refurbishment of a school building: Piloti first clarifies whether new-build or existing-building thermal requirements apply. You calculate the HWB in your software as always.',
            },
            {
              name: 'Thursday',
              body: 'The draft inspection report is revised in the conversation. Every version is kept; a colleague requests changes, then it is approved.',
            },
            {
              name: 'Friday',
              body: '“Check this every Monday”: from now on Piloti goes through the housing block’s open points every week.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Data and confidentiality',
          body: [
            'Your clients’ documents stay in the project, your office archive is visible to no other office, no model is trained on the data, and drawings remain the office’s property. The details for your contracts are in the privacy policy.',
          ],
        },
        {
          kind: 'text',
          title: 'Pilot phase',
          body: [
            'Piloti is in its pilot phase with selected offices. The best test is a question you have to answer this week anyway: send it via “Try it with a real question”.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Calculation, dimensioning and signature stay with you; Piloti researches the requirement and lays every citation open so you can check it. Where a guideline refers to an ÖNORM, Piloti names it, and you look up the text under your licence. A document Piloti wrote becomes a citable source once your office approves and publishes it.',
          ],
        },
      ],
      faq: [
        {
          q: 'Can Piloti write an expert opinion or statement?',
          a: 'Piloti drafts documents such as file notes, minutes or checklists and files in-depth research as a report with a findings matrix. The professional statement, responsibility and signature remain yours; a draft becomes a source only once your office approves it.',
        },
        {
          q: 'Does Piloti calculate the HWB or U-values?',
          a: 'The calculation stays in your specialist software. Piloti clarifies which thermal requirement applies, new build or existing, cites it and sets your calculated values against the limit, with a result per element.',
        },
        {
          q: 'How does Piloti handle ÖNORM standards?',
          a: 'Piloti names the standard a guideline or law refers to, at the point where it matters. You look up the text under your own licence.',
        },
        {
          q: 'How does Piloti handle different OIB editions?',
          a: 'Piloti says which edition applies in the project’s state when that changes the answer. It can set two states side by side in tabs. You check transition rules in the state’s building-technology rules.',
        },
      ],
    },
  },
  {
    slug: 'baumeister-bautraeger',
    checked: '2026-09',
    related: ['anwendungen/bebauung', 'anwendungen/einreichcheck', 'anwendungen/gebaeudeklasse', 'glossar/bebauungsplan', 'glossar/reihenhaus'],
    de: {
      title: 'KI für Baumeister und Bauträger in Österreich – Piloti',
      description:
        'KI für Baumeister und Bauträger: Piloti beantwortet Baurechtsfragen der Planungsphase, von der Bebauung bis zum Einreichcheck, mit Fundstelle aus Landesrecht.',
      heading: 'KI für Baumeister und Bauträger: wo Piloti hilft',
      lede: 'Piloti ist für Planungsfragen gebaut. Baumeisterbetriebe und Bauträger haben viele davon, vor allem bevor gebaut wird: Was geht auf dem Grundstück, welche Gebäudeklasse, was fehlt der Einreichung? Genau diese Fragen beantwortet Piloti, mit Fundstelle.',
      answer:
        'Für Baumeister und Bauträger beantwortet Piloti die Baurechtsfragen der Planungsphase, etwa was auf einem Grundstück gebaut werden darf, welche Gebäudeklasse ein Projekt hat und was einer Einreichung fehlt, mit Fundstelle aus Landesrecht und OIB-Richtlinien. So beginnt das Gespräch mit Planungsbüro und Behörde mit den richtigen Fragen.',
      blocks: [
        {
          kind: 'list',
          title: 'Was Piloti übernimmt',
          items: [
            'Bebauung: was auf einem Grundstück gebaut werden darf, Bauklasse bzw. Gebäudehöhe, Bauwich, Widmung, Dichte, Stellplätze, nach Landes- und Gemeinderecht. Liegt der Bebauungsplan im Projekt, liest Piloti ihn mit; fehlt er, sagt Piloti das.',
            'Gebäudeklasse: die OIB-Einstufung, zum Beispiel für eine Reihenhausanlage, und daraus die Brandschutzanforderungen.',
            'Einreichcheck: was dem Paket für das Bundesland noch fehlt, je nach Verfahrensart.',
            'Bestand: welche Anforderungen nach Umbau, Aufstockung oder Nutzungsänderung gelten, ohne Neubauregeln auf ein bestehendes Haus anzuwenden.',
            'Vergleiche in Tabs, etwa zwei Bebauungsvarianten oder dasselbe Projekt in zwei Bundesländern.',
          ],
        },
        {
          kind: 'text',
          title: 'Wo Baurecht im Baumeister- und Bauträgeralltag steckt',
          body: [
            'Baumeisterbetriebe planen und bauen, oft Einfamilienhäuser, Reihenhausanlagen und kleinere Wohnbauten. Bauträger entwickeln Projekte vom Grundstück an. In beiden Fällen fällt eine Reihe von Entscheidungen, bevor die erste Schaufel in die Erde geht: ob sich ein Grundstück lohnt, welche Bebauung der Bebauungsplan zulässt, in welche Gebäudeklasse das Projekt fällt und was das für den Brandschutz bedeutet.',
            'Diese Fragen landen oft beim Planungsbüro, beim Amt oder bei der einen Person im Haus, die das Baurecht am besten kennt. Piloti ist für diese Vorarbeit gedacht, damit das Gespräch mit Planer:innen und Behörde mit den richtigen Fragen beginnt.',
          ],
        },
        {
          kind: 'steps',
          title: 'Eine Woche mit Piloti',
          body: 'Ein erfundenes Beispiel, kein Kundenbericht. So kann eine Woche bei einem Bauträger aussehen, der ein Grundstück für Reihenhäuser prüft.',
          items: [
            {
              name: 'Montag',
              body: 'Der Bebauungsplan des Grundstücks kommt ins Projekt. Piloti fasst die Festlegungen zusammen, die für eine Reihenhausanlage zählen, und nennt, was der Bebauungsplan offenlässt.',
            },
            {
              name: 'Dienstag',
              body: 'Vier Häuser oder zwei Doppelhäuser? Piloti stellt beide Varianten nebeneinander, mit der Gebäudeklasse jeder Variante und der Fundstelle in den OIB-Begriffsbestimmungen.',
            },
            {
              name: 'Mittwoch',
              body: 'Das Grundstück liegt am Hang. Piloti fragt nach dem Fluchtniveau des höchsten Hauses, statt es zu schätzen, und erklärt, warum es für jedes Haus gesondert zählt.',
            },
            {
              name: 'Donnerstag',
              body: 'Aus dem Termin mit der Gemeinde wird ein Protokoll, entworfen von Piloti, ergänzt vom Projektleiter, freigegeben von der Geschäftsführung.',
            },
            {
              name: 'Freitag',
              body: 'Der Einreichcheck zeigt zwei offene Unterlagen. Die Liste geht als Word-Datei an das Planungsbüro, das die Einreichung verfasst.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Ihre Daten',
          body: [
            'Grundstücksunterlagen und Projektdaten bleiben im Projekt, Ihr Archiv sieht kein anderes Unternehmen, mit Ihren Daten werden keine Modelle trainiert, und Dateien bleiben Ihr Eigentum. Die Einzelheiten stehen in der Datenschutzerklärung.',
          ],
        },
        {
          kind: 'text',
          title: 'Pilotphase',
          body: [
            'Piloti ist in der Pilotphase mit ausgewählten Büros. Was es für Ihre Planungsfragen leistet, zeigt am schnellsten eine echte: Schicken Sie uns eine über „Mit einer echten Frage testen“.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Piloti ist für die Planungsphase gebaut; Bauleitung, Kalkulation und Ausschreibung laufen in Ihren bestehenden Werkzeugen. Planung und Einreichung verantworten Planer:innen mit der passenden Befugnis, und die verbindliche Auskunft zum Grundstück gibt die Baubehörde. Piloti liefert die Fundstellen dafür und fragt nach dem Bebauungsplan, wenn er fehlt.',
          ],
        },
      ],
      faq: [
        {
          q: 'Ist Piloti eine Software für die Baustelle?',
          a: 'Nein. Piloti ist für Planungsfragen gebaut: Bebauung, Gebäudeklasse, Brandschutz, Bestand, Einreichung. Für Bauleitung, Bautagebuch, Kalkulation oder Ausschreibung brauchen Sie andere Werkzeuge.',
        },
        {
          q: 'Kann Piloti sagen, wie viel ich auf einem Grundstück bauen darf?',
          a: 'Wenn der Bebauungsplan im Projekt liegt, fasst Piloti seine Festlegungen mit Fundstelle zusammen und nennt die Regeln des Landesrechts, die dazukommen. Ohne den Bebauungsplan sagt es, wo Sie nachsehen. Verbindlich ist die Auskunft der Baubehörde.',
        },
        {
          q: 'Hilft Piloti bei Reihenhausanlagen?',
          a: 'Ja, bei der Planungsseite: ob die Anlage nach den OIB-Begriffsbestimmungen als Reihenhaus gilt, welche Gebäudeklasse sich ergibt und welche Brandschutzanforderungen folgen. Das Fluchtniveau zählt dabei für jedes Haus gesondert.',
        },
        {
          q: 'Brauche ich trotzdem ein Planungsbüro?',
          a: 'Ja. Piloti bereitet Entscheidungen vor und zeigt, was fehlt, aber es entwirft nicht, zeichnet nicht und verfasst keine Einreichung. Die Planung und ihre Verantwortung bleiben bei Planer:innen mit der passenden Befugnis.',
        },
      ],
    },
    en: {
      title: 'AI for master builders and developers in Austria – Piloti',
      description:
        'AI for master builders and developers in Austria: Piloti answers planning-stage building law questions, from plot rules to submission, with citations.',
      heading: 'AI for master builders and developers: where Piloti helps',
      lede: 'Piloti is built for planning questions. Master builders and developers have plenty of them, above all before anything is built: what fits on the plot, which building class, what the submission still lacks? Those are exactly the questions Piloti answers, with citations.',
      answer:
        'For master builders and developers, Piloti answers the building law questions of the planning stage, such as what may be built on a plot, which building class a project has and what a submission still lacks, with citations from state law and OIB guidelines. That way the conversation with the planning office and the authority starts with the right questions.',
      blocks: [
        {
          kind: 'list',
          title: 'What Piloti takes on',
          items: [
            'Plot rules: what may be built on a plot, Bauklasse or building height, side distances, zoning, density, parking, under state and municipal law. If the development plan is in the project, Piloti reads it too; if it is missing, Piloti says so.',
            'Building class: the OIB classification, for example for a row house scheme, and from it the fire safety requirements.',
            'Submission check: what the package for the state still lacks, depending on the type of procedure.',
            'Existing buildings: which requirements apply after alteration, adding a storey or change of use, without applying new-build rules to an existing house.',
            'Comparisons in tabs, such as two development options or the same project in two states.',
          ],
        },
        {
          kind: 'text',
          title: 'Where building law sits in a master builder’s or developer’s day',
          body: [
            'Master builders (Baumeister) design and build, often single-family houses, row house schemes and smaller housing blocks. Developers take projects from the plot onwards. In both cases a string of decisions falls before the first spade goes into the ground: whether a plot is worth it, what the development plan allows, which building class the project falls into and what that means for fire safety.',
            'These questions often land with the planning office, the authority or the one person in-house who knows building law best. Piloti is meant for this groundwork, so that the conversation with planners and authority starts with the right questions.',
          ],
        },
        {
          kind: 'steps',
          title: 'A week with Piloti',
          body: 'An invented example, not a customer report. This is what a week can look like at a developer assessing a plot for row houses.',
          items: [
            {
              name: 'Monday',
              body: 'The plot’s development plan goes into the project. Piloti summarises the provisions that matter for a row house scheme and names what the development plan leaves open.',
            },
            {
              name: 'Tuesday',
              body: 'Four houses in a row or two semi-detached pairs? Piloti sets both options side by side, with each option’s building class and the citation in the OIB definitions.',
            },
            {
              name: 'Wednesday',
              body: 'The plot is on a slope. Piloti asks for the escape level of the highest house instead of estimating it, and explains why it counts separately for each house.',
            },
            {
              name: 'Thursday',
              body: 'The meeting with the municipality becomes minutes, drafted by Piloti, completed by the project manager, approved by management.',
            },
            {
              name: 'Friday',
              body: 'The submission check shows two outstanding documents. The list goes as a Word file to the planning office preparing the submission.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Your data',
          body: [
            'Plot documents and project data stay in the project, no other company sees your archive, no models are trained on your data, and drawings remain your property. The details are in the privacy policy.',
          ],
        },
        {
          kind: 'text',
          title: 'Pilot phase',
          body: [
            'Piloti is in its pilot phase with selected offices. What it does for your planning questions is fastest shown by a real one: send us one via “Try it with a real question”.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti is built for the planning stage; site management, costing and tendering run in your existing tools. Design and submission are the responsibility of planners with the matching authorisation, and the binding answer on the plot comes from the building authority. Piloti supplies the citations for it and asks for the development plan when it is missing.',
          ],
        },
      ],
      faq: [
        {
          q: 'Is Piloti construction site software?',
          a: 'No. Piloti is built for planning questions: plot rules, building class, fire safety, existing buildings, submission. For site management, site diaries, costing or tendering you need other tools.',
        },
        {
          q: 'Can Piloti tell me how much I may build on a plot?',
          a: 'If the development plan is in the project, Piloti summarises its provisions with citations and names the state law rules that apply on top. Without the development plan it says where to look. The building authority’s answer is the binding one.',
        },
        {
          q: 'Does Piloti help with row house schemes?',
          a: 'Yes, on the planning side: whether the scheme counts as a row house under the OIB definitions, which building class results and which fire safety requirements follow. The escape level counts separately for each house.',
        },
        {
          q: 'Do I still need a planning office?',
          a: 'Yes. Piloti prepares decisions and shows what is missing, but it does not design, draw or prepare a submission. The design and responsibility for it stay with planners who hold the matching authorisation.',
        },
      ],
    },
  },
]
