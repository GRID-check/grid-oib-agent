import type { LandingEntry } from '../../lib/landing'

export const anwendungen: LandingEntry[] = [
  {
    slug: 'gebaeudeklasse',
    checked: '2026-09',
    related: [
      'glossar/gebaeudeklasse',
      'glossar/fluchtniveau',
      'glossar/oberirdisches-geschoss',
      'anwendungen/brandschutz',
      'baurecht/wien',
    ],
    de: {
      title: 'Gebäudeklasse bestimmen nach OIB: GK 1 bis 5 – Piloti',
      description:
        'Gebäudeklasse bestimmen nach OIB: welche Angaben die GK entscheiden, welche Ausgabe im Bundesland gilt und wie Piloti die Klasse mit Fundstelle einordnet.',
      heading: 'Gebäudeklasse bestimmen: GK 1 bis 5 nach OIB',
      lede: 'Piloti ordnet Ihr Gebäude in GK 1 bis 5 ein, mit dem Wortlaut der Begriffsbestimmungen als Beleg und der Ausgabe, die in Ihrem Bundesland gilt. Fehlt eine entscheidende Angabe, stellt es genau eine Frage.',
      note: 'Begriffe nach: OIB-Richtlinien, Begriffsbestimmungen, Ausgabe Mai 2023.',
      answer:
        'Piloti bestimmt die OIB-Gebäudeklasse (GK 1 bis 5) aus Fluchtniveau, Zahl der oberirdischen Geschoße, Fläche und Nutzung, bei GK 1 und GK 2c auch aus der Zugänglichkeit von mindestens drei Seiten, und liefert die Klasse als kopierbaren Wert mit geprüfter Fundstelle und der Ausgabe, die im Bundesland gilt.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was Piloti liefert',
          items: [
            {
              name: 'Die Klasse zuerst',
              body: 'Oben steht das Ergebnis als kopierbarer Wert, etwa „GK 3“, darunter die kurze Begründung und die Annahmen, auf denen es ruht.',
            },
            {
              name: 'Eine Fallunterscheidung, wo es kippt',
              body: 'Liegt ein Projekt an einer Grenze, stehen die Fälle nebeneinander, etwa mit und ohne ausgebautes Dachgeschoß.',
            },
            {
              name: 'Eine Schnittskizze',
              body: 'Wo Höhe und Fluchtniveau der Gegenstand sind, zeichnet Piloti einen schematischen Schnitt mit Geschoßen, Gelände und Fluchtniveau.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Warum die Einordnung heikel ist',
          body: [
            'Die Gebäudeklasse folgt aus vier Angaben, und an jeder hängt ein typischer Fehler. Das Fluchtniveau ist nicht die Gebäudehöhe, sondern der Höhenunterschied zwischen dem Fußboden des höchsten oberirdischen Geschoßes und dem Gelände nach Fertigstellung, im Mittel. Ein nicht ausgebauter Dachraum zählt nicht als oberirdisches Geschoß. GK 1 bis 3 rechnen mit der Brutto-Grundfläche, GK 4a mit der Nutzfläche der einzelnen Wohnung oder Betriebseinheit.',
            'Dazu kommt die Ausgabe. Die OIB-Richtlinien gelten erst, wenn ein Bundesland sie verbindlich erklärt, und die Länder tun das zu verschiedenen Zeitpunkten. Laut OIB-Übersicht (Stand September 2025) gilt die Ausgabe 2023 der Richtlinien 1 bis 5 etwa in Wien seit 23. Februar 2024, in Niederösterreich seit 18. März 2025 und in Oberösterreich seit 1. Oktober 2025. Wo ein Land sie nicht erklärt hat, gilt in der Regel noch die Ausgabe 2019. Maßgeblich bleibt die Bautechnikvorschrift des Landes, denn sie kann Ausnahmen und Übergangsregeln setzen.',
          ],
        },
        {
          kind: 'steps',
          title: 'So arbeitet Piloti die Frage durch',
          items: [
            {
              name: 'Bestätigte Klasse übernehmen',
              body: 'Steht im Projekt eine Gebäudeklasse als bestätigt, arbeitet Piloti mit ihr. Widerspricht Ihre Frage ihr, sagt Piloti das und bleibt bei der bestätigten, bis jemand sie ändert.',
            },
            {
              name: 'Die eine fehlende Angabe erfragen',
              body: 'Fehlt die Klasse und ändert sie die Antwort, fragt Piloti genau das, was sie entscheidet: Fluchtniveau, oberirdische Geschoße oder Nutzung. Eine Frage, kein Formular. Lässt sich unter einer klar benannten Annahme sinnvoll antworten, tut Piloti das und markiert die Annahme.',
            },
            {
              name: 'Ausgabe und Bundesland festhalten',
              body: 'Piloti nennt die Ausgabe, die im Bundesland des Projekts gilt, dort, wo sie das Ergebnis verschiebt, und zitiert die Stelle.',
            },
            {
              name: 'Mit Fundstelle einordnen',
              body: 'Die Einordnung stützt sich auf den Wortlaut der Begriffsbestimmungen. Jedes Zitat wird vor dem Anzeigen gegen den Quelltext geprüft.',
            },
            {
              name: 'Den Plan ansehen, wenn er entscheidet',
              body: 'Liegen Schnitt oder Ansicht im Projekt, sieht Piloti sie als Bild an und sagt, welche Zeichnung auf dem Blatt es gelesen hat.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Was Piloti von Ihnen braucht',
          items: [
            'Das Bundesland, oder ein Projekt, in dem es steht.',
            'Das Fluchtniveau oder die Koten, aus denen es sich ergibt: Fußbodenoberkante des höchsten oberirdischen Geschoßes und das angrenzende Gelände nach Fertigstellung.',
            'Die Zahl der oberirdischen Geschoße, und ob das Dachgeschoß ausgebaut ist.',
            'Die Nutzung und die Zahl der Wohnungen oder Betriebseinheiten, mit ihren Flächen.',
            'Bei freistehenden Gebäuden: ob sie an mindestens drei Seiten für die Brandbekämpfung von außen zugänglich sind.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Die Einordnung liefert Piloti mit Fundstelle, damit Ihr Büro sie nachprüfen kann; die Verantwortung für die Planung bleibt bei Ihnen. Eine Kote, die der Plan nicht eindeutig zeigt, erfragt Piloti, statt sie zu schätzen. Ein Grenzprojekt besprechen Sie mit dieser Begründung im Vorgespräch mit der Behörde.',
          ],
        },
      ],
      faq: [
        {
          q: 'Wie bestimme ich die Gebäudeklasse nach OIB?',
          a: 'Sie brauchen Fluchtniveau, Zahl der oberirdischen Geschoße, Fläche und Nutzung, bei GK 1 und GK 2c auch die Zugänglichkeit von drei Seiten. GK 1 bis 3 enden laut OIB-Begriffsbestimmungen bei drei oberirdischen Geschoßen und einem Fluchtniveau von 7,00 m, GK 4 bei vier Geschoßen und 11 m, GK 5 bei einem Fluchtniveau von 22 m. Welche Ausgabe gilt, legt Ihr Bundesland fest.',
        },
        {
          q: 'Ist die Gebäudeklasse dasselbe wie die Bauklasse?',
          a: 'Nein. Die Gebäudeklasse stammt aus den OIB-Richtlinien und steuert vor allem die Anforderungen an den Brandschutz. Die Bauklasse ist ein Begriff der Bauordnung für Wien, über den der Bebauungsplan die zulässige Gebäudehöhe festlegt. Ein Wiener Gebäude hat beides, und beides folgt aus verschiedenen Regeln.',
        },
        {
          q: 'Wie wird ein Reihenhaus eingestuft?',
          a: 'Bei Reihenhäusern ist laut OIB-Begriffsbestimmungen jede Wohnung bzw. Betriebseinheit hinsichtlich des Fluchtniveaus gesondert zu betrachten. GK 2b erfasst Reihenhäuser mit nicht mehr als drei oberirdischen Geschoßen, einem Fluchtniveau von nicht mehr als 7,00 m und Einheiten von jeweils nicht mehr als 400 m² Brutto-Grundfläche der oberirdischen Geschoße.',
        },
      ],
    },
    en: {
      title: 'Determine the OIB building class: GK 1 to 5 – Piloti',
      description:
        'Determining the OIB building class: which facts decide it, which edition applies in each state, and how Piloti classifies a building with a citation.',
      heading: 'Determining the building class: GK 1 to 5 under OIB',
      lede: 'Piloti places your building in GK 1 to 5, with the wording of the OIB definitions as evidence and the edition that applies in your state. If a deciding fact is missing, it asks exactly one question.',
      note: 'Terms from: OIB-Richtlinien, Begriffsbestimmungen, edition May 2023.',
      answer:
        'Piloti determines the OIB building class (GK 1 to 5) from the escape level, the number of above-ground storeys, the floor area and the use, and for GK 1 and GK 2c also from access on at least three sides, and delivers the class as a copyable value with a checked citation and the edition that applies in the state.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What Piloti delivers',
          items: [
            {
              name: 'The class first',
              body: 'The result comes first as a copyable value, such as “GK 3”, followed by the short reasoning and the assumptions it rests on.',
            },
            {
              name: 'A case split where it tips',
              body: 'If a project sits on a boundary, the cases stand side by side, such as with and without a converted attic.',
            },
            {
              name: 'A section sketch',
              body: 'Where height and escape level are the subject, Piloti draws a schematic section with storeys, ground and escape level.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Why the classification is tricky',
          body: [
            'The building class follows from four facts, and each has a typical mistake attached. The escape level (Fluchtniveau) is not the building height but the difference between the floor of the highest above-ground storey and the ground after completion, averaged. An unconverted attic does not count as an above-ground storey. GK 1 to 3 use gross floor area, GK 4a the usable area of each individual flat or business unit.',
            'Then there is the edition. The OIB guidelines apply only once a state declares them binding, and the states do so at different times. According to the OIB overview (as of September 2025), the 2023 edition of guidelines 1 to 5 applies in Vienna since 23 February 2024, in Lower Austria since 18 March 2025 and in Upper Austria since 1 October 2025, among others. Where a state has not declared it, the 2019 edition generally still applies. The state’s building-technology rules remain decisive, because they can set exceptions and transition rules.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti works through the question',
          items: [
            {
              name: 'Take the confirmed class',
              body: 'If the project holds a confirmed building class, Piloti works with it. If your question contradicts it, Piloti says so and stays with the confirmed one until someone changes it.',
            },
            {
              name: 'Ask for the one missing fact',
              body: 'If the class is missing and changes the answer, Piloti asks exactly what decides it: escape level, above-ground storeys or use. One question, not a form. If a clearly stated assumption allows a useful answer, Piloti gives it and marks the assumption.',
            },
            {
              name: 'Pin down edition and state',
              body: 'Piloti names the edition that applies in the project’s state wherever it moves the result, and cites the passage.',
            },
            {
              name: 'Classify with a citation',
              body: 'The classification rests on the wording of the definitions. Every citation is checked against the source text before it is shown.',
            },
            {
              name: 'Look at the drawing when it decides',
              body: 'If a section or elevation is in the project, Piloti looks at it as an image and says which drawing on the sheet it read.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'What Piloti needs from you',
          items: [
            'The state, or a project that records it.',
            'The escape level, or the levels it follows from: finished floor of the highest above-ground storey and the adjoining ground after completion.',
            'The number of above-ground storeys, and whether the attic is converted.',
            'The use and the number of flats or business units, with their areas.',
            'For detached buildings: whether they are accessible from outside for firefighting on at least three sides.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti delivers the classification with its citation so your office can check it; responsibility for the design stays with you. A level the drawing does not show clearly is asked for rather than estimated. A borderline project goes into the pre-application meeting with this reasoning in hand.',
          ],
        },
      ],
      faq: [
        {
          q: 'How do I determine the building class under OIB?',
          a: 'You need the escape level, the number of above-ground storeys, the floor area and the use, and for GK 1 and GK 2c also access on three sides. According to the OIB definitions, GK 1 to 3 end at three above-ground storeys and an escape level of 7.00 m, GK 4 at four storeys and 11 m, GK 5 at an escape level of 22 m. Which edition applies is set by your state.',
        },
        {
          q: 'Is the building class the same as the Bauklasse?',
          a: 'No. The building class comes from the OIB guidelines and mainly drives the fire safety requirements. The Bauklasse is a term of the Vienna building code through which the zoning plan sets the permitted building height. A Viennese building has both, and they follow from different rules.',
        },
        {
          q: 'How is a terraced house classified?',
          a: 'For terraced houses, the OIB definitions say each flat or business unit is to be considered separately with regard to the escape level. GK 2b covers terraced houses with no more than three above-ground storeys, an escape level of no more than 7.00 m and units of no more than 400 m² gross floor area of the above-ground storeys each.',
        },
      ],
    },
  },
  {
    slug: 'brandschutz',
    checked: '2026-09',
    related: ['glossar/brandabschnitt', 'anwendungen/gebaeudeklasse', 'anwendungen/bestand', 'baurecht/wien', 'vergleich/chatgpt'],
    de: {
      title: 'Brandschutz nach OIB-Richtlinie 2 mit KI prüfen – Piloti',
      description:
        'Brandschutz nach OIB-Richtlinie 2 mit KI prüfen: Fluchtweg, Brandabschnitt und Feuerwiderstand, getrennt nach Anforderung und Nachweis, mit Fundstelle.',
      heading: 'Fluchtweg und Brandabschnitt prüfen nach OIB-Richtlinie 2',
      lede: 'Feuerwiderstand, Fluchtweglänge, Brandabschnitt: Piloti klärt zuerst die Gebäudeklasse, zitiert dann die Anforderung bis zum Punkt und prüft auf Wunsch Ihren Grundriss dagegen, Segment für Segment.',
      answer:
        'Piloti prüft den Brandschutz nach OIB-Richtlinie 2 in der Reihenfolge, in der die Richtlinie gebaut ist: zuerst Gebäudeklasse und die im Bundesland geltende Ausgabe, dann die Anforderung mit geprüfter Fundstelle, dann auf Wunsch der Befund am Plan. Jede Antwort sagt, ob sie die Anforderung beschreibt oder ihre Erfüllung prüft.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was Piloti liefert',
          items: [
            {
              name: 'Den Fluchtweg als Diagramm',
              body: 'Ein Fluchtweg aus mehreren Segmenten wird gezeichnet, jedes Segment einzeln. Die Frage ist fast immer, welches Segment zu lang ist, nicht ob die Summe stimmt.',
            },
            {
              name: 'Brandabschnitte als Prüftabelle',
              body: 'Eine Zeile je Abschnitt, mit Fläche, Grenzwert, Quelle und Ergebnis, oben zusammengefasst, etwa „2 erfüllt · 1 offen“.',
            },
            {
              name: 'Zufahrt und Aufstellfläche',
              body: 'Wo die Feuerwehrzufahrt die Frage ist, zeigt eine Skizze Zufahrt, Durchfahrt und Aufstellfläche.',
            },
            {
              name: 'Varianten nebeneinander',
              body: 'Zwei Lösungen für ein Stiegenhaus stehen als Tabs nebeneinander, jede mit eigenem Urteil.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Warum Brandschutzfragen heikel sind',
          body: [
            'Die OIB-Richtlinie 2 ist nach Gebäudeklassen gebaut. Eine Feuerwiderstandsklasse ohne die Klasse, aus der sie folgt, ist eine Zahl ohne Anspruch, und eine Zahl aus der falschen Ausgabe liest sich so überzeugend wie die richtige. Die Ausgabe 2023 ist nicht überall verbindlich; wo ein Land sie nicht erklärt hat, gilt laut OIB-Übersicht in der Regel noch die Ausgabe 2019.',
            'Dazu kommt Landesrecht. Die Länder übernehmen die Richtlinie über ihre Bautechnikvorschriften, mit eigenen Abweichungen. In Wien stehen neben der Wiener Bautechnikverordnung 2023 die Merkblätter der MA 37. Was bindet und was nur auslegt, gehört deshalb in die Antwort.',
            'Und am Ende steht der Unterschied, der am leichtesten verloren geht. Die Richtlinie sagt, was erfüllt sein muss. Ob es in diesem Gebäude erfüllt ist, ist ein Befund am Vorhaben. Eine grobe Prüfung am Plan ist kein Brandschutzkonzept.',
          ],
        },
        {
          kind: 'steps',
          title: 'So arbeitet Piloti die Frage durch',
          items: [
            {
              name: 'Gebäudeklasse klären',
              body: 'Fehlt sie und ändert sie die Antwort, stellt Piloti sie zuerst fest. Vorher fällt keine Widerstandsklasse.',
            },
            {
              name: 'Ausgabe nennen',
              body: 'Piloti holt die im Bundesland verbindliche Fassung und nennt sie überall dort, wo sie den Wert verschiebt.',
            },
            {
              name: 'Die Anforderung holen',
              body: 'Sie kommt aus dem Wortlaut der Richtlinie und der Bautechnikvorschrift des Landes, zitiert bis zum Punkt, etwa „Pkt. 3.5.2 · S. 7“, und vor dem Anzeigen gegen den Quelltext geprüft.',
            },
            {
              name: 'Den zweiten Fluchtweg als zwei Fragen behandeln',
              body: 'Ob einer verlangt ist, folgt aus Klasse und Nutzung. Ob er zählt, folgt daraus, wohin er führt. Piloti beantwortet beides oder sagt, welche der beiden offen ist.',
            },
            {
              name: 'Am Plan prüfen, wenn Sie das wollen',
              body: 'Liegen Grundrisse im Projekt, liest Piloti sie als Bild und prüft Segment für Segment. Das Ergebnis heißt dann Befund, nicht Anforderung, und die Antwort sagt, welches der beiden Sie vor sich haben.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Was Piloti von Ihnen braucht',
          items: [
            'Bundesland und Gebäudeklasse, oder die Angaben, aus denen die Klasse folgt.',
            'Die Nutzung, auch der einzelnen Teile: Wohnen, Büro, Garage, Verkauf.',
            'Für eine Prüfung am Plan: die Grundrisse der betroffenen Geschoße, möglichst bemaßt.',
            'Ob Neubau oder Bestand. Bei einem Umbau gelten oft andere Wege als beim Neubau.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Piloti bereitet Anforderung und Befund mit Fundstelle vor; Brandschutzkonzept und Verantwortung bleiben bei der Brandschutzplanung. Fehlt die Gebäudeklasse, fragt Piloti danach, bevor eine Widerstandsklasse fällt. Verweist die Richtlinie auf eine Norm, nennt Piloti sie, und den Normtext schlagen Sie in Ihrer Lizenz nach.',
          ],
        },
      ],
      faq: [
        {
          q: 'Kann eine KI den Brandschutz nach OIB-Richtlinie 2 prüfen?',
          a: 'Sie kann die Anforderungen mit Fundstelle nennen und einen Plan grob dagegen lesen. Piloti tut beides und sagt jeweils, welches davon die Antwort ist. Das Brandschutzkonzept und die Verantwortung dafür bleiben bei den Planenden.',
        },
        {
          q: 'Warum fragt Piloti zuerst nach der Gebäudeklasse?',
          a: 'Weil nahezu jede Anforderung der OIB-Richtlinie 2 an ihr hängt. Eine Feuerwiderstandsklasse ohne Gebäudeklasse wäre geraten. Steht die Klasse bestätigt im Projekt, fragt Piloti nicht nach.',
        },
        {
          q: 'Welche Ausgabe der OIB-Richtlinie 2 gilt in meinem Bundesland?',
          a: 'Das legt jedes Land selbst fest. Laut OIB-Übersicht (Stand September 2025) gilt die Ausgabe 2023 etwa in Wien, Niederösterreich, Oberösterreich und Kärnten, in Tirol seit 16. Juli 2026; wo sie nicht erklärt ist, in der Regel noch die Ausgabe 2019. Prüfen Sie die Bautechnikvorschrift Ihres Landes, denn Übergangsregeln können abweichen.',
        },
        {
          q: 'Was ist ein Brandabschnitt?',
          a: 'Ein Teil eines Gebäudes, der durch brandabschnittsbildende Wände und Decken vom übrigen Gebäude getrennt ist, damit sich ein Brand nicht darüber hinaus ausbreitet. Wie groß er sein darf und was die trennenden Bauteile leisten müssen, regelt die OIB-Richtlinie 2 abhängig von Gebäudeklasse und Nutzung.',
        },
      ],
    },
    en: {
      title: 'Fire safety under OIB guideline 2, checked with AI – Piloti',
      description:
        'Checking fire safety under OIB guideline 2 with AI: escape routes, fire compartments and fire resistance, requirement apart from evidence, with citations.',
      heading: 'Checking escape routes and fire compartments under OIB guideline 2',
      lede: 'Fire resistance, escape route length, fire compartment: Piloti settles the building class first, then cites the requirement to the clause and, on request, checks your floor plan against it, segment by segment.',
      answer:
        'Piloti checks fire safety under OIB guideline 2 in the order the guideline is built: building class and the edition in force in the state first, then the requirement with a checked citation, then, on request, the finding on the drawing. Every answer says whether it describes the requirement or checks that it is met.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What Piloti delivers',
          items: [
            {
              name: 'The escape route as a diagram',
              body: 'An escape route made of several segments is drawn with each segment separately. The question is almost always which segment is too long, not whether the total fits.',
            },
            {
              name: 'Fire compartments as a check table',
              body: 'One row per compartment, with area, limit, source and result, summarised at the top, such as “2 met · 1 open”.',
            },
            {
              name: 'Access and staging area',
              body: 'Where fire brigade access is the question, a sketch shows the approach, passage and staging area.',
            },
            {
              name: 'Options side by side',
              body: 'Two solutions for a stairwell stand side by side as tabs, each with its own verdict.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Why fire safety questions are tricky',
          body: [
            'OIB guideline 2 is organised by building class. A fire resistance class without the building class it follows from is a number with no standing, and a number from the wrong edition reads just as convincingly as the right one. The 2023 edition is not binding everywhere; where a state has not declared it, the 2019 edition generally still applies, according to the OIB overview.',
            'Then there is state law. The states adopt the guideline through their building-technology rules, with their own deviations. In Vienna, the MA 37 information sheets sit next to the Wiener Bautechnikverordnung 2023. What binds and what merely interprets therefore belongs in the answer.',
            'And at the end is the difference that is easiest to lose. The guideline says what must be met. Whether it is met in this building is a finding about the project. A rough check on the drawing is not a fire safety concept.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti works through the question',
          items: [
            {
              name: 'Settle the building class',
              body: 'If it is missing and changes the answer, Piloti determines it first. No resistance class is named before that.',
            },
            {
              name: 'Name the edition',
              body: 'Piloti takes the version binding in the state and names it wherever it moves the value.',
            },
            {
              name: 'Fetch the requirement',
              body: 'It comes from the wording of the guideline and the state’s building-technology rules, cited to the clause, such as “Pkt. 3.5.2 · S. 7”, and checked against the source text before it is shown.',
            },
            {
              name: 'Treat the second escape route as two questions',
              body: 'Whether one is required follows from class and use. Whether it counts follows from where it leads. Piloti answers both or says which of the two is open.',
            },
            {
              name: 'Check on the drawing if you want it',
              body: 'If floor plans are in the project, Piloti reads them as images and checks segment by segment. The result is then called a finding, not a requirement, and the answer says which of the two you are looking at.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'What Piloti needs from you',
          items: [
            'State and building class, or the facts the class follows from.',
            'The use, including that of individual parts: housing, office, garage, retail.',
            'For a check on the drawing: floor plans of the storeys concerned, dimensioned where possible.',
            'Whether it is new build or existing. A conversion often has different routes than a new building.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti prepares requirement and finding with citations; the fire safety concept and the responsibility for it stay with the fire safety designer. If the building class is missing, Piloti asks for it before naming a resistance class. Where the guideline refers to a standard, Piloti names it, and you look up the text under your licence.',
          ],
        },
      ],
      faq: [
        {
          q: 'Can AI check fire safety under OIB guideline 2?',
          a: 'It can name the requirements with citations and read a drawing roughly against them. Piloti does both and says which of the two each answer is. The fire safety concept and the responsibility for it stay with the designers.',
        },
        {
          q: 'Why does Piloti ask for the building class first?',
          a: 'Because nearly every requirement in OIB guideline 2 hinges on it. A fire resistance class without a building class would be a guess. If the class is confirmed in the project, Piloti does not ask.',
        },
        {
          q: 'Which edition of OIB guideline 2 applies in my state?',
          a: 'Each state decides. According to the OIB overview (as of September 2025), the 2023 edition applies in Vienna, Lower Austria, Upper Austria and Carinthia, among others, and in Tyrol since 16 July 2026; where it is not declared, generally still the 2019 edition. Check your state’s building-technology rules, because transition rules can differ.',
        },
        {
          q: 'What is a fire compartment?',
          a: 'A part of a building separated from the rest by compartment walls and floors, so that a fire does not spread beyond it. How large it may be and what the separating elements must achieve is set by OIB guideline 2, depending on building class and use.',
        },
      ],
    },
  },
  {
    slug: 'einreichcheck',
    checked: '2026-09',
    related: ['glossar/einreichplan', 'anwendungen/pruefbericht-aktenvermerk', 'anwendungen/bebauung', 'baurecht/wien', 'vergleich/chatgpt'],
    de: {
      title: 'Einreichunterlagen prüfen: Einreichcheck mit Piloti',
      description:
        'Einreichunterlagen prüfen vor dem Bauansuchen: Piloti gleicht Ihr Paket mit der Liste aus der Bauordnung Ihres Bundeslands ab und zeigt, was noch fehlt.',
      heading: 'Einreichunterlagen prüfen: Was fehlt dem Bauansuchen noch?',
      lede: 'Piloti legt die Unterlagenliste aus der Bauordnung Ihres Bundeslands neben Ihr Einreichpaket und zeigt Stück für Stück, was da ist und was fehlt. Aus jeder Lücke wird ein offener Punkt im Projekt.',
      answer:
        'Der Einreichcheck von Piloti gleicht Ihr Einreichpaket mit den Unterlagen ab, die Bauordnung und Verordnungen Ihres Bundeslands für dieses Verfahren verlangen, und führt jedes Stück mit Fundstelle als vorhanden, fehlend oder nicht anwendbar. So steht vor dem Bauansuchen fest, dass das Paket vollständig ist; was fehlt, wird zur Aufgabe im Projekt.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was Piloti liefert',
          items: [
            {
              name: 'Eine Prüftabelle, eine Zeile je Unterlage',
              body: 'Mit Status, Fundstelle und Ergebnis, oben die Zählung je Status. Nichts steht als „vermutlich dabei“: Die offenen Punkte sind die Arbeitsliste, nicht eine Fußnote.',
            },
            {
              name: 'Das Verfahren als Ablauf',
              body: 'Einreichung, Verhandlung, Bewilligung, Fertigstellung als nummerierte Stufen, der Schritt, an dem Ihr Projekt steht, markiert, sobald das Gespräch ihn kennt.',
            },
            {
              name: 'Behörde und Büro getrennt',
              body: 'Was das Gesetz verlangt und was Ihr Büro verlangt, in zwei Gruppen, jede mit ihrer eigenen Quelle.',
            },
            {
              name: 'Eine Checkliste für das Team',
              body: 'Auf Wunsch schreibt Piloti die offenen Punkte als Checkliste ins Projekt, mit Fassungen und Freigabe, und als Word-Datei zum Herunterladen.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Warum eine Checkliste aus der Schublade nicht reicht',
          body: [
            'Welche Unterlagen die Behörde verlangt, steht in der Bauordnung des Landes und in seinen Verordnungen. Neun Länder, neun Listen, und nicht jedes Vorhaben braucht dasselbe Verfahren: Bauansuchen, Bauanzeige, Abweichung und Fertigstellungsanzeige sind verschiedene Pakete, und das Land entscheidet, welches Ihr Vorhaben braucht.',
            'Die teuerste Art, vollständig auszusehen, ist eine erinnerte Wiener Liste auf einem niederösterreichischen Vorhaben. Jedes Stück scheint da, nur das eine nicht, das dort verlangt wird.',
            'Und dann gibt es, was Ihr Büro zusätzlich verlangt, etwa eine interne Freigabe. Das steht nicht in der Bauordnung, sondern in Ihrem Büroarchiv, und es gehört getrennt geführt.',
          ],
        },
        {
          kind: 'steps',
          title: 'So arbeitet Piloti die Frage durch',
          items: [
            {
              name: 'Verfahren und Land festhalten',
              body: 'Steht das Bundesland im Projekt, arbeitet Piloti darunter und nennt es. Fehlt es, ist das die eine Frage. Dann das Verfahren: Bauansuchen oder Bauanzeige, Abweichung oder Fertigstellung.',
            },
            {
              name: 'Die Liste aus dem Gesetz holen',
              body: 'Die geforderten Unterlagen holt Piloti aus Bauordnung und Verordnungen des Landes im RIS, nicht aus dem Gedächtnis. Was Ihr Büro zusätzlich fordert, kommt aus dem Büroarchiv und steht in eigenen Zeilen.',
            },
            {
              name: 'Abgleichen',
              body: 'Jedes geforderte Stück wird gegen die Projektunterlagen gehalten: vorhanden mit Fundstelle, fehlt, oder nicht anwendbar mit der Klausel, die es entbehrlich macht. Die Namen bleiben die der Bestimmung. Was sie „Lageplan“ nennt, heißt auch in der Antwort Lageplan.',
            },
            {
              name: 'Offene Punkte zu Arbeit machen',
              body: 'Was fehlt, wird zum offenen Punkt im Projektgedächtnis, und „Klären“ macht aus einem davon eine eigene Aufgabe. Den ganzen Check können Sie als Aufgabe mit Termin geben: „Mach den Einreichcheck bis Freitag.“',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Was Piloti von Ihnen braucht',
          items: [
            'Das Bundesland, und wenn Sie es schon wissen, das Verfahren.',
            'Die Art des Vorhabens: Neubau, Zubau, Umbau, Nutzungsänderung.',
            'Die Unterlagen, die schon da sind: Pläne, Baubeschreibung, Nachweise, Zustimmungen, als PDF, Word, Excel oder ganzer Ordner.',
            'Falls es eine gibt: die Einreich-Checkliste Ihres Büros im Büroarchiv.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Der Einreichcheck stellt die Vollständigkeit des Pakets fest; ob der Entwurf die Anforderungen erfüllt, prüfen die Arbeitsweisen zu Gebäudeklasse, Brandschutz und Bebauung. Was eine Baubehörde über das Gesetz hinaus in ihrer Praxis verlangt, nimmt Piloti mit, sobald Ihr Büro es im Archiv festgehalten hat. Unterschrift und Verantwortung für die Einreichung bleiben bei der Planverfasser:in.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche Unterlagen brauche ich für die Einreichung?',
          a: 'Das hängt vom Bundesland und vom Verfahren ab: Die Bauordnung und ihre Verordnungen legen fest, was einem Bauansuchen oder einer Bauanzeige beizulegen ist. Einreichplan, Lageplan und Baubeschreibung sind fast immer dabei, die verbindliche Liste steht aber im Landesrecht. Piloti holt sie für Ihr Land aus dem RIS und gleicht sie mit Ihrem Paket ab.',
        },
        {
          q: 'Prüft der Einreichcheck, ob mein Projekt genehmigungsfähig ist?',
          a: 'Nein. Er prüft die Vollständigkeit der Unterlagen. Ob der Entwurf die Anforderungen erfüllt, ist eine eigene Frage, die Piloti mit den Arbeitsweisen zu Gebäudeklasse, Brandschutz, Bebauung und den übrigen Richtlinien bearbeitet.',
        },
        {
          q: 'Kann Piloti den Einreichcheck regelmäßig wiederholen?',
          a: 'Ja. Sie geben ihn als Aufgabe mit Termin oder planen ihn wiederkehrend ein, etwa mit „prüf das jeden Montag“. Die Aufgabe läuft unter Ihrem Namen und mit Ihren Rechten.',
        },
        {
          q: 'Was ist der Unterschied zwischen Bauansuchen und Bauanzeige?',
          a: 'Beides sind Verfahren nach der Bauordnung des Landes, aber für verschiedene Vorhaben und mit verschiedenen Unterlagen. Welches Vorhaben welches Verfahren braucht, regelt jedes Bundesland selbst, und Begriffe wie Schwellen unterscheiden sich. Piloti nennt die Bestimmung Ihres Landes, bevor es die Liste aufstellt.',
        },
      ],
    },
    en: {
      title: 'Checking submission documents: the Einreichcheck',
      description:
        'Checking submission documents before filing: Piloti compares your package with the list in your state’s building code and shows what is still missing.',
      heading: 'Checking submission documents: what is the application still missing?',
      lede: 'Piloti lays the document list from your state’s building code next to your submission package and shows, item by item, what is there and what is missing. Every gap becomes an open point in the project.',
      answer:
        'Piloti’s Einreichcheck compares your submission package with the documents your state’s building code and regulations require for this procedure, and records each item with its citation as present, missing or not applicable. Before you file, you know the package is complete; whatever is missing becomes a task in the project.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What Piloti delivers',
          items: [
            {
              name: 'A check table, one row per document',
              body: 'With status, location and result, and a count per status at the top. Nothing is “probably included”: the open points are the work list, not a footnote.',
            },
            {
              name: 'The procedure as a sequence',
              body: 'Submission, hearing, permit, completion as numbered stages, with the step your project is at marked as soon as the conversation knows it.',
            },
            {
              name: 'Authority and office kept apart',
              body: 'What the law requires and what your office requires, in two groups, each with its own source.',
            },
            {
              name: 'A checklist for the team',
              body: 'On request Piloti writes the open points as a checklist into the project, with versions and approval, and as a Word file to download.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Why a checklist from the drawer is not enough',
          body: [
            'Which documents the authority requires is set in the state’s building code and its regulations. Nine states, nine lists, and not every project needs the same procedure: building application, building notice, deviation and completion notice are different packages, and the state decides which one your project needs.',
            'The most expensive way to look complete is a remembered Vienna list applied to a Lower Austrian project. Every item seems to be there, except the one required there.',
            'And then there is what your office requires on top, such as an internal sign-off. That is not in the building code but in your office archive, and it belongs in its own rows.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti works through the question',
          items: [
            {
              name: 'Pin down procedure and state',
              body: 'If the project records the state, Piloti works under it and names it. If not, that is the one question. Then the procedure: building application or building notice, deviation or completion.',
            },
            {
              name: 'Take the list from the law',
              body: 'Piloti takes the required documents from the state’s building code and regulations in RIS, not from memory. What your office requires on top comes from the office archive and stands in its own rows.',
            },
            {
              name: 'Compare',
              body: 'Each required item is held against the project documents: present with its location, missing, or not applicable with the clause that makes it unnecessary. Names stay those of the provision. What it calls “Lageplan” is called Lageplan in the answer too.',
            },
            {
              name: 'Turn open points into work',
              body: 'What is missing becomes an open point in the project memory, and “Klären” turns one of them into its own task. You can hand over the whole check as a task with a deadline: “Mach den Einreichcheck bis Freitag.”',
            },
          ],
        },
        {
          kind: 'list',
          title: 'What Piloti needs from you',
          items: [
            'The state, and the procedure if you already know it.',
            'The type of project: new build, extension, conversion, change of use.',
            'The documents you already have: drawings, building description, certificates, consents, as PDF, Word, Excel or a whole folder.',
            'If there is one: your office’s submission checklist in the office archive.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'The Einreichcheck establishes that the package is complete; whether the design meets the requirements is checked by the ways of working for building class, fire safety and plot rules. What an authority asks for in practice beyond the law, Piloti includes once your office has recorded it in the archive. Signature and responsibility for the submission stay with the responsible planner.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which documents do I need for a building permit submission?',
          a: 'It depends on the state and the procedure: the building code and its regulations set what must accompany a building application or a building notice. Submission drawings, site plan and building description are almost always part of it, but the binding list is in state law. Piloti takes it for your state from RIS and compares it with your package.',
        },
        {
          q: 'Does the Einreichcheck tell me whether my project can be approved?',
          a: 'No. It checks whether the documents are complete. Whether the design meets the requirements is a separate question, which Piloti works through with the ways of working for building class, fire safety, plot rules and the other guidelines.',
        },
        {
          q: 'Can Piloti repeat the check regularly?',
          a: 'Yes. You hand it over as a task with a deadline or schedule it to recur, for example with “prüf das jeden Montag”. The task runs under your name and with your permissions.',
        },
        {
          q: 'What is the difference between a building application and a building notice?',
          a: 'Both are procedures under the state’s building code, but for different projects and with different documents. Which project needs which procedure is set by each state, and terms and thresholds differ. Piloti names your state’s provision before it draws up the list.',
        },
      ],
    },
  },
  {
    slug: 'bestand',
    checked: '2026-09',
    related: [
      'anwendungen/gebaeudeklasse',
      'anwendungen/waermeschutz',
      'glossar/oberirdisches-geschoss',
      'glossar/oib-richtlinien',
      'baurecht/wien',
    ],
    de: {
      title: 'Bauen im Bestand nach OIB: Umbau und Nutzungsänderung',
      description:
        'Bauen im Bestand nach OIB: welche Anforderungen bei Umbau, Zubau oder Nutzungsänderung gelten, was der Bestand trägt und wie Piloti das Vorhaben einordnet.',
      heading: 'Bauen im Bestand: Was nach Umbau und Nutzungsänderung gilt',
      lede: 'Der größte Teil der Arbeit in einem Planungsbüro ist Bestand. Piloti ordnet zuerst das Vorhaben nach der Bauordnung Ihres Landes ein und zitiert erst dann die Anforderung, die für genau diesen Eingriff gilt, nicht die für den Neubau daneben.',
      answer:
        'Bei Umbau, Zubau, Nutzungsänderung oder größerer Renovierung ordnet Piloti den Eingriff zuerst mit Fundstelle nach der Bauordnung Ihres Landes ein, prüft die Gebäudeklasse neu und nennt dann die OIB-Anforderungen, die für dieses Vorhaben gelten. Ist eine Anforderung am Bestand nicht haltbar, baut Piloti den Abweichungsfall mit Schutzziel und Nachweis auf.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was Piloti liefert',
          items: [
            {
              name: 'Das Regime mit Fundstelle',
              body: 'Oben steht, als welches Vorhaben der Eingriff gilt und nach welcher Bestimmung.',
            },
            {
              name: 'Eine Fallunterscheidung',
              body: 'Gabelt sich die Antwort am Regime, stehen die Fälle als Tabelle nebeneinander, Ihr Fall markiert, sobald er feststeht. Bestand und geänderter Zustand lassen sich als Tabs vergleichen.',
            },
            {
              name: 'Eine Prüftabelle',
              body: 'Mehrere Anforderungen, jede mit eigenem Urteil, eigener Quelle und dem Regime, zu dem sie gehört.',
            },
            {
              name: 'Einen Hinweis, wenn er den nächsten Schritt ändert',
              body: 'Eine Frist oder ein Vorbehalt steht hervorgehoben über der Antwort, höchstens einer, damit er nicht zwischen anderen untergeht.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Warum Bestand schwieriger ist als Neubau',
          body: [
            'Umbau, Zubau, Nutzungsänderung, größere Renovierung, Instandsetzung: Die Worte klingen verwandt und sind rechtlich nicht austauschbar. Welche Bestimmungen ein Eingriff auslöst, hängt davon ab, wie die Bauordnung des Landes ihn einordnet, und jedes Land tut das mit eigenen Begriffen und Schwellen.',
            'Die OIB-Richtlinien sind zu großen Teilen vom Neubau her geschrieben, und die verbindliche Ausgabe heute ist oft eine andere als bei der ursprünglichen Bewilligung. Eine Neubau-Klausel auf einen Dachausbau gelegt liest sich korrekt und ist trotzdem falsch. Das ist gefährlicher als eine offensichtlich falsche Zahl, weil niemand stutzt.',
            'Und ein Umbau kann die Gebäudeklasse verschieben. Ein ausgebautes Dachgeschoß mit Wohnungen wird zum oberirdischen Geschoß, das Fluchtniveau steigt. Ändert sich die Klasse, ändert sich fast jede spätere Zahl, vom Feuerwiderstand bis zum Fluchtweg.',
          ],
        },
        {
          kind: 'steps',
          title: 'So arbeitet Piloti die Frage durch',
          items: [
            {
              name: 'Das Vorhaben einordnen',
              body: 'Piloti holt die Bestimmung, die für Ihr Land Umbau, Zubau und Nutzungsänderung unterscheidet, und ordnet das Vorhaben dort ein. Steht die Vorhabensart schon im Projekt, wird sie gelesen, nicht überschrieben. Ist sie unklar, kommt eine Frage, statt unter Neubau weiterzuarbeiten und es am Ende zu erwähnen.',
            },
            {
              name: 'Klären, was noch bindet',
              body: 'Bestandsschutz, die verbindliche OIB-Ausgabe, ob eine größere Renovierung die Hülle neu aufrollt: Jedes davon ist eine Klausel, die sich holen lässt, kein Gefühl.',
            },
            {
              name: 'Die Gebäudeklasse neu prüfen',
              body: 'Verschiebt der Eingriff Geschoßzahl, Fluchtniveau oder Nutzung, stellt Piloti die Klasse neu fest, bevor eine Anforderung fällt.',
            },
            {
              name: 'Anforderungen dem Regime zuordnen',
              body: 'Jede zitierte Anforderung gehört zu dem Regime, das für dieses Vorhaben gilt, nicht zum Neubau daneben.',
            },
            {
              name: 'Eine Abweichung als Fall aufbauen',
              body: 'Ist eine Anforderung am Bestand nicht haltbar, baut Piloti den Fall: welche Anforderung nicht erfüllt wird, mit Fundstelle; welches Schutzziel sie trägt; womit dasselbe Ziel an diesem Objekt erreicht wird; was dafür nachzuweisen ist.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Was Piloti von Ihnen braucht',
          items: [
            'Bundesland und Vorhaben, in Ihren Worten: „Dachausbau mit zwei Wohnungen“, „aus dem Büro wird eine Arztpraxis“.',
            'Den bewilligten Bestand, soweit vorhanden: Baubescheid, Bestandspläne, frühere Auflagen.',
            'Die Nutzung vorher und nachher.',
            'Die Eingriffe in Tragwerk, Hülle und Erschließung, soweit sie feststehen.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Was ein Bestand rechtmäßig trägt, liest Piloti aus den Bescheiden des Gebäudes; fehlen sie im Projekt, sagt es das, statt einen bewilligten Zustand anzunehmen. Einen Abweichungsfall baut Piloti als belegte Argumentation auf, über das gleiche Schutzniveau entscheidet die Behörde. Die Verantwortung für die Planung bleibt bei Ihrem Büro.',
          ],
        },
      ],
      faq: [
        {
          q: 'Gelten bei einem Umbau die Anforderungen für Neubau?',
          a: 'Nicht automatisch. Welche Anforderungen ein Umbau auslöst, hängt davon ab, wie die Bauordnung Ihres Landes das Vorhaben einordnet und welche Teile des Gebäudes betroffen sind. Piloti klärt zuerst das Regime und zitiert erst dann eine Anforderung.',
        },
        {
          q: 'Was ist eine Nutzungsänderung im Baurecht?',
          a: 'Eine Änderung des Verwendungszwecks eines Gebäudes oder Gebäudeteils, etwa vom Büro zur Wohnung. Ob sie bewilligungs- oder anzeigepflichtig ist und welche Anforderungen sie auslöst, regelt die Bauordnung des Landes. Oft verschiebt sie auch die Gebäudeklasse oder die Anforderungen an Brandschutz und Belichtung.',
        },
        {
          q: 'Kann ein Dachausbau die Gebäudeklasse ändern?',
          a: 'Ja. Ein ausgebautes Dachgeschoß mit Wohnungen zählt als oberirdisches Geschoß, wenn es überwiegend über dem Gelände liegt, und es hebt das Fluchtniveau. Beides kann das Gebäude in eine höhere Gebäudeklasse schieben, mit Folgen für fast jede Brandschutzanforderung.',
        },
        {
          q: 'Hilft Piloti bei einer Abweichung von den OIB-Richtlinien?',
          a: 'Es baut den Fall auf: welche Anforderung nicht erfüllt wird, welches Schutzziel sie trägt, womit dasselbe Ziel an diesem Objekt erreicht wird und was nachzuweisen ist. Die Entscheidung darüber trifft die Behörde.',
        },
      ],
    },
    en: {
      title: 'Existing buildings under OIB: conversion and change of use',
      description:
        'Existing buildings under OIB: which requirements apply to conversion, extension or change of use, what existing rights carry, and how Piloti classifies it.',
      heading: 'Existing buildings: what applies after conversion and change of use',
      lede: 'Most of the work in a planning office is existing stock. Piloti first classifies the project under your state’s building code and only then cites the requirement that applies to exactly this intervention, not the one for the new build next door.',
      answer:
        'For a conversion, extension, change of use or major renovation, Piloti first classifies the intervention with a citation under your state’s building code, checks the building class again and then names the OIB requirements that apply to this project. If a requirement cannot be met in the existing building, Piloti builds the deviation case with protection goal and evidence.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What Piloti delivers',
          items: [
            {
              name: 'The regime with a citation',
              body: 'At the top: what kind of project the intervention counts as, and under which provision.',
            },
            {
              name: 'A case split',
              body: 'If the answer forks at the regime, the cases stand side by side in a table, with your case marked once it is settled. Existing and altered states can be compared as tabs.',
            },
            {
              name: 'A check table',
              body: 'Several requirements, each with its own verdict, its own source and the regime it belongs to.',
            },
            {
              name: 'A note when it changes the next step',
              body: 'A deadline or a reservation stands highlighted above the answer, one at most, so it does not get lost among the others.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Why existing buildings are harder than new ones',
          body: [
            'Conversion, extension, change of use, major renovation, repair: the words sound related and are not interchangeable in law. Which provisions an intervention triggers depends on how the state’s building code classifies it, and each state does so with its own terms and thresholds.',
            'The OIB guidelines are largely written from new build outwards, and the edition binding today is often not the one that applied at the original permit. A new-build clause applied to an attic conversion reads correctly and is still wrong. That is more dangerous than an obviously wrong number, because nobody stops to question it.',
            'And a conversion can shift the building class. A converted attic with flats becomes an above-ground storey, and the escape level rises. If the class changes, almost every later number changes, from fire resistance to escape routes.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti works through the question',
          items: [
            {
              name: 'Classify the project',
              body: 'Piloti fetches the provision that distinguishes conversion, extension and change of use in your state and places the project there. If the project type is already recorded, it is read, not overwritten. If it is unclear, a question comes, rather than carrying on as new build and mentioning it at the end.',
            },
            {
              name: 'Settle what still binds',
              body: 'Existing rights, the binding OIB edition, whether a major renovation reopens the building envelope: each of these is a clause that can be fetched, not a feeling.',
            },
            {
              name: 'Check the building class again',
              body: 'If the intervention shifts the number of storeys, the escape level or the use, Piloti settles the class again before naming a requirement.',
            },
            {
              name: 'Assign requirements to the regime',
              body: 'Every requirement cited belongs to the regime that applies to this project, not to the new build next to it.',
            },
            {
              name: 'Build a deviation as a case',
              body: 'If a requirement cannot be met in the existing building, Piloti builds the case: which requirement is not met, with its citation; which protection goal it serves; how the same goal is reached in this building; what has to be demonstrated for it.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'What Piloti needs from you',
          items: [
            'State and project, in your own words: “attic conversion with two flats”, “the office becomes a medical practice”.',
            'The permitted existing state, as far as available: building permit, as-built drawings, earlier conditions.',
            'The use before and after.',
            'The interventions in structure, envelope and circulation, as far as they are settled.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'What an existing building lawfully carries, Piloti reads from its permits; if they are not in the project, it says so instead of assuming a permitted state. Piloti builds a deviation case as a sourced argument, and the authority decides whether the same level of protection is reached. Responsibility for the design stays with your office.',
          ],
        },
      ],
      faq: [
        {
          q: 'Do new-build requirements apply to a conversion?',
          a: 'Not automatically. Which requirements a conversion triggers depends on how your state’s building code classifies the project and which parts of the building are affected. Piloti settles the regime first and only then cites a requirement.',
        },
        {
          q: 'What is a change of use in building law?',
          a: 'A change in the purpose of a building or part of a building, for example from office to flat. Whether it needs a permit or a notice and which requirements it triggers is set by the state’s building code. It often also shifts the building class or the requirements for fire safety and daylight.',
        },
        {
          q: 'Can an attic conversion change the building class?',
          a: 'Yes. A converted attic with flats counts as an above-ground storey if it lies mostly above ground, and it raises the escape level. Both can push the building into a higher class, with consequences for almost every fire safety requirement.',
        },
        {
          q: 'Does Piloti help with a deviation from the OIB guidelines?',
          a: 'It builds the case: which requirement is not met, which protection goal it serves, how the same goal is reached in this building and what has to be demonstrated. The authority decides on it.',
        },
      ],
    },
  },
  {
    slug: 'bebauung',
    checked: '2026-09',
    related: ['glossar/bebauungsplan', 'anwendungen/einreichcheck', 'anwendungen/gebaeudeklasse', 'baurecht/wien'],
    de: {
      title: 'Bebauungsplan prüfen: Was darf ich hier bauen? – Piloti',
      description:
        'Bebauungsplan prüfen: Was darf ich auf dem Grundstück bauen? Bauklasse, Bauwich, Widmung, Dichte und Stellplätze nach Landesrecht erklärt, mit Fundstelle.',
      heading: 'Was darf ich auf dem Grundstück bauen?',
      lede: 'Höhe, Abstand, Dichte, Widmung, Stellplätze: Piloti nennt die Regel aus dem Landesrecht mit Fundstelle, liest den Bebauungsplan im Projekt mit und rechnet mit seinen Festlegungen, als Lageplan-Skizze und Kennzahl.',
      answer:
        'Was auf einem Grundstück gebaut werden darf, legen das Landesrecht und der Flächenwidmungs- und Bebauungsplan der Gemeinde fest, nicht die OIB-Richtlinien. Piloti nennt die Regel mit Fundstelle, rechnet mit den Festlegungen des Plans im Projekt Bebauungsgrad, Dichte und Abstände je Seite und zeigt das Ergebnis als Lageplan-Skizze.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was Piloti liefert',
          items: [
            {
              name: 'Eine Lageplan-Skizze',
              body: 'Grundstück, Fußabdruck und Abstände je Seite; mit den Flächen auch Bebauungsgrad und Dichte, die Quote aus den Flächen gerechnet.',
            },
            {
              name: 'Einen Schnitt für die Höhe',
              body: 'Wo die Höhe über die Geschoße geprüft wird, zeichnet Piloti einen schematischen Schnitt.',
            },
            {
              name: 'Stellplätze als Kennzahl',
              body: 'Gefordert gegen vorhanden, mit der Bemessungsgrundlage im Text, denn ohne sie ist die Zahl nicht prüfbar. Eine errechnete Zahl zeigt ihren Rechenweg.',
            },
            {
              name: 'Varianten',
              body: 'Zwei Baukörper auf demselben Grundstück als Tabs nebeneinander, jeder mit eigenem Urteil.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Warum hier keine österreichweite Zahl hilft',
          body: [
            'Abstände, Höhen, Dichte, Widmung und Stellplätze sind Landes- und Gemeinderecht: Bauordnung, Flächenwidmungsplan, Bebauungsplan, Stellplatzregeln. Die Antwort hängt deshalb immer am Bundesland, und es gibt keine Zahl, die in Graz und in Bregenz gleich gilt.',
            'Die Begriffe wandern mit. In Wien steuert die Bauklasse die zulässige Gebäudehöhe, andere Länder arbeiten mit Geschoßzahlen, Höhen oder Dichtewerten, und was hier Bauwich heißt, heißt dort Abstand. Eine erinnerte Wiener Regel auf ein anderes Land gelegt ist falsch und sieht richtig aus.',
            'Und dann die eigentliche Lücke: Welche Regel greift, lässt sich aus dem Gesetz sagen. Was der Bebauungsplan für dieses eine Grundstück festlegt, steht nur im Plan selbst.',
          ],
        },
        {
          kind: 'steps',
          title: 'So arbeitet Piloti die Frage durch',
          items: [
            {
              name: 'Land und Instrument nennen',
              body: 'Steht das Bundesland im Projekt, arbeitet Piloti darunter. Fehlt es, ist das die Frage. Dann: Welches Instrument trägt die Antwort, Bauordnung, Flächenwidmungsplan, Bebauungsplan oder Stellplatzregel?',
            },
            {
              name: 'Die Bestimmung holen',
              body: 'Die Regel kommt aus dem Landesrecht im RIS, für Wien etwa aus der Bauordnung für Wien oder dem Wiener Garagengesetz 2008, zitiert, wie ein Bescheid sie nennt.',
            },
            {
              name: 'Die Normenkette zeigen',
              body: 'Berührt eine Frage Landesrecht und OIB-Richtlinie zugleich, etwa Abstand und Brandschutz an der Grundgrenze, sagt Piloti, welche Ebene welchen Teil trägt. Was bindet und was nur auslegt, ist hier die eigentliche Information.',
            },
            {
              name: 'Mit dem Plan rechnen, wenn er da ist',
              body: 'Liegt der Bebauungsplan oder ein Auszug im Projekt, liest Piloti die Festlegungen und rechnet damit: Bebauungsgrad, Dichte, Abstände je Seite.',
            },
            {
              name: 'Sagen, was fehlt',
              body: 'Liegt er nicht vor, steht die Zahl ausdrücklich als unbekannt, mit dem Hinweis, wo sie nachzusehen ist. Eine plausible Zahl wird nicht erfunden.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Was Piloti von Ihnen braucht',
          items: [
            'Das Bundesland und die Gemeinde.',
            'Den Flächenwidmungs- und Bebauungsplan oder einen Auszug davon, als PDF oder Bild ins Projekt geladen.',
            'Grundstücksfläche und Grenzen, etwa aus dem Lageplan.',
            'Was Sie bauen wollen: Nutzung, Geschoße, grobe Kubatur.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Die Festlegungen für Ihr Grundstück liest Piloti aus dem Bebauungsplan, den Sie ins Projekt laden; ohne ihn sagt es, welche Regel greift und wo die Festlegung nachzulesen ist. Jede Zahl erscheint mit ihrer Fundstelle, damit Ihr Büro sie prüfen kann. Eine unscharfe Festlegung klären Sie mit der Gemeinde oder im Vorgespräch mit der Baubehörde.',
          ],
        },
      ],
      faq: [
        {
          q: 'Wie finde ich heraus, was ich auf meinem Grundstück bauen darf?',
          a: 'Im Flächenwidmungs- und Bebauungsplan Ihrer Gemeinde und in der Bauordnung Ihres Bundeslands. Der Plan setzt fest, was für das Grundstück gilt; das Gesetz sagt, wie diese Festlegungen zu lesen sind und was gilt, wo der Plan schweigt. Piloti liest beides zusammen, sobald der Plan im Projekt liegt.',
        },
        {
          q: 'Regeln die OIB-Richtlinien den Abstand zur Grundgrenze?',
          a: 'Die Abstände, die die Bebauung regeln, stehen im Landesrecht und im Bebauungsplan. Die OIB-Richtlinie 2 kann an der Grundgrenze zusätzlich Anforderungen an den Brandschutz stellen. Piloti trennt beide Ebenen in der Antwort und sagt, welche welchen Teil trägt.',
        },
        {
          q: 'Was ist der Unterschied zwischen Flächenwidmungsplan und Bebauungsplan?',
          a: 'Der Flächenwidmungsplan legt fest, wofür eine Fläche genutzt werden darf, etwa als Bauland oder Grünland. Der Bebauungsplan regelt, wie darauf gebaut werden darf: Lage, Höhe, Dichte, Abstände. Wie die Pläne heißen und was sie enthalten, bestimmt das Landesrecht; in Wien sind beide in einem Plandokument zusammengefasst.',
        },
        {
          q: 'Kann Piloti den Bebauungsplan für meine Adresse abrufen?',
          a: 'Eine Webrecherche von Piloti kann das Planportal Ihrer Gemeinde finden, mit verlinkter Quelle. Am belastbarsten wird die Antwort mit dem Plan oder einem Auszug im Projekt: Dann liest Piloti die Festlegungen und rechnet damit.',
        },
      ],
    },
    en: {
      title: 'Checking the zoning plan: what may I build here? – Piloti',
      description:
        'Checking the zoning plan: what may I build on this plot? Height class, setbacks, zoning, density and parking under state law, explained with citations.',
      heading: 'What may I build on this plot?',
      lede: 'Height, setback, density, zoning, parking: Piloti names the rule from state law with a citation, reads the zoning plan in the project alongside it and calculates with its provisions, as a site plan sketch and key figures.',
      answer:
        'What may be built on a plot is set by state law and the municipality’s land-use and zoning plan, not by the OIB guidelines. Piloti names the rule with a citation, calculates site coverage, density and setbacks per side from the provisions of the plan in the project, and shows the result as a site plan sketch.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What Piloti delivers',
          items: [
            {
              name: 'A site plan sketch',
              body: 'Plot, footprint and setbacks per side; with the areas also site coverage and density, the ratio calculated from the areas.',
            },
            {
              name: 'A section for height',
              body: 'Where height is checked across the storeys, Piloti draws a schematic section.',
            },
            {
              name: 'Parking as a key figure',
              body: 'Required against provided, with the basis of assessment in the text, because without it the number cannot be checked. A calculated number shows its working.',
            },
            {
              name: 'Options',
              body: 'Two building volumes on the same plot side by side as tabs, each with its own verdict.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Why no Austria-wide number helps here',
          body: [
            'Setbacks, heights, density, zoning and parking are state and municipal law: building code, land-use plan, zoning plan, parking rules. The answer therefore always depends on the state, and there is no number that applies equally in Graz and in Bregenz.',
            'The terms move too. In Vienna the Bauklasse controls the permitted building height; other states work with numbers of storeys, heights or density values, and what one state calls Bauwich another calls Abstand. A remembered Vienna rule applied to another state is wrong and looks right.',
            'And then the real gap: which rule applies can be read from the law. What the zoning plan fixes for this one plot is only in the plan itself.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti works through the question',
          items: [
            {
              name: 'Name state and instrument',
              body: 'If the project records the state, Piloti works under it. If not, that is the question. Then: which instrument carries the answer, building code, land-use plan, zoning plan or parking rule?',
            },
            {
              name: 'Fetch the provision',
              body: 'The rule comes from state law in RIS, for Vienna for example from the Bauordnung für Wien or the Wiener Garagengesetz 2008, cited the way an official decision cites it.',
            },
            {
              name: 'Show the chain of rules',
              body: 'If a question touches state law and an OIB guideline at once, such as setback and fire safety at the boundary, Piloti says which level carries which part. What binds and what only interprets is the real information here.',
            },
            {
              name: 'Calculate with the plan when it is there',
              body: 'If the zoning plan or an extract is in the project, Piloti reads its provisions and calculates with them: site coverage, density, setbacks per side.',
            },
            {
              name: 'Say what is missing',
              body: 'If it is not there, the number is stated as unknown, with a note on where to look it up. A plausible number is not invented.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'What Piloti needs from you',
          items: [
            'The state and the municipality.',
            'The land-use and zoning plan, or an extract, uploaded to the project as a PDF or image.',
            'Plot area and boundaries, for example from the site plan.',
            'What you want to build: use, storeys, rough massing.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti reads the provisions for your plot from the zoning plan you upload to the project; without it, it says which rule applies and where the provision can be found. Every number appears with its source, so your office can check it. An unclear provision is for the municipality or a pre-application meeting with the building authority.',
          ],
        },
      ],
      faq: [
        {
          q: 'How do I find out what I may build on my plot?',
          a: 'In your municipality’s land-use and zoning plan and in your state’s building code. The plan fixes what applies to the plot; the law says how its provisions are to be read and what applies where the plan is silent. Piloti reads both together once the plan is in the project.',
        },
        {
          q: 'Do the OIB guidelines set the distance to the plot boundary?',
          a: 'The setbacks that govern development are in state law and the zoning plan. OIB guideline 2 can add fire safety requirements at the plot boundary. Piloti keeps the two levels apart in the answer and says which carries which part.',
        },
        {
          q: 'What is the difference between the land-use plan and the zoning plan?',
          a: 'The land-use plan (Flächenwidmungsplan) sets what an area may be used for, such as building land or green land. The zoning plan (Bebauungsplan) sets how it may be built on: position, height, density, setbacks. What the plans are called and what they contain is set by state law; in Vienna both are combined in one plan document.',
        },
        {
          q: 'Can Piloti fetch the zoning plan for my address?',
          a: 'Piloti’s web research can find your municipality’s plan portal, with the source linked. The answer is most solid with the plan or an extract in the project: then Piloti reads the provisions and calculates with them.',
        },
      ],
    },
  },
  {
    slug: 'waermeschutz',
    checked: '2026-09',
    related: ['glossar/oib-richtlinien', 'anwendungen/bestand', 'anwendungen/aufenthaltsraum', 'baurecht/wien'],
    de: {
      title: 'U-Wert Anforderung nach OIB-Richtlinie 6 prüfen – Piloti',
      description:
        'U-Wert-Anforderung nach OIB-Richtlinie 6 und Schallschutz: welcher Grenzwert für welches Bauteil gilt, bei Neubau oder Bestand, in welcher Ausgabe.',
      heading: 'U-Wert, HWB und Schallschutz: Was die OIB-Richtlinien 5 und 6 verlangen',
      lede: 'Piloti nennt jeden Grenzwert mit dem Bauteil und der Lage, für die er gilt, beim Schallschutz mit der Paarung der Nutzungen, und stellt Ihre U-Werte in einer Prüftabelle dagegen, Zeile für Zeile.',
      answer:
        'U-Wert-Anforderungen stehen in der OIB-Richtlinie 6 und gelten je Bauteil und Lage, etwa gegen Außenluft, Erdreich oder einen unbeheizten Raum; Schallschutz regelt die OIB-Richtlinie 5 für Bauteile zwischen zwei Nutzungseinheiten. Piloti klärt Ausgabe und Neubau oder Bestand, zitiert den Grenzwert bis zum Punkt und prüft Ihre Werte als Tabelle mit Ergebnis je Bauteil.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was Piloti liefert',
          items: [
            {
              name: 'U-Werte als Prüftabelle',
              body: 'Eine Zeile je Bauteil der Hülle: Istwert, Grenzwert mit ≤, Quelle, Ergebnis.',
            },
            {
              name: 'Den HWB als Kennzahl',
              body: 'Ein gegebener Wert gegen den Grenzwert, mit der Energieeffizienzklasse benannt.',
            },
            {
              name: 'Schallschutz je Paarung',
              body: 'Eine Prüftabelle mit der Paarung in der ersten Spalte, etwa Wohnung zu Wohnung oder Wohnung zu Geschäftslokal.',
            },
            {
              name: 'Neubau und Bestand nebeneinander',
              body: 'Wo beides in Frage kommt, stehen die Anforderungen als Tabs nebeneinander, bis das Vorhaben eingeordnet ist.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Warum die Zahl ohne Bauteil nichts sagt',
          body: [
            'Ein U-Wert-Grenzwert hängt am Bauteil und daran, woran das Bauteil grenzt. Dieselbe Wand hat gegen Außenluft eine andere Anforderung als gegen einen unbeheizten Keller. Wer die Zahl ohne Bauteil und Lage weitergibt, riskiert, dass sie am falschen Bauteil angewandt wird. Beim Schallschutz ist es die Paarung: Die Werte gelten für ein Bauteil zwischen zwei bestimmten Nutzungseinheiten, und die Paarung entscheidet den Wert.',
            'Die Ausgabe ist hier besonders beweglich. Die OIB-Richtlinie 6 gibt es in einer Ausgabe 2025, beschlossen am 29. August 2025. Laut OIB-Übersicht (Stand Juli 2026) gilt sie in Wien seit 15. Juli 2026 und in Tirol seit 16. Juli 2026, in den übrigen Ländern noch nicht. Die Ausgabe 2023 der Richtlinie 6 war laut OIB-Übersicht (Stand September 2025) in Wien, Niederösterreich und Kärnten verbindlich; anderswo gilt in der Regel noch die Ausgabe 2019. Maßgeblich sind die Übergangsregeln des Landes.',
            'Und der größte Teil dieser Fragen betrifft Sanierung. Bestand, Zubau und größere Renovierung holen andere Anforderungen als Neubau, und eine Neubau-Anforderung auf eine Sanierung gelegt ist die typische falsche Antwort.',
          ],
        },
        {
          kind: 'steps',
          title: 'So arbeitet Piloti die Frage durch',
          items: [
            {
              name: 'Neubau oder Bestand klären',
              body: 'Steht es im Projekt, arbeitet Piloti darunter. Fehlt es und macht es einen Unterschied, ist das die eine Frage, und sie kommt, bevor eine Neubau-Anforderung zitiert wird.',
            },
            {
              name: 'Die Ausgabe im Land festhalten',
              body: 'Piloti nennt die Fassung der Richtlinie, die im Bundesland verbindlich ist, und zitiert bis zum Punkt.',
            },
            {
              name: 'Bauteil und Lage zuordnen',
              body: 'Jede Anforderung erscheint mit dem Bauteil und seiner Lage, beim Schallschutz mit der Paarung der Nutzungseinheiten.',
            },
            {
              name: 'Gegebene Werte gegenüberstellen',
              body: 'Nennen Sie einen U-Wert aus Ihrem Bauteilkatalog oder einen HWB aus dem Energieausweis, stellt Piloti ihn der Anforderung gegenüber, mit Ergebnis je Zeile.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Was Piloti von Ihnen braucht',
          items: [
            'Das Bundesland, und ob Neubau, Zubau oder Sanierung.',
            'Die Bauteile mit ihrer Lage, und ihre U-Werte, wenn es sie schon gibt, etwa als Excel-Tabelle.',
            'Für eine HWB-Frage: den Energieausweis oder den gerechneten Wert.',
            'Für den Schallschutz: die Nutzungen auf beiden Seiten des Bauteils.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Einen Heizwärmebedarf berechnet Piloti nicht; es sagt, welche Anforderung gilt und wie ein Wert aus Ihrem Energieausweis dazu steht. Energieausweis und Schallschutznachweis bleiben bei der Bauphysik. Verweist eine Richtlinie auf eine Norm, nennt Piloti sie, und den Normtext schlagen Sie in Ihrer Lizenz nach.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche U-Werte verlangt die OIB-Richtlinie 6?',
          a: 'Die Richtlinie legt Höchstwerte je Bauteil und Lage fest, für Neubau und für größere Renovierung. Welche Tabelle gilt, hängt von der Ausgabe ab, die Ihr Bundesland verbindlich erklärt hat. Piloti nennt den Wert mit Bauteil, Lage und Fundstelle bis zum Punkt.',
        },
        {
          q: 'Gilt die OIB-Richtlinie 6 Ausgabe 2025 schon?',
          a: 'Laut OIB-Übersicht (Stand Juli 2026) in Wien seit 15. Juli 2026 und in Tirol seit 16. Juli 2026, in den übrigen Ländern noch nicht. Dort gilt die Ausgabe 2023 oder 2019, je nachdem, was das Land erklärt hat. Übergangsregeln stehen in der Bautechnikvorschrift des Landes.',
        },
        {
          q: 'Kann Piloti den HWB berechnen?',
          a: 'Den HWB rechnet Ihre Bauphysik-Software für den Energieausweis. Piloti nennt die Anforderung mit Fundstelle, stellt den gerechneten HWB dem Grenzwert gegenüber und benennt die Energieeffizienzklasse.',
        },
        {
          q: 'Wo stehen die Schallschutzanforderungen?',
          a: 'In der OIB-Richtlinie 5, in der Ausgabe, die Ihr Land erklärt hat. Die Werte gelten für Bauteile zwischen zwei bestimmten Nutzungen, deshalb gehört die Paarung in die Antwort. Wo die Richtlinie auf Normen verweist, nennt Piloti sie.',
        },
      ],
    },
    en: {
      title: 'U-value requirement under OIB guideline 6 – Piloti',
      description:
        'U-value requirements under OIB guideline 6 and sound insulation: which limit applies to which element, new build or existing, and which edition applies.',
      heading: 'U-value, HWB and sound insulation: what OIB guidelines 5 and 6 require',
      lede: 'Piloti names every limit with the element and position it applies to, for sound insulation with the pairing of uses, and sets your U-values against it in a check table, row by row.',
      answer:
        'U-value requirements are in OIB guideline 6 and apply per element and position, such as against outside air, ground or an unheated space; sound insulation is set by OIB guideline 5 for elements between two units of use. Piloti settles the edition and new build or existing, cites the limit to the clause and checks your values as a table with a result per element.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What Piloti delivers',
          items: [
            {
              name: 'U-values as a check table',
              body: 'One row per envelope element: actual value, limit with ≤, source, result.',
            },
            {
              name: 'The HWB as a key figure',
              body: 'A given value against the limit, with the energy efficiency class named.',
            },
            {
              name: 'Sound insulation per pairing',
              body: 'A check table with the pairing in the first column, such as flat to flat or flat to shop.',
            },
            {
              name: 'New build and existing side by side',
              body: 'Where both are possible, the requirements stand side by side as tabs until the project is classified.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Why the number says nothing without the element',
          body: [
            'A U-value limit depends on the element and on what the element adjoins. The same wall has a different requirement against outside air than against an unheated basement. Pass on the number without element and position and it may be applied to the wrong element. With sound insulation it is the pairing: the values apply to an element between two particular units of use, and the pairing decides the value.',
            'The edition moves especially fast here. OIB guideline 6 has a 2025 edition, adopted on 29 August 2025. According to the OIB overview (as of July 2026), it applies in Vienna since 15 July 2026 and in Tyrol since 16 July 2026, not yet in the other states. The 2023 edition of guideline 6 was binding in Vienna, Lower Austria and Carinthia according to the OIB overview (as of September 2025); elsewhere the 2019 edition generally still applies. The state’s transition rules are decisive.',
            'And most of these questions concern refurbishment. Existing buildings, extensions and major renovations trigger different requirements than new build, and a new-build requirement applied to a refurbishment is the typical wrong answer.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti works through the question',
          items: [
            {
              name: 'Settle new build or existing',
              body: 'If the project records it, Piloti works under it. If not, and it makes a difference, that is the one question, and it comes before a new-build requirement is cited.',
            },
            {
              name: 'Pin down the edition in the state',
              body: 'Piloti names the version of the guideline binding in the state and cites to the clause.',
            },
            {
              name: 'Assign element and position',
              body: 'Every requirement appears with the element and its position, and for sound insulation with the pairing of units.',
            },
            {
              name: 'Compare given values',
              body: 'Give a U-value from your element catalogue or an HWB from the energy certificate, and Piloti sets it against the requirement, with a result per row.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'What Piloti needs from you',
          items: [
            'The state, and whether it is new build, extension or refurbishment.',
            'The elements with their position, and their U-values if you have them, for example as an Excel sheet.',
            'For an HWB question: the energy certificate or the calculated value.',
            'For sound insulation: the uses on both sides of the element.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti does not calculate the heating demand; it says which requirement applies and how a value from your energy certificate compares. The energy certificate and sound insulation evidence stay with building physics. Where a guideline refers to a standard, Piloti names it, and you look up the text under your licence.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which U-values does OIB guideline 6 require?',
          a: 'The guideline sets maximum values per element and position, for new build and for major renovation. Which table applies depends on the edition your state has declared binding. Piloti names the value with element, position and a citation to the clause.',
        },
        {
          q: 'Is the 2025 edition of OIB guideline 6 in force yet?',
          a: 'According to the OIB overview (as of July 2026), in Vienna since 15 July 2026 and in Tyrol since 16 July 2026, not yet in the other states. There the 2023 or 2019 edition applies, depending on what the state has declared. Transition rules are in the state’s building-technology rules.',
        },
        {
          q: 'Can Piloti calculate the HWB?',
          a: 'Your building physics software calculates the HWB for the energy certificate. Piloti names the requirement with a citation, sets the calculated HWB against the limit and names the energy efficiency class.',
        },
        {
          q: 'Where are the sound insulation requirements?',
          a: 'In OIB guideline 5, in the edition your state has declared. The values apply to elements between two particular uses, so the pairing belongs in the answer. Where the guideline refers to standards, Piloti names them.',
        },
      ],
    },
  },
  {
    slug: 'barrierefreiheit',
    checked: '2026-09',
    related: ['anwendungen/aufenthaltsraum', 'anwendungen/bestand', 'glossar/oib-richtlinien', 'baurecht/wien'],
    de: {
      title: 'Barrierefreiheit nach OIB-RL 4: Treppe, Geländer, Türen',
      description:
        'Barrierefreiheit nach OIB-RL 4 prüfen: Treppe, Geländer, Türbreite und Rampe gegen die Richtlinie, mit Maßskizze und Fundstelle und ohne geschätzte Maße.',
      heading: 'Treppe, Geländer und Barrierefreiheit nach OIB-Richtlinie 4 prüfen',
      lede: 'Ob ein Auftritt reicht oder ein Geländer hoch genug ist, sieht man in einer Zeichnung schneller als in einem Satz. Piloti liefert beides: das Urteil mit Fundstelle und die Maßskizze dazu.',
      answer:
        'Piloti prüft Treppen, Geländer, Türen und Rampen gegen die OIB-Richtlinie 4 „Nutzungssicherheit und Barrierefreiheit“ in der Ausgabe, die Ihr Bundesland verbindlich erklärt hat: Es stellt Ihr Maß der zitierten Anforderung gegenüber, zeichnet es als Skizze und führt jedes Maß, das dem Plan fehlt, als offenen Punkt.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was Piloti liefert',
          items: [
            {
              name: 'Das Urteil im Satz',
              body: 'Erfüllt, nicht erfüllt oder offen, mit der Klausel. Die Skizze kommt dazu, nie stattdessen.',
            },
            {
              name: 'Die Skizze mit dem Maß',
              body: 'Ihr Maß neben der Grenze, gezeichnet, sodass die Kollegin es nicht im Kopf neu zeichnen muss.',
            },
            {
              name: 'Eine Prüftabelle für mehrere Stellen',
              body: 'Alle Treppen oder Türen eines Geschoßes, eine Zeile je Stelle, mit Quelle und Ergebnis.',
            },
            {
              name: 'Ob ein Aufzug nötig ist',
              body: 'Als Satz mit Fundstelle; ist ein Aufzug geplant, die Kabinenmaße zusätzlich als Skizze.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Warum die Maße tückisch sind',
          body: [
            'Welches Maß eine Bestimmung meint, steht in ihrem Wortlaut. Rohbaulichte und fertige Durchgangsbreite sind verschiedene Zahlen, Geschoßhöhe und Absturzhöhe auch. Wer die eine unter dem Namen der anderen prüft, prüft sauber das Falsche.',
            'Beim Geländer entscheidet die Absturzhöhe, welche Grenze gilt, bei der Treppe die Nutzung und die Lage. Bei der Barrierefreiheit kommt dazu, dass die Richtlinie oft ein Ziel nennt: erreichbar, benutzbar. Ein Maß ist dann ein üblicher Weg dorthin, nicht selbst die Anforderung.',
            'Und wie überall bindet die Ausgabe, die das Land erklärt hat. Für welche Gebäude und Teile Barrierefreiheit überhaupt verlangt ist, ergibt sich aus Richtlinie und Landesrecht zusammen, und das unterscheidet sich von Land zu Land.',
          ],
        },
        {
          kind: 'steps',
          title: 'So arbeitet Piloti die Frage durch',
          items: [
            {
              name: 'Die Bestimmung holen',
              body: 'Piloti holt die Klausel aus der im Land verbindlichen Ausgabe der Richtlinie 4 und aus dem Landesrecht und zitiert sie, nicht nur die Zahl daraus.',
            },
            {
              name: 'Die Herkunft jedes Maßes festhalten',
              body: 'Ein Maß aus Ihrer Frage gilt als angegeben, eines aus angegebenen Werten errechnetes als errechnet, und die Antwort sagt, welches welches ist.',
            },
            {
              name: 'Zeichnen',
              body: 'Steigung, Auftritt und Laufbreite kommen in eine Treppenskizze; Absturzhöhe, Geländerhöhe und Öffnungsweite in eine Geländerskizze; lichte Breite, Rampe, Wendekreis, Bewegungsfläche oder Aufzugskabine in eine Maßskizze.',
            },
            {
              name: 'Fehlende Maße offen lassen',
              body: 'Fehlt ein Maß, steht die Prüfung als „Angabe fehlt“, mit dem, was dem Plan fehlt. Ein geschätztes Maß kommt in keine Skizze, weil die Skizze genau das ist, was ohne den Text weitergereicht wird.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Was Piloti von Ihnen braucht',
          items: [
            'Das Bundesland, die Nutzung und die Art des Gebäudes, etwa Wohnbau, Büro oder öffentlich zugänglich.',
            'Die Maße, um die es geht, aus Ihrer Frage oder aus bemaßten Grundrissen und Schnitten im Projekt.',
            'Ob es Rohbau- oder Fertigmaße sind.',
            'Ob Neubau oder Bestand.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Piloti arbeitet mit bemaßten Werten; fehlt ein Maß, fragt es danach, statt zu schätzen. Die Verantwortung für die Maßkette bleibt bei der Planung. Verweist die Richtlinie auf eine ÖNORM, nennt Piloti die Norm, und wo die Anforderung ein Ziel statt eines Maßes ist, sagt es das.',
          ],
        },
      ],
      faq: [
        {
          q: 'Wo stehen die Anforderungen an Treppen und Geländer in Österreich?',
          a: 'In der OIB-Richtlinie 4 „Nutzungssicherheit und Barrierefreiheit“, in der Ausgabe, die Ihr Bundesland verbindlich erklärt hat, ergänzt durch das Landesrecht. Die Werte hängen von Nutzung und Lage ab, beim Geländer von der Absturzhöhe. Piloti zitiert die Klausel und zeichnet Ihr Maß dagegen.',
        },
        {
          q: 'Muss mein Gebäude barrierefrei sein?',
          a: 'Das hängt von Nutzung, Größe und Bundesland ab. Welche Gebäude und Teile barrierefrei zu planen sind, ergibt sich aus der Bauordnung oder Bautechnikvorschrift des Landes zusammen mit der OIB-Richtlinie 4. Piloti nennt die Bestimmung Ihres Landes mit Fundstelle.',
        },
        {
          q: 'Kann Piloti Maße aus einem Plan ablesen?',
          a: 'Es sieht Pläne als Bild an, liest bemaßte Werte, wo die Zeichnung sie zeigt, und sagt, welche Zeichnung auf dem Blatt es gelesen hat. Unbemaßte Längen schätzt es nicht. Fehlt ein Maß, fragt Piloti danach.',
        },
        {
          q: 'Was ist der Unterschied zwischen Rohbaulichte und lichter Durchgangsbreite?',
          a: 'Die Rohbaulichte ist die Öffnung im Rohbau, die Durchgangsbreite das, was nach dem Einbau von Zarge und Türblatt frei bleibt. Welche der beiden eine Bestimmung meint, steht in ihrem Wortlaut. Piloti liefert nicht die eine unter dem Namen der anderen.',
        },
      ],
    },
    en: {
      title: 'Accessibility under OIB-RL 4: stairs, railings, doors',
      description:
        'Checking accessibility under OIB-RL 4: stairs, railings, door widths and ramps against the guideline, with a dimension sketch, a citation and no guesswork.',
      heading: 'Checking stairs, railings and accessibility under OIB guideline 4',
      lede: 'Whether a tread is deep enough or a railing high enough is quicker to see in a drawing than in a sentence. Piloti delivers both: the verdict with its citation and the dimension sketch next to it.',
      answer:
        'Piloti checks stairs, railings, doors and ramps against OIB guideline 4 “Nutzungssicherheit und Barrierefreiheit” in the edition your state has declared binding: it sets your dimension against the cited requirement, draws it as a sketch and records every dimension missing from the drawing as an open point.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What Piloti delivers',
          items: [
            {
              name: 'The verdict in a sentence',
              body: 'Met, not met or open, with the clause. The sketch comes in addition, never instead.',
            },
            {
              name: 'The sketch with the dimension',
              body: 'Your dimension next to the limit, drawn, so a colleague does not have to redraw it in her head.',
            },
            {
              name: 'A check table for several places',
              body: 'All stairs or doors of a storey, one row per place, with source and result.',
            },
            {
              name: 'Whether a lift is needed',
              body: 'As a sentence with a citation; if a lift is planned, the car dimensions as a sketch too.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Why the dimensions are treacherous',
          body: [
            'Which dimension a provision means is in its wording. The structural opening and the finished clear passage width are different numbers, and so are storey height and fall height. Check one under the name of the other and you check the wrong thing very carefully.',
            'For a railing, the fall height decides which limit applies; for a stair, the use and the position. With accessibility there is also the fact that the guideline often names a goal: reachable, usable. A dimension is then a common way to get there, not the requirement itself.',
            'And as everywhere, the edition the state has declared binds. For which buildings and parts accessibility is required at all follows from the guideline and state law together, and that differs from state to state.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti works through the question',
          items: [
            {
              name: 'Fetch the provision',
              body: 'Piloti takes the clause from the edition of guideline 4 binding in the state and from state law, and cites the clause, not just the number from it.',
            },
            {
              name: 'Record where each dimension comes from',
              body: 'A dimension from your question counts as given, one calculated from given values as calculated, and the answer says which is which.',
            },
            {
              name: 'Draw',
              body: 'Rise, going and flight width go into a stair sketch; fall height, railing height and opening width into a railing sketch; clear width, ramp, turning circle, manoeuvring space or lift car into a dimension sketch.',
            },
            {
              name: 'Leave missing dimensions open',
              body: 'If a dimension is missing, the check stands as “input missing”, with what the drawing lacks. An estimated dimension goes into no sketch, because the sketch is exactly what gets passed on without the text.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'What Piloti needs from you',
          items: [
            'The state, the use and the type of building, such as housing, office or open to the public.',
            'The dimensions in question, from your question or from dimensioned plans and sections in the project.',
            'Whether they are structural or finished dimensions.',
            'Whether it is new build or existing.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti works with dimensioned values; if a dimension is missing, it asks for it rather than estimating. Responsibility for the dimensions stays with the design team. Where the guideline refers to an ÖNORM, Piloti names the standard, and where the requirement is a goal rather than a dimension, it says so.',
          ],
        },
      ],
      faq: [
        {
          q: 'Where are the requirements for stairs and railings in Austria?',
          a: 'In OIB guideline 4 “Nutzungssicherheit und Barrierefreiheit”, in the edition your state has declared binding, supplemented by state law. The values depend on use and position, for railings on the fall height. Piloti cites the clause and draws your dimension against it.',
        },
        {
          q: 'Does my building have to be accessible?',
          a: 'That depends on use, size and state. Which buildings and parts must be designed to be accessible follows from the state’s building code or building-technology rules together with OIB guideline 4. Piloti names your state’s provision with a citation.',
        },
        {
          q: 'Can Piloti read dimensions from a drawing?',
          a: 'It looks at drawings as images, reads dimensioned values where the drawing shows them, and says which drawing on the sheet it read. It does not estimate undimensioned lengths. If a dimension is missing, Piloti asks for it.',
        },
        {
          q: 'What is the difference between the structural opening and the clear passage width?',
          a: 'The structural opening is the opening in the carcass; the passage width is what remains clear once frame and door leaf are fitted. Which of the two a provision means is in its wording. Piloti does not deliver one under the name of the other.',
        },
      ],
    },
  },
  {
    slug: 'aufenthaltsraum',
    checked: '2026-09',
    related: ['glossar/aufenthaltsraum', 'anwendungen/barrierefreiheit', 'anwendungen/bestand', 'glossar/oib-richtlinien'],
    de: {
      title: 'Aufenthaltsraum: Anforderungen nach OIB-RL 3 prüfen',
      description:
        'Aufenthaltsraum nach OIB-RL 3: Ist der Raum einer, und was gilt dann für Raumhöhe, Belichtung und Lüftung? Piloti ordnet ein, zitiert und prüft Ihre Maße.',
      heading: 'Ist das ein Aufenthaltsraum, und was verlangt die OIB-Richtlinie 3 dann?',
      lede: 'Piloti ordnet den Raum nach seiner Nutzung ein, nicht nach dem Raumstempel im Plan, und prüft dann Raumhöhe, Belichtung und Lüftung gegen die OIB-Richtlinie 3, mit Fundstelle und Skizze zum Lichteinfall.',
      answer:
        'Piloti ordnet einen Raum mit Fundstelle als Aufenthaltsraum ein, nach der Begriffsbestimmung und seiner tatsächlichen Nutzung statt nach seinem Namen im Plan, holt dann die Anforderungen der OIB-Richtlinie 3 an Raumhöhe, Belichtung und Lüftung aus der Klausel und prüft Ihre Maße dagegen.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was Piloti liefert',
          items: [
            {
              name: 'Die Einordnung mit Fundstelle',
              body: 'Aufenthaltsraum ja, nein oder offen, mit der Bestimmung und der Tatsache, auf der die Einordnung ruht.',
            },
            {
              name: 'Eine Prüftabelle',
              body: 'Raumhöhe, Belichtung und Lüftung nebeneinander, eine Zeile je Anforderung, oder je Raum, wenn eine ganze Wohnung geprüft wird.',
            },
            {
              name: 'Eine Skizze zum Lichteinfall',
              body: 'Wo die Belichtung die Frage ist, zeichnet Piloti den Lichteinfall mit dem Glasanteil des Fensters.',
            },
            {
              name: 'Die Stelle im Wortlaut',
              body: 'Der Satz der Richtlinie, an dem die Antwort hängt, steht als Zitat in der Antwort, anklickbar bis zur Quelle.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Warum die Einordnung zuerst kommt',
          body: [
            'Die OIB-Richtlinie 3 knüpft ihre Anforderungen an Raumhöhe, Belichtung und Lüftung daran, ob ein Raum ein Aufenthaltsraum ist. Das ist eine rechtliche Einordnung. „Hobbyraum“ im Plan entscheidet sie nicht, die Nutzung schon. Ein Kellerraum, in dem regelmäßig gearbeitet wird, kann einer sein; ein großzügiger Abstellraum ist es nicht.',
            'Danach kommen die Maße, und an ihnen hängen zwei typische Fehler. Die Geschoßhöhe ist nicht die lichte Raumhöhe. Und ein Lichteinfall, den ein gegenüberliegendes Gebäude beschneidet, verbietet das Fenster nicht: Er ändert die erforderliche Fensterfläche. Wer aus „beschnitten“ ein „nicht erfüllt“ macht, hat die Bestimmung übersprungen.',
            'Auch hier holen Bestand, Zubau und größere Renovierung oft andere Anforderungen als Neubau, und die Ausgabe des Landes bindet mit.',
          ],
        },
        {
          kind: 'steps',
          title: 'So arbeitet Piloti die Frage durch',
          items: [
            {
              name: 'Den Raum einordnen',
              body: 'Piloti holt die Bestimmung, die den Aufenthaltsraum definiert, und wendet sie auf die Nutzung aus Ihrer Frage oder den Projektunterlagen an. Ist die Nutzung unklar, kommt eine Frage, kein stilles Ja.',
            },
            {
              name: 'Neubau oder Bestand lesen',
              body: 'Steht im Projekt, ob es sich um Neubau oder Bestand handelt, arbeitet Piloti darunter, bevor es eine Neubau-Klausel zitiert.',
            },
            {
              name: 'Die Anforderung holen',
              body: 'Raumhöhe, Belichtung, Lüftung, Fensterfläche: Die Grenze kommt aus der Klausel, zitiert bis zum Punkt und vor dem Anzeigen gegen den Quelltext geprüft.',
            },
            {
              name: 'Das Maß zuordnen',
              body: 'Das Maß kommt aus der Frage, dem Plan oder den Unterlagen, und seine Herkunft steht im Satz. Erst die Anforderung, dann das Maß, nie umgekehrt, sonst wird das Falsche sauber geprüft.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Was Piloti von Ihnen braucht',
          items: [
            'Wofür der Raum genutzt wird, nicht nur wie er im Plan heißt.',
            'Die lichte Raumhöhe, nicht die Geschoßhöhe.',
            'Raumfläche, Fenstergröße und Glasanteil, und was dem Fenster gegenüberliegt.',
            'Das Bundesland, und ob Neubau oder Bestand.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Piloti prüft Maße gegen Klauseln; Tageslichtsimulation und Lüftungsplanung bleiben bei den Fachplanern, und fehlt ein Maß, fragt Piloti danach. Für Arbeitsräume in Betrieben zieht Piloti zusätzlich die Arbeitsstättenverordnung heran und hält die beiden Regelwerke auseinander. Einen Grenzfall, etwa einen Arbeitsplatz im Souterrain, nehmen Sie mit der Begründung ins Vorgespräch.',
          ],
        },
      ],
      faq: [
        {
          q: 'Was ist ein Aufenthaltsraum?',
          a: 'Ein Raum, der zum längeren Aufenthalt von Menschen bestimmt ist, etwa ein Wohn-, Schlaf- oder Arbeitsraum. Die maßgebliche Bestimmung steht in den OIB-Richtlinien bzw. im Landesrecht, und sie kann sich von Land zu Land im Detail unterscheiden. Entscheidend ist die Nutzung, nicht der Name im Plan.',
        },
        {
          q: 'Ist ein Kellerraum ein Aufenthaltsraum?',
          a: 'Wenn er zum längeren Aufenthalt von Menschen genutzt wird, kann er einer sein, und dann gelten die Anforderungen an Raumhöhe, Belichtung und Lüftung. Ob ein Kellerraum sie erfüllen kann, hängt oft an der Belichtung. Piloti ordnet den Raum nach seiner Nutzung ein und sagt, welche Tatsache die Einordnung trägt.',
        },
        {
          q: 'Welche Raumhöhe braucht ein Aufenthaltsraum?',
          a: 'Die Mindesthöhe steht in der OIB-Richtlinie 3 in der Ausgabe, die Ihr Bundesland erklärt hat. Gemeint ist die lichte Raumhöhe, nicht die Geschoßhöhe. Piloti zitiert den Wert mit Fundstelle und prüft Ihr Maß dagegen.',
        },
        {
          q: 'Darf ich ein Fenster planen, wenn das Nachbarhaus den Lichteinfall beschneidet?',
          a: 'Ein beschnittener Lichteinfall verbietet das Fenster nicht. Er ändert, wie groß die Fensterfläche sein muss. Piloti zeigt den Lichteinfall als Skizze und zitiert die Klausel, nach der sich die Fläche richtet.',
        },
      ],
    },
    en: {
      title: 'Habitable room: requirements under OIB-RL 3 – Piloti',
      description:
        'Habitable rooms under OIB-RL 3: is the room one, and what applies to room height, daylight and ventilation? Piloti classifies, cites and checks dimensions.',
      heading: 'Is this a habitable room, and what does OIB guideline 3 then require?',
      lede: 'Piloti classifies the room by its use, not by the label in the drawing, and then checks room height, daylight and ventilation against OIB guideline 3, with a citation and a daylight sketch.',
      answer:
        'Piloti classifies a room as a habitable room (Aufenthaltsraum) with a citation, by the definition and its actual use rather than its name in the drawing, then takes the requirements of OIB guideline 3 for room height, daylight and ventilation from the clause and checks your dimensions against them.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What Piloti delivers',
          items: [
            {
              name: 'The classification with a citation',
              body: 'Habitable room yes, no or open, with the provision and the fact the classification rests on.',
            },
            {
              name: 'A check table',
              body: 'Room height, daylight and ventilation side by side, one row per requirement, or per room when a whole flat is checked.',
            },
            {
              name: 'A daylight sketch',
              body: 'Where daylight is the question, Piloti draws the incidence of light with the glazed share of the window.',
            },
            {
              name: 'The passage in its wording',
              body: 'The sentence of the guideline the answer hangs on stands as a quote in the answer, clickable through to the source.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Why the classification comes first',
          body: [
            'OIB guideline 3 ties its requirements for room height, daylight and ventilation to whether a room is a habitable room. That is a legal classification. “Hobby room” in the drawing does not decide it; the use does. A basement room where people regularly work can be one; a generous storeroom is not.',
            'Then come the dimensions, and two typical mistakes hang on them. The storey height is not the clear room height. And daylight cut off by a building opposite does not prohibit the window: it changes the required window area. Turn “cut off” into “not met” and you have skipped the provision.',
            'Here too, existing buildings, extensions and major renovations often trigger different requirements than new build, and the state’s edition binds as well.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti works through the question',
          items: [
            {
              name: 'Classify the room',
              body: 'Piloti fetches the provision that defines a habitable room and applies it to the use from your question or the project documents. If the use is unclear, a question comes, not a silent yes.',
            },
            {
              name: 'Read new build or existing',
              body: 'If the project records whether it is new build or existing, Piloti works under that before citing a new-build clause.',
            },
            {
              name: 'Fetch the requirement',
              body: 'Room height, daylight, ventilation, window area: the limit comes from the clause, cited to the clause and checked against the source text before it is shown.',
            },
            {
              name: 'Assign the dimension',
              body: 'The dimension comes from the question, the drawing or the documents, and its origin is in the sentence. Requirement first, then dimension, never the other way round, or the wrong thing gets checked carefully.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'What Piloti needs from you',
          items: [
            'What the room is used for, not just what the drawing calls it.',
            'The clear room height, not the storey height.',
            'Room area, window size and glazed share, and what lies opposite the window.',
            'The state, and whether it is new build or existing.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti checks dimensions against clauses; daylight simulation and ventilation design stay with the specialists, and if a dimension is missing, Piloti asks for it. For workrooms in businesses, Piloti also draws on the Arbeitsstättenverordnung and keeps the two sets of rules apart. A borderline case, such as a workplace in a semi-basement, goes into the pre-application meeting with the reasoning in hand.',
          ],
        },
      ],
      faq: [
        {
          q: 'What is a habitable room?',
          a: 'A room intended for people to stay in for longer periods, such as a living room, bedroom or workroom. The governing provision is in the OIB guidelines or state law, and details can differ from state to state. What decides is the use, not the name in the drawing.',
        },
        {
          q: 'Is a basement room a habitable room?',
          a: 'If people use it for longer periods, it can be one, and then the requirements for room height, daylight and ventilation apply. Whether a basement room can meet them often depends on daylight. Piloti classifies the room by its use and says which fact the classification rests on.',
        },
        {
          q: 'What room height does a habitable room need?',
          a: 'The minimum height is in OIB guideline 3 in the edition your state has declared. It means the clear room height, not the storey height. Piloti cites the value with its source and checks your dimension against it.',
        },
        {
          q: 'May I plan a window if the neighbouring building cuts off the daylight?',
          a: 'Cut-off daylight does not prohibit the window. It changes how large the window area must be. Piloti shows the incidence of light as a sketch and cites the clause that sets the area.',
        },
      ],
    },
  },
  {
    slug: 'pruefbericht-aktenvermerk',
    checked: '2026-09',
    related: ['anwendungen/einreichcheck', 'anwendungen/bueroarchiv', 'anwendungen/brandschutz', 'vergleich/chatgpt'],
    de: {
      title: 'Prüfbericht und Aktenvermerk mit KI erstellen – Piloti',
      description:
        'Prüfbericht und Aktenvermerk mit KI erstellen: Piloti schreibt Bericht, Vermerk und Protokoll aus belegten Antworten, mit Fassungen und Freigabe.',
      heading: 'Vom Befund zum Aktenvermerk: Prüfbericht und Vermerk mit Piloti',
      lede: 'Im Büro zählt, was im Akt steht, wer es freigegeben hat und worauf es sich stützt. Piloti macht aus belegten Antworten Prüfberichte, Aktenvermerke und Protokolle, mit Fassungen und Freigabe im Eingang.',
      answer:
        'Piloti schreibt aus einer Tiefenrecherche einen Prüfbericht mit Urteil und Befundmatrix, der im Projekt unter „Berichte“ liegt, und entwirft Aktenvermerke, Protokolle, Checklisten und Flächenaufstellungen, die Sie im Gespräch überarbeiten und über die Freigabe in den Akt bringen. Die Fundstellen bleiben im Dokument, und jede Antwort lässt sich als Word herunterladen, Berichte auch als PDF.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was Piloti liefert',
          items: [
            {
              name: 'Einen Prüfbericht',
              body: 'Das Urteil zuerst, dann eine Befundmatrix: jede geprüfte Anforderung mit Quelle und Ergebnis.',
            },
            {
              name: 'Entwürfe in Büroform',
              body: 'Aktenvermerk, Protokoll, Checkliste, Flächenaufstellung, in Form und Schwerpunkt so, wie es die ständigen Anweisungen Ihres Büros festlegen.',
            },
            {
              name: 'Word zum Weiterarbeiten',
              body: 'Jede Antwort lässt sich als Word-Datei herunterladen, Berichte auch als PDF.',
            },
            {
              name: 'Abläufe als Diagramm',
              body: 'Verfahren, Übergaben und Termine zeichnet Piloti als Diagramm, wo der Vermerk sie braucht.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Warum das mehr ist als Schreibarbeit',
          body: [
            'Ein Aktenvermerk hält fest, was entschieden wurde und warum. Er ist das Erste, was jemand liest, wenn eine Frage wiederkommt: vor der Bauverhandlung, bei der Übergabe an eine neue Projektleitung, im Streit mit der Bauherrschaft. Ein Vermerk ohne Fundstelle ist dann eine Behauptung, und einen ohne Freigabe kann niemand einordnen.',
            'Deshalb schreibt Piloti Dokumente aus dem, was im Projekt belegt ist. Die Fundstellen bleiben im Dokument, die Fassungen bleiben nachvollziehbar, und was Piloti geschrieben hat, wird erst dann zur zitierbaren Quelle, wenn Ihr Büro es freigegeben und veröffentlicht hat. Bis dahin ist es ein Entwurf, und Piloti behandelt es so.',
          ],
        },
        {
          kind: 'steps',
          title: 'Vom Auftrag zum freigegebenen Dokument',
          items: [
            {
              name: 'Auftrag geben',
              body: 'Als Frage oder als Aufgabe mit Termin: „Mach den Einreichcheck bis Freitag.“ Wiederkehrendes planen Sie ein: „Prüf das jeden Montag.“ Aufgaben laufen unter Ihrem Namen und mit Ihren Rechten.',
            },
            {
              name: 'Die Tiefenrecherche planen',
              body: 'Für eine größere Frage legt Piloti zuerst einen Plan vor, den Sie ändern, bevor die Recherche beginnt.',
            },
            {
              name: 'Den Bericht ablegen',
              body: 'Der Bericht liegt im Projekt unter „Berichte“, mit Urteil und Befundmatrix, als PDF oder Word exportierbar.',
            },
            {
              name: 'Befunde weitertragen',
              body: 'Befunde werden zu Fakten oder offenen Punkten im Projektgedächtnis. „Klären“ macht aus einem offenen Punkt eine eigene Aufgabe.',
            },
            {
              name: 'Den Vermerk entwerfen',
              body: 'Piloti entwirft Aktenvermerk, Protokoll, Checkliste oder Flächenaufstellung und überarbeitet sie im Gespräch. Jede Datei hat Fassungen.',
            },
            {
              name: 'Freigeben',
              body: 'In der Inbox: Freigeben, Änderungen anfordern oder Ablehnen. Erst ein freigegebenes und veröffentlichtes Dokument zieht Piloti später als Quelle heran.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Was Piloti von Ihnen braucht',
          items: [
            'Das Projekt mit seinen Unterlagen: Pläne, Bescheide, frühere Vermerke.',
            'Was festgehalten werden soll, in einem Satz: die Entscheidung, die Frage, der Termin.',
            'Ständige Anweisungen für Form und Schwerpunkt, wenn Ihr Büro eine feste Gliederung hat.',
            'Wer im Büro freigibt.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Ein Aktenvermerk wird durch Ihre Freigabe zum Dokument Ihres Büros; Unterschrift und fachliche Verantwortung bleiben bei den Planenden. Ständige Anweisungen bestimmen Form und Schwerpunkt, die Anforderungen zitiert Piloti aus der Quelle. Fehlt für einen Vermerk eine Unterlage, sagt Piloti das.',
          ],
        },
      ],
      faq: [
        {
          q: 'Kann eine KI einen Prüfbericht erstellen?',
          a: 'Sie kann einen Bericht aus belegten Befunden zusammenstellen. Piloti legt ihn im Projekt ab, mit Urteil, Befundmatrix und Fundstellen, exportierbar als PDF oder Word. Prüfen und freigeben muss ihn eine fachkundige Person im Büro.',
        },
        {
          q: 'Wie schreibt Piloti einen Aktenvermerk automatisch?',
          a: 'Aus dem Gespräch und den Unterlagen im Projekt: Sie sagen, was festgehalten werden soll, Piloti entwirft den Vermerk mit den Fundstellen und überarbeitet ihn nach Ihren Anmerkungen. Über die Freigabe in der Inbox kommt er in den Akt.',
        },
        {
          q: 'Wird ein Dokument von Piloti automatisch zur Quelle?',
          a: 'Nein. Erst wenn Ihr Büro es freigegeben und veröffentlicht hat, zieht Piloti es in späteren Antworten als Quelle heran. Bis dahin ist es ein Entwurf mit Fassungen.',
        },
        {
          q: 'Kann ich die Form meines Büros vorgeben?',
          a: 'Ja, über ständige Anweisungen: Sie legen Form und Schwerpunkt fest, etwa Gliederung, Kopf und was immer dazugehört. Eigene Arbeitsweisen Ihres Büros legen Sie im Skill-Editor an.',
        },
      ],
    },
    en: {
      title: 'Creating inspection reports and file notes with AI',
      description:
        'Creating inspection reports and file notes with AI: Piloti drafts reports, notes and minutes from sourced answers, with versions and approval.',
      heading: 'From finding to file note: reports and notes with Piloti',
      lede: 'In an office, what counts is what is on file, who approved it and what it rests on. Piloti turns sourced answers into inspection reports, file notes and minutes, with versions and approval in the inbox.',
      answer:
        'From an in-depth research run, Piloti writes an inspection report with a verdict and a findings matrix, filed in the project under “Berichte”, and drafts file notes, minutes, checklists and area schedules that you revise in the conversation and bring onto the file through approval. The citations stay in the document, and every answer downloads as Word, reports also as PDF.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What Piloti delivers',
          items: [
            {
              name: 'An inspection report',
              body: 'The verdict first, then a findings matrix: every requirement checked, with source and result.',
            },
            {
              name: 'Drafts in your office’s form',
              body: 'File note, minutes, checklist, area schedule, in the form and focus your office’s standing instructions set.',
            },
            {
              name: 'Word to keep working in',
              body: 'Every answer can be downloaded as a Word file, reports also as PDF.',
            },
            {
              name: 'Sequences as diagrams',
              body: 'Piloti draws procedures, handovers and schedules as diagrams where the note needs them.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Why this is more than paperwork',
          body: [
            'A file note records what was decided and why. It is the first thing someone reads when a question comes back: before the site hearing, when a new project lead takes over, in a dispute with the client. A note without a source is then an assertion, and one without approval nobody can place.',
            'That is why Piloti writes documents from what is backed by sources in the project. The citations stay in the document, the versions stay traceable, and what Piloti wrote becomes a citable source only once your office has approved and published it. Until then it is a draft, and Piloti treats it as one.',
          ],
        },
        {
          kind: 'steps',
          title: 'From brief to approved document',
          items: [
            {
              name: 'Give the brief',
              body: 'As a question or as a task with a deadline: “Mach den Einreichcheck bis Freitag.” Recurring work you schedule: “Prüf das jeden Montag.” Tasks run under your name and with your permissions.',
            },
            {
              name: 'Plan the in-depth research',
              body: 'For a larger question, Piloti first proposes a plan, which you change before the research starts.',
            },
            {
              name: 'File the report',
              body: 'The report is filed in the project under “Berichte”, with a verdict and a findings matrix, exportable as PDF or Word.',
            },
            {
              name: 'Carry the findings forward',
              body: 'Findings become facts or open points in the project memory. “Klären” turns an open point into its own task.',
            },
            {
              name: 'Draft the note',
              body: 'Piloti drafts a file note, minutes, a checklist or an area schedule and revises it in the conversation. Every file has versions.',
            },
            {
              name: 'Approve',
              body: 'In the inbox: approve, request changes or reject. Only an approved and published document is later drawn on by Piloti as a source.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'What Piloti needs from you',
          items: [
            'The project with its documents: drawings, permits, earlier notes.',
            'What should be recorded, in one sentence: the decision, the question, the date.',
            'Standing instructions for form and focus, if your office has a fixed structure.',
            'Who approves in the office.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'A file note becomes a document of your office through your approval; signature and professional responsibility stay with the designers. Standing instructions set form and focus, and Piloti cites the requirements from the source. If a document needed for a note is missing, Piloti says so.',
          ],
        },
      ],
      faq: [
        {
          q: 'Can AI create an inspection report?',
          a: 'It can compile a report from findings backed by sources. Piloti files it in the project, with verdict, findings matrix and citations, exportable as PDF or Word. A qualified person in the office has to check and approve it.',
        },
        {
          q: 'How does Piloti write a file note automatically?',
          a: 'From the conversation and the documents in the project: you say what should be recorded, Piloti drafts the note with its citations and revises it after your comments. Through approval in the inbox it goes onto the file.',
        },
        {
          q: 'Does a document from Piloti automatically become a source?',
          a: 'No. Only once your office has approved and published it does Piloti draw on it as a source in later answers. Until then it is a draft with versions.',
        },
        {
          q: 'Can I set my office’s format?',
          a: 'Yes, through standing instructions: you set form and focus, such as structure, header and what always belongs in it. Your office’s own ways of working are created in the skill editor.',
        },
      ],
    },
  },
  {
    slug: 'bueroarchiv',
    checked: '2026-09',
    related: ['anwendungen/pruefbericht-aktenvermerk', 'anwendungen/einreichcheck', 'fuer/architekturbueros', 'vergleich/chatgpt'],
    de: {
      title: 'Wissensmanagement im Architekturbüro: Büroarchiv mit KI',
      description:
        'Wissensmanagement im Architekturbüro: das Büroarchiv mit KI durchsuchen, mit Fundstelle aus eigenen Projekten und für kein anderes Büro sichtbar.',
      heading: 'Das Büroarchiv befragen: Wissensmanagement im Architekturbüro',
      lede: 'Das Wissen eines Büros steckt in alten Projekten, Bescheiden und Vermerken. Piloti macht dieses Archiv befragbar: Sie fragen wie eine Kollegin und bekommen Dokument und Stelle, getrennt von dem, was das Gesetz verlangt.',
      answer:
        'Piloti durchsucht das Büroarchiv, das Sie hochladen, also Pläne, Bescheide, Vermerke und Checklisten, und beantwortet Fragen daraus mit Fundstelle, getrennt von dem, was Gesetz und OIB-Richtlinien verlangen. Das Archiv sieht kein anderes Büro, und mit den Daten des Büros werden keine Modelle trainiert.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was Piloti liefert',
          items: [
            {
              name: 'Antworten mit Dokument und Stelle',
              body: 'Jede Fundstelle aus dem Archiv lässt sich öffnen, so wie eine Fundstelle aus dem RIS.',
            },
            {
              name: 'Büro und Gesetz getrennt',
              body: 'Die Antwort sagt, was aus Ihrem Archiv kommt und was aus Landesrecht und OIB-Richtlinien.',
            },
            {
              name: 'Ein Projektgedächtnis',
              body: 'Geklärte Fakten und offene Punkte bleiben im Projekt, damit niemand dieselbe Frage zweimal klärt.',
            },
            {
              name: 'Daten, die Ihnen gehören',
              body: 'Kein Training von Modellen mit Büro-Daten; Pläne bleiben Eigentum des Büros; auf Wunsch mit eigenem Schlüssel für den Modellanbieter.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Warum Büroarchive selten gefragt werden',
          body: [
            'Jedes Büro hat einen Vorrat an Antworten: wie die Behörde bei einem ähnlichen Dachausbau entschieden hat, welche Auflage im letzten Bescheid stand, welche Checkliste nach einer schlechten Erfahrung eingeführt wurde. Der Vorrat liegt verteilt auf Laufwerke und Ordner, und wer ihn braucht, fragt die Kollegin, die sich erinnert. Ist sie im Urlaub oder in Pension, ist die Antwort auch weg.',
            'Das Problem ist nicht nur die Suche. Eine Antwort aus dem Archiv ist eine andere Art Beleg als eine aus dem Gesetz: Sie zeigt, was dieses Büro getan hat, nicht was gilt. Werden beide vermischt, wird aus einer alten Gewohnheit eine vermeintliche Vorschrift, und aus einer überholten Vorschrift eine Gewohnheit, die niemand mehr prüft.',
          ],
        },
        {
          kind: 'steps',
          title: 'So wird das Archiv befragbar',
          items: [
            {
              name: 'Hochladen',
              body: 'PDF, Word, Excel, PowerPoint, CSV, Bilder oder ganze Ordner; IFC-Modelle mit Vorschau. Das Archiv ist für kein anderes Büro sichtbar.',
            },
            {
              name: 'Fragen',
              body: 'Im Gespräch, so wie Sie eine Kollegin fragen würden: „Wie haben wir den zweiten Fluchtweg beim Dachausbau in der Leopoldstadt gelöst?“',
            },
            {
              name: 'Belegt antworten',
              body: 'Die Antwort nennt Dokument und Stelle, getrennt von den Fundstellen aus Gesetz und Richtlinie. Was die Behörde fordert und was das Büro fordert, steht auseinander.',
            },
            {
              name: 'Das Archiv wachsen lassen',
              body: 'Was Piloti im Projekt schreibt, wird zur Quelle, sobald Ihr Büro es freigibt und veröffentlicht. Eine als nicht hilfreich markierte Antwort wird zu einer anonymisierten Lektion, die spätere Antworten lesen.',
            },
            {
              name: 'Eigene Arbeitsweisen festhalten',
              body: 'Im Skill-Editor legen Sie Arbeitsweisen Ihres Büros an; mit ständigen Anweisungen bestimmen Sie Form und Schwerpunkt der Antworten.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Was Piloti von Ihnen braucht',
          items: [
            'Die Dokumente, die befragbar werden sollen: abgeschlossene Projekte, Bescheide, Vermerke, Büro-Checklisten, Detailsammlungen.',
            'Eine Entscheidung, welche von Piloti geschriebenen Dokumente als Büroquelle gelten sollen, über Freigabe und Veröffentlichung.',
            'Wer im Büro freigibt.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Piloti antwortet aus dem, was Ihr Büro hochgeladen hat; was bisher nur in einem Kopf steckt, lohnt sich deshalb als Vermerk. Einen älteren Vermerk zitiert Piloti als Büroquelle, nicht als geltendes Recht, damit Ihr Büro sieht, was woher kommt. Wie Ihre Daten verarbeitet werden, steht in der Datenschutzerklärung.',
          ],
        },
      ],
      faq: [
        {
          q: 'Wie organisiert ein Architekturbüro sein Wissen?',
          a: 'Meist in Ordnern, Vorlagen und den Köpfen der Erfahrenen. Ein Werkzeug wie Piloti macht die Ordner befragbar: Man stellt eine Frage und bekommt die Stelle im eigenen Archiv, getrennt von dem, was das Gesetz verlangt.',
        },
        {
          q: 'Sieht ein anderes Büro meine Dokumente?',
          a: 'Nein. Das Büroarchiv ist für kein anderes Büro sichtbar, und Piloti trainiert keine Modelle mit den Daten Ihres Büros. Pläne bleiben Eigentum des Büros.',
        },
        {
          q: 'Welche Dateien kann ich ins Büroarchiv laden?',
          a: 'PDF, Word, Excel, PowerPoint, CSV und Bilder, einzeln oder als ganze Ordner. IFC-Modelle zeigt Piloti in einer Vorschau mit Modellbereich. Pläne und Fotos sieht Piloti als Bild an, wenn die Zeichnung für die Antwort zählt.',
        },
        {
          q: 'Ist Piloti schon verfügbar?',
          a: 'Piloti ist in der Pilotphase mit ausgewählten Büros, entwickelt in Wien. Pilotbüros vereinbaren die Bedingungen direkt mit uns Gründern. Wer es ausprobieren will, schickt uns über „Mit einer echten Frage testen“ eine Frage aus einem laufenden Projekt.',
        },
      ],
    },
    en: {
      title: 'Knowledge management for architects: the office archive',
      description:
        'Knowledge management for architecture offices: search your office archive with AI, with citations from your own projects, visible to no other office.',
      heading: 'Asking the office archive: knowledge management in an architecture office',
      lede: 'An office’s knowledge sits in old projects, permits and notes. Piloti makes that archive answerable: you ask as you would a colleague and get document and passage, kept apart from what the law requires.',
      answer:
        'Piloti searches the office archive you upload, meaning drawings, permits, notes and checklists, and answers questions from it with citations, kept apart from what the law and the OIB guidelines require. No other office sees the archive, and no models are trained on the office’s data.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What Piloti delivers',
          items: [
            {
              name: 'Answers with document and passage',
              body: 'Every citation from the archive can be opened, just like a citation from RIS.',
            },
            {
              name: 'Office and law kept apart',
              body: 'The answer says what comes from your archive and what from state law and the OIB guidelines.',
            },
            {
              name: 'A project memory',
              body: 'Settled facts and open points stay in the project, so nobody settles the same question twice.',
            },
            {
              name: 'Data that stays yours',
              body: 'No model training on office data; drawings remain the office’s property; optionally with your own key for the model provider.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Why office archives are rarely asked',
          body: [
            'Every office has a stock of answers: how the authority decided on a similar attic conversion, which condition was in the last permit, which checklist was introduced after a bad experience. The stock is spread across drives and folders, and whoever needs it asks the colleague who remembers. If she is on holiday or retired, the answer is gone too.',
            'The problem is not only the search. An answer from the archive is a different kind of evidence than one from the law: it shows what this office did, not what applies. Mix the two and an old habit turns into a supposed rule, and an outdated rule into a habit nobody checks any more.',
          ],
        },
        {
          kind: 'steps',
          title: 'How the archive becomes answerable',
          items: [
            {
              name: 'Upload',
              body: 'PDF, Word, Excel, PowerPoint, CSV, images or whole folders; IFC models with a preview. The archive is visible to no other office.',
            },
            {
              name: 'Ask',
              body: 'In conversation, the way you would ask a colleague: “How did we solve the second escape route in the Leopoldstadt attic conversion?”',
            },
            {
              name: 'Answer with sources',
              body: 'The answer names document and passage, kept apart from citations from law and guidelines. What the authority requires and what the office requires stand apart.',
            },
            {
              name: 'Let the archive grow',
              body: 'What Piloti writes in the project becomes a source once your office approves and publishes it. An answer marked unhelpful becomes an anonymised lesson that later answers read.',
            },
            {
              name: 'Record your own ways of working',
              body: 'In the skill editor you create your office’s own ways of working; standing instructions set the form and focus of answers.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'What Piloti needs from you',
          items: [
            'The documents that should become answerable: finished projects, permits, notes, office checklists, detail collections.',
            'A decision on which documents written by Piloti should count as office sources, through approval and publishing.',
            'Who approves in the office.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti answers from what your office has uploaded, so what so far lives only in someone’s head is worth a file note. Piloti cites an older note as an office source, not as law in force, so your office sees what comes from where. How your data is processed is set out in the privacy policy.',
          ],
        },
      ],
      faq: [
        {
          q: 'How does an architecture office organise its knowledge?',
          a: 'Mostly in folders, templates and the heads of the experienced. A tool like Piloti makes the folders answerable: you ask a question and get the passage in your own archive, kept apart from what the law requires.',
        },
        {
          q: 'Can another office see my documents?',
          a: 'No. The office archive is visible to no other office, and Piloti does not train models on your office’s data. Drawings remain the office’s property.',
        },
        {
          q: 'Which files can I upload to the office archive?',
          a: 'PDF, Word, Excel, PowerPoint, CSV and images, individually or as whole folders. Piloti shows IFC models in a preview with a model area. It looks at drawings and photos as images when the drawing matters for the answer.',
        },
        {
          q: 'Is Piloti available yet?',
          a: 'Piloti is in its pilot phase with selected offices, built in Vienna. Pilot offices agree terms directly with us founders. If you want to try it, send us a question from a live project through “Try it with a real question”.',
        },
      ],
    },
  },
]
