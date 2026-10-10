/**
 * The glossary: the terms most requirements in Austrian building law hinge
 * on. A `definition` block quotes its source verbatim (the English page gives
 * an own translation and says so); a term without a verified verbatim
 * definition is explained in our own words, with the law or guideline that
 * governs it, and gets no `definition` block.
 */
import type { LandingEntry } from '../../lib/landing'

const OIB_DEFS = 'OIB-Richtlinien, Begriffsbestimmungen, Ausgabe Mai 2023'
const OIB_DEFS_EN = 'Own translation of “OIB-Richtlinien, Begriffsbestimmungen, Ausgabe Mai 2023”'
const OIB_URL = 'https://www.oib.or.at/'

export const glossar: LandingEntry[] = [
  {
    slug: 'gebaeudeklasse',
    checked: '2026-09',
    term: 'Gebäudeklasse',
    related: ['anwendungen/gebaeudeklasse', 'glossar/fluchtniveau', 'glossar/oberirdisches-geschoss', 'anwendungen/brandschutz', 'baurecht/wien'],
    de: {
      title: 'Gebäudeklasse Österreich: GK 1 bis 5 nach OIB erklärt',
      description:
        'Was ist Gebäudeklasse 4? Die Gebäudeklassen GK 1 bis 5 nach OIB: Fluchtniveau, Geschoße, Fläche, Nutzung – und warum das keine Bauklasse ist.',
      heading: 'Was ist eine Gebäudeklasse?',
      lede: 'Fast jede Brandschutzfrage beginnt mit derselben Gegenfrage: Welche Gebäudeklasse? Hier die fünf Klassen nach den OIB-Richtlinien, was sie bestimmt und wo sie gern mit der Bauklasse verwechselt wird. Piloti stuft sie für Ihr Projekt ein, mit Fundstelle in den Begriffsbestimmungen.',
      note: 'Definitionen laut OIB-Richtlinien, Begriffsbestimmungen, Ausgabe Mai 2023.',
      answer:
        'Die Gebäudeklasse (GK 1 bis 5) ordnet ein Gebäude nach den OIB-Richtlinien anhand von Fluchtniveau, Zahl der oberirdischen Geschoße, Fläche und Zahl der Wohnungen oder Betriebseinheiten ein; an ihr hängen vor allem die Brandschutzanforderungen der OIB-Richtlinie 2. Piloti stuft sie aus diesen Werten ein, mit Fundstelle, und hält sie getrennt von der Bauklasse einer Bauordnung.',
      blocks: [
        {
          kind: 'definition',
          term: 'Gebäudeklasse 4 (GK4)',
          text: '„a) Gebäude mit nicht mehr als vier oberirdischen Geschoßen und mit einem Fluchtniveau von nicht mehr als 11 m, bestehend aus mehreren Wohnungen bzw. mehreren Betriebseinheiten von jeweils nicht mehr als 400 m² Nutzfläche der einzelnen Wohnungen bzw. Betriebseinheiten in den oberirdischen Geschoßen, b) Gebäude mit nicht mehr als vier oberirdischen Geschoßen und mit einem Fluchtniveau von nicht mehr als 11 m, bestehend aus einer Wohnung bzw. einer Betriebseinheit ohne Begrenzung der Brutto-Grundfläche der oberirdischen Geschoße.“',
          source: OIB_DEFS,
          sourceUrl: OIB_URL,
        },
        {
          kind: 'list',
          title: 'Wie Piloti die Gebäudeklasse einstuft',
          items: [
            'Aus Fluchtniveau, oberirdischen Geschoßen, Fläche und Nutzung, mit der Fundstelle in den Begriffsbestimmungen und dem Bundesland des Projekts.',
            'Steht im Projekt schon eine bestätigte Gebäudeklasse, übernimmt Piloti sie. Fehlt ein entscheidender Wert, fragt es genau danach oder nennt die Annahme, mit der es rechnet.',
            'Es sagt, welche OIB-Ausgabe im Bundesland gilt, wenn das die Einstufung verändert, und beantwortet Folgefragen wie „und in GK 4?“ aus dem, was es schon gelesen hat.',
          ],
        },
        {
          kind: 'pairs',
          title: 'Die fünf Gebäudeklassen in Kürze',
          body: 'Sinngemäß nach den Begriffsbestimmungen. Im Zweifel entscheidet der Wortlaut, nicht diese Zusammenfassung.',
          items: [
            {
              name: 'GK 1',
              body: 'Freistehend, an mindestens drei Seiten auf eigenem Grund oder von Verkehrsflächen für die Feuerwehr zugänglich. Höchstens drei oberirdische Geschoße, Fluchtniveau höchstens 7,00 m, insgesamt höchstens 400 m² Brutto-Grundfläche der oberirdischen Geschoße, höchstens zwei Wohnungen oder eine Betriebseinheit.',
            },
            {
              name: 'GK 2',
              body: 'Höchstens drei oberirdische Geschoße und Fluchtniveau höchstens 7,00 m, und dazu entweder insgesamt höchstens 400 m² Brutto-Grundfläche, oder ein Reihenhaus mit Einheiten von je höchstens 400 m², oder ein freistehendes, von drei Seiten zugängliches reines Wohngebäude mit insgesamt höchstens 800 m².',
            },
            {
              name: 'GK 3',
              body: 'Höchstens drei oberirdische Geschoße und Fluchtniveau höchstens 7,00 m, soweit das Gebäude nicht in GK 1 oder GK 2 fällt.',
            },
            {
              name: 'GK 4',
              body: 'Höchstens vier oberirdische Geschoße und Fluchtniveau höchstens 11 m, mit mehreren Wohnungen oder Betriebseinheiten von je höchstens 400 m² Nutzfläche, oder mit einer einzigen Wohnung oder Betriebseinheit ohne Flächengrenze.',
            },
            {
              name: 'GK 5',
              body: 'Fluchtniveau höchstens 22 m, soweit das Gebäude nicht in GK 1 bis 4 fällt. Ein höheres Gebäude fällt in keine der fünf Klassen; dafür stellen die OIB-Richtlinien eigene, strengere Anforderungen.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Gebäudeklasse ist nicht Bauklasse',
          body: [
            'Die Bauklasse ist ein Begriff des Bebauungsrechts, etwa der Bauordnung für Wien: Sie steht im Bebauungsplan und regelt, wie hoch auf einem Grundstück gebaut werden darf. Die Gebäudeklasse kommt aus den OIB-Richtlinien und beschreibt das fertige Gebäude, damit die technischen Anforderungen, allen voran der Brandschutz, dazu passen.',
            'Beide Werte stehen nebeneinander und leiten sich nicht auseinander ab. Wer im Gespräch „Klasse 4“ sagt, sollte dazusagen, welche gemeint ist.',
          ],
        },
        {
          kind: 'text',
          title: 'Was an der Gebäudeklasse hängt',
          body: [
            'Die OIB-Richtlinie 2 staffelt ihre Anforderungen nach Gebäudeklassen: Feuerwiderstand der tragenden Bauteile, Brandabschnitte, Fluchtwege, Fassaden. Eine falsche Einstufung zieht sich deshalb durch die ganze Brandschutzplanung.',
            'Welche Ausgabe der OIB-Richtlinien gilt, entscheidet das Bundesland. Laut OIB-Übersicht sind die Richtlinien 2023 nicht in allen Ländern verbindlich erklärt; wo nicht, gilt in der Regel noch die Ausgabe 2019. Prüfen Sie im Zweifel die Bautechnikvorschrift Ihres Landes, denn die Länder können Ausnahmen und Übergangsregeln festlegen.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Die Einstufung bleibt Ihre Entscheidung als Planverfasser:in; Piloti legt dafür Definition, Fundstelle und Annahmen offen. Das Fluchtniveau nimmt es aus Ihren Unterlagen, und fehlt ein entscheidender Wert, fragt es danach.',
          ],
        },
      ],
      faq: [
        {
          q: 'Was ist Gebäudeklasse 4?',
          a: 'Gebäudeklasse 4 umfasst Gebäude mit höchstens vier oberirdischen Geschoßen und einem Fluchtniveau von höchstens 11 m. Entweder bestehen sie aus mehreren Wohnungen oder Betriebseinheiten mit je höchstens 400 m² Nutzfläche, oder aus einer einzigen Wohnung oder Betriebseinheit ohne Flächengrenze. So steht es in den OIB-Begriffsbestimmungen, Ausgabe Mai 2023.',
        },
        {
          q: 'Wie bestimmt man die Gebäudeklasse in Österreich?',
          a: 'Man ermittelt Fluchtniveau, Zahl der oberirdischen Geschoße, Brutto-Grundfläche bzw. Nutzfläche und die Zahl der Wohnungen oder Betriebseinheiten und prüft die Klassen der Reihe nach, von GK 1 aufwärts. Maßgeblich ist die OIB-Ausgabe, die im Bundesland des Projekts gilt.',
        },
        {
          q: 'Ist Gebäudeklasse dasselbe wie Bauklasse?',
          a: 'Nein. Die Bauklasse steht im Bebauungsplan und regelt nach der Bauordnung, etwa in Wien, die zulässige Gebäudehöhe. Die Gebäudeklasse kommt aus den OIB-Richtlinien und bestimmt vor allem die Brandschutzanforderungen. Ein Gebäude hat beide Werte, unabhängig voneinander.',
        },
        {
          q: 'In welche Gebäudeklasse fällt ein Reihenhaus?',
          a: 'Reihenhäuser mit höchstens drei oberirdischen Geschoßen, einem Fluchtniveau von höchstens 7,00 m und Einheiten von je höchstens 400 m² Brutto-Grundfläche nennt die Definition der GK 2 ausdrücklich. Das Fluchtniveau wird dabei für jede Einheit gesondert betrachtet.',
        },
      ],
    },
    en: {
      title: 'Building class in Austria: GK 1 to 5 under OIB explained',
      description:
        'What is building class 4? Austria’s building classes GK 1 to 5 under OIB: escape level, storeys, floor area, use – and why it is not a Bauklasse.',
      heading: 'What is a building class?',
      lede: 'Almost every fire safety question starts with the same counter-question: which building class? Here are the five classes under the OIB guidelines, what determines them, and where they get confused with the Bauklasse. Piloti classifies your project, citing the definitions.',
      note: 'Definitions from the OIB-Richtlinien, Begriffsbestimmungen, May 2023 edition, in our own translation.',
      answer:
        'The building class (Gebäudeklasse, GK 1 to 5) classifies a building under the OIB guidelines by escape level, number of above-ground storeys, floor area and number of dwellings or business units; above all, the fire safety requirements of OIB guideline 2 depend on it. Piloti classifies it from these values, with the citation, and keeps it apart from the Bauklasse of a building code.',
      blocks: [
        {
          kind: 'definition',
          term: 'Building class 4 (GK4)',
          text: '“a) Buildings with no more than four above-ground storeys and an escape level of no more than 11 m, consisting of several dwellings or several business units, each with no more than 400 m² usable floor area of the individual dwellings or business units in the above-ground storeys, b) buildings with no more than four above-ground storeys and an escape level of no more than 11 m, consisting of one dwelling or one business unit without a limit on the gross floor area of the above-ground storeys.”',
          source: OIB_DEFS_EN,
          sourceUrl: OIB_URL,
        },
        {
          kind: 'list',
          title: 'How Piloti classifies a building',
          items: [
            'From escape level, above-ground storeys, floor area and use, citing the definitions and the project’s state.',
            'If the project already holds a confirmed building class, Piloti takes it. If a deciding value is missing, it asks for exactly that or states the assumption it works with.',
            'It says which OIB edition applies in the state when that changes the class, and answers follow-ups such as “and in GK 4?” from what it has already read.',
          ],
        },
        {
          kind: 'pairs',
          title: 'The five building classes in brief',
          body: 'Paraphrased from the definitions. Where in doubt, the wording decides, not this summary.',
          items: [
            {
              name: 'GK 1',
              body: 'Detached, accessible for firefighting on at least three sides from its own land or from traffic areas. No more than three above-ground storeys, escape level no more than 7.00 m, no more than 400 m² gross floor area of the above-ground storeys in total, no more than two dwellings or one business unit.',
            },
            {
              name: 'GK 2',
              body: 'No more than three above-ground storeys and escape level no more than 7.00 m, and in addition either no more than 400 m² gross floor area in total, or a row house with units of no more than 400 m² each, or a detached, purely residential building accessible from three sides with no more than 800 m² in total.',
            },
            {
              name: 'GK 3',
              body: 'No more than three above-ground storeys and escape level no more than 7.00 m, where the building does not fall into GK 1 or GK 2.',
            },
            {
              name: 'GK 4',
              body: 'No more than four above-ground storeys and escape level no more than 11 m, with several dwellings or business units of no more than 400 m² usable floor area each, or with a single dwelling or business unit without an area limit.',
            },
            {
              name: 'GK 5',
              body: 'Escape level no more than 22 m, where the building does not fall into GK 1 to 4. A taller building falls into none of the five classes; the OIB guidelines set their own, stricter requirements for it.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Building class is not Bauklasse',
          body: [
            'The Bauklasse is a term of plot development law, for example in Vienna’s building code: it is set in the zoning and development plan and governs how high one may build on a plot. The building class comes from the OIB guidelines and describes the finished building, so that the technical requirements, fire safety above all, fit it.',
            'The two values sit side by side and are not derived from each other. Anyone who says “class 4” in a meeting should say which one they mean.',
          ],
        },
        {
          kind: 'text',
          title: 'What depends on the building class',
          body: [
            'OIB guideline 2 grades its requirements by building class: fire resistance of load-bearing elements, fire compartments, escape routes, facades. A wrong classification therefore runs through the whole fire safety design.',
            'Which edition of the OIB guidelines applies is decided by the state. According to the OIB overview, the 2023 guidelines have not been declared binding in every state; where they have not, the 2019 edition generally still applies. When in doubt, check your state’s building-technology rules, because states can set exceptions and transition rules.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'The classification remains your decision as the responsible planner; Piloti lays out the definition, citation and assumptions for it. It takes the escape level from your documents, and if a deciding value is missing, it asks for it.',
          ],
        },
      ],
      faq: [
        {
          q: 'What is building class 4?',
          a: 'Building class 4 covers buildings with no more than four above-ground storeys and an escape level of no more than 11 m. They consist either of several dwellings or business units of no more than 400 m² usable floor area each, or of a single dwelling or business unit without an area limit. That is how the OIB definitions, May 2023 edition, put it.',
        },
        {
          q: 'How is the building class determined in Austria?',
          a: 'You establish the escape level, the number of above-ground storeys, the gross or usable floor area and the number of dwellings or business units, then check the classes in order, from GK 1 upwards. The OIB edition that applies in the project’s state is the one that counts.',
        },
        {
          q: 'Is building class the same as Bauklasse?',
          a: 'No. The Bauklasse is set in the development plan and, under the building code, for example in Vienna, governs the permitted building height. The building class comes from the OIB guidelines and mainly determines fire safety requirements. A building has both values, independently of each other.',
        },
        {
          q: 'Which building class is a row house?',
          a: 'The GK 2 definition expressly names row houses with no more than three above-ground storeys, an escape level of no more than 7.00 m and units of no more than 400 m² gross floor area each. The escape level is considered separately for each unit.',
        },
      ],
    },
  },
  {
    slug: 'fluchtniveau',
    checked: '2026-09',
    term: 'Fluchtniveau',
    related: ['glossar/gebaeudeklasse', 'glossar/oberirdisches-geschoss', 'glossar/reihenhaus', 'anwendungen/gebaeudeklasse'],
    de: {
      title: 'Fluchtniveau Definition: so misst man es nach OIB',
      description:
        'Fluchtniveau Definition nach OIB-Begriffsbestimmungen: welcher Fußboden, welches Gelände, welches Mittel – und welche Schwellen die Gebäudeklasse setzen.',
      heading: 'Was ist das Fluchtniveau?',
      lede: 'Das Fluchtniveau entscheidet über die Gebäudeklasse, und die Gebäudeklasse über den Brandschutz. Drei Wörter in der Definition machen den Unterschied: höchstgelegen, oberirdisch, nach Fertigstellung. Piloti stuft daraus die Gebäudeklasse ein und fragt nach dem Wert, wenn er im Projekt fehlt.',
      note: 'Definition laut OIB-Richtlinien, Begriffsbestimmungen, Ausgabe Mai 2023.',
      answer:
        'Das Fluchtniveau ist nach den OIB-Begriffsbestimmungen die Höhendifferenz zwischen der Fußbodenoberkante des höchstgelegenen oberirdischen Geschoßes und der an das Gebäude angrenzenden Geländeoberfläche nach Fertigstellung, im Mittel. Aus ihm und den übrigen Größen stuft Piloti die Gebäudeklasse ein.',
      blocks: [
        {
          kind: 'definition',
          term: 'Fluchtniveau',
          text: '„Höhendifferenz zwischen der Fußbodenoberkante des höchstgelegenen oberirdischen Geschoßes und der an das Gebäude angrenzenden Geländeoberfläche nach Fertigstellung im Mittel.“',
          source: OIB_DEFS,
          sourceUrl: OIB_URL,
        },
        {
          kind: 'text',
          title: 'Wie Piloti dabei hilft',
          body: [
            'Piloti stuft die Gebäudeklasse aus dem Fluchtniveau und den übrigen Werten ein, mit der Fundstelle in den Begriffsbestimmungen und der OIB-Ausgabe, die im Bundesland gilt. Fehlt das Fluchtniveau, fragt es danach, statt es zu schätzen.',
          ],
        },
        {
          kind: 'text',
          title: 'Was die Definition genau sagt',
          body: [
            'Gemessen wird bis zur Fußbodenoberkante, nicht bis zur Traufe oder zum First. Das Fluchtniveau ist also keine Gebäudehöhe, sondern die Höhe, aus der sich Menschen im obersten Geschoß retten müssen und bis zu der die Feuerwehr kommen muss.',
            'Oben zählt das höchstgelegene oberirdische Geschoß. Was ein oberirdisches Geschoß ist, regelt eine eigene Definition: Ein nicht ausgebauter Dachraum oder ein Technikgeschoß ohne Wohnungen und Betriebseinheiten zählt nicht mit. Unten zählt das angrenzende Gelände nach Fertigstellung, nicht das Urgelände und nicht die Straße.',
            'Das „im Mittel“ gleicht ein ungleich hohes Gelände rund um das Gebäude aus. Wie das Mittel im Einzelfall gebildet wird, etwa am steilen Hang oder bei einer Rampe zur Tiefgarage, ist eine Auslegungsfrage. Halten Sie Ihre Annahme im Akt fest.',
          ],
        },
        {
          kind: 'list',
          title: 'Die Schwellen für die Gebäudeklasse',
          items: [
            '7,00 m: Bis hierher reichen, zusammen mit höchstens drei oberirdischen Geschoßen, die Gebäudeklassen 1 bis 3.',
            '11 m: Die Grenze der Gebäudeklasse 4, mit höchstens vier oberirdischen Geschoßen.',
            '22 m: Die Grenze der Gebäudeklasse 5. Darüber fällt ein Gebäude in keine der fünf Klassen, und es gelten eigene Anforderungen.',
            'Beim Reihenhaus wird das Fluchtniveau für jede Wohnung oder Betriebseinheit gesondert betrachtet.',
          ],
        },
        {
          kind: 'text',
          title: 'Wo es in der Praxis kippt',
          body: [
            'Ein Dachgeschoß wird ausgebaut und damit zum oberirdischen Geschoß: Das Fluchtniveau springt um ein Geschoß nach oben, und mit ihm womöglich die Gebäudeklasse. Im Bestand ist das die häufigste Überraschung.',
            'Das Gelände wird bei der Außenanlage abgesenkt oder angeschüttet: Maßgeblich ist der Zustand nach Fertigstellung, also das, was im Einreichplan als künftiges Gelände steht. Wer mit Bestandshöhen rechnet, rechnet mit dem falschen Wert.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Wie das Mittel im Einzelfall gebildet wird, entscheidet die Planung; Piloti zeigt, was die Definition sagt, und legt die Annahme offen. Das Fluchtniveau nimmt es aus Ihren Unterlagen, statt es aus Höhenkoten in der Zeichnung nachzurechnen.',
          ],
        },
      ],
      faq: [
        {
          q: 'Wie berechnet man das Fluchtniveau?',
          a: 'Man nimmt die Fußbodenoberkante des höchstgelegenen oberirdischen Geschoßes und zieht die Höhe der angrenzenden Geländeoberfläche nach Fertigstellung ab, im Mittel über den Umfang des Gebäudes. Wie das Mittel bei stark wechselndem Gelände gebildet wird, ist im Einzelfall auszulegen und im Akt festzuhalten.',
        },
        {
          q: 'Ist das Fluchtniveau dasselbe wie die Gebäudehöhe?',
          a: 'Nein. Das Fluchtniveau endet an der Fußbodenoberkante des obersten oberirdischen Geschoßes und kommt aus den OIB-Richtlinien. Gebäudehöhe, Traufhöhe oder Bauklasse regeln die Bauordnung und der Bebauungsplan des Landes, nach eigenen Messregeln.',
        },
        {
          q: 'Zählt ein Dachgeschoß beim Fluchtniveau mit?',
          a: 'Nur wenn es ein oberirdisches Geschoß ist, also Wohnungen, Betriebseinheiten oder Teile davon enthält. Ein nicht ausgebauter Dachraum zählt laut Definition nicht; ein ausgebautes Dachgeschoß mit Wohnräumen schon.',
        },
        {
          q: 'Wie wird das Fluchtniveau beim Reihenhaus bestimmt?',
          a: 'Laut Definition des Reihenhauses wird für die Einstufung in eine Gebäudeklasse jede Wohnung oder Betriebseinheit hinsichtlich des Fluchtniveaus gesondert betrachtet. Am Hang kann das für die einzelnen Häuser einer Reihe zu unterschiedlichen Werten führen.',
        },
      ],
    },
    en: {
      title: 'Escape level (Fluchtniveau): the OIB definition explained',
      description:
        'Escape level (Fluchtniveau) as defined by the OIB: which floor, which ground, which average – and the thresholds that decide the building class in Austria.',
      heading: 'What is the escape level?',
      lede: 'The escape level decides the building class, and the building class decides fire safety. Three words in the definition make the difference: highest, above-ground, after completion. Piloti derives the building class from it and asks for the value when the project lacks it.',
      note: 'Definition from the OIB-Richtlinien, Begriffsbestimmungen, May 2023 edition, in our own translation.',
      answer:
        'Under the OIB definitions, the escape level (Fluchtniveau) is the height difference between the top of the floor of the highest above-ground storey and the ground surface adjoining the building after completion, on average. From it and the other values Piloti derives the building class.',
      blocks: [
        {
          kind: 'definition',
          term: 'Escape level (Fluchtniveau)',
          text: '“Height difference between the top of the floor of the highest above-ground storey and the ground surface adjoining the building after completion, on average.”',
          source: OIB_DEFS_EN,
          sourceUrl: OIB_URL,
        },
        {
          kind: 'text',
          title: 'How Piloti helps',
          body: [
            'Piloti derives the building class from the escape level and the other values, citing the definitions and the OIB edition that applies in the state. If the escape level is missing, it asks for it instead of estimating.',
          ],
        },
        {
          kind: 'text',
          title: 'What the definition says exactly',
          body: [
            'It is measured to the top of the floor, not to the eaves or the ridge. So the escape level is not a building height; it is the height from which people on the top storey must escape and up to which the fire brigade must reach.',
            'At the top, the highest above-ground storey counts. A separate definition says what an above-ground storey is: an unconverted roof space or a plant storey without dwellings or business units does not count. At the bottom, the adjoining ground after completion counts, not the original terrain and not the street.',
            '“On average” evens out uneven ground around the building. How the average is formed in a specific case, on a steep slope or at a ramp to an underground garage, is a matter of interpretation. Record your assumption in the file.',
          ],
        },
        {
          kind: 'list',
          title: 'The thresholds for the building class',
          items: [
            '7.00 m: together with no more than three above-ground storeys, building classes 1 to 3 reach up to here.',
            '11 m: the limit of building class 4, with no more than four above-ground storeys.',
            '22 m: the limit of building class 5. Above it a building falls into none of the five classes, and separate requirements apply.',
            'For a row house, the escape level is considered separately for each dwelling or business unit.',
          ],
        },
        {
          kind: 'text',
          title: 'Where it tips in practice',
          body: [
            'A roof space is converted and becomes an above-ground storey: the escape level moves up a storey, and the building class may move with it. In existing buildings this is the most common surprise.',
            'The ground is lowered or raised during landscaping: what counts is the state after completion, that is, what the submission drawings show as future ground. Anyone who calculates with existing levels calculates with the wrong value.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'How the average is formed in a specific case is for the design team to decide; Piloti shows what the definition says and states the assumption. It takes the escape level from your documents instead of recalculating it from spot heights in the drawing.',
          ],
        },
      ],
      faq: [
        {
          q: 'How is the escape level calculated?',
          a: 'Take the top of the floor of the highest above-ground storey and subtract the level of the adjoining ground surface after completion, averaged around the building. How to form the average on strongly varying ground has to be interpreted case by case and recorded in the file.',
        },
        {
          q: 'Is the escape level the same as the building height?',
          a: 'No. The escape level ends at the top of the floor of the highest above-ground storey and comes from the OIB guidelines. Building height, eaves height or Bauklasse are governed by the state’s building code and the development plan, with their own measuring rules.',
        },
        {
          q: 'Does a roof storey count for the escape level?',
          a: 'Only if it is an above-ground storey, that is, if it contains dwellings, business units or parts of them. By definition an unconverted roof space does not count; a converted roof storey with living rooms does.',
        },
        {
          q: 'How is the escape level determined for a row house?',
          a: 'Under the row house definition, each dwelling or business unit is considered separately with regard to the escape level when classifying the building. On a slope, the houses in one row can end up with different values.',
        },
      ],
    },
  },
  {
    slug: 'oberirdisches-geschoss',
    checked: '2026-09',
    term: 'Oberirdisches Geschoß',
    related: ['glossar/fluchtniveau', 'glossar/gebaeudeklasse', 'anwendungen/bestand', 'anwendungen/gebaeudeklasse'],
    de: {
      title: 'Oberirdisches Geschoß: Definition nach OIB erklärt',
      description:
        'Oberirdisches Geschoß Definition nach OIB: wann Hanggeschoß, Keller und Dachgeschoß zählen – und warum das die Gebäudeklasse verändern kann.',
      heading: 'Was ist ein oberirdisches Geschoß?',
      lede: 'Wie viele Geschoße hat das Haus? Für die OIB-Richtlinien ist das keine Frage des Zählens, sondern der Definition. Und die hat zwei Hälften: eine Regel und eine Ausnahme. Piloti zählt nach beiden Hälften, mit Fundstelle.',
      note: 'Definition laut OIB-Richtlinien, Begriffsbestimmungen, Ausgabe Mai 2023.',
      answer:
        'Ein oberirdisches Geschoß ist nach den OIB-Begriffsbestimmungen ein Geschoß, dessen äußere Begrenzungsflächen in Summe zu mehr als der Hälfte über dem anschließenden Gelände nach Fertigstellung liegen; Geschoße ohne Wohnungen, Betriebseinheiten oder Teile davon, etwa nicht ausgebaute Dachräume, zählen nicht dazu. Piloti zählt die Geschoße für die Gebäudeklasse nach dieser Definition, mit Fundstelle.',
      blocks: [
        {
          kind: 'definition',
          term: 'Geschoß, oberirdisches',
          text: '„Geschoß, dessen äußere Begrenzungsflächen in Summe zu mehr als der Hälfte über dem anschließenden Gelände nach Fertigstellung liegen. Nicht zu den oberirdischen Geschoßen zählen solche, in denen sich keine Wohnungen, Betriebseinheiten oder Teile von solchen befinden (z.B. nicht ausgebaute Dachräume, Triebwerksräume, Räume für haustechnische Anlagen).“',
          source: OIB_DEFS,
          sourceUrl: OIB_URL,
        },
        {
          kind: 'text',
          title: 'Wie Piloti dabei hilft',
          body: [
            'Piloti zählt die oberirdischen Geschoße für die Gebäudeklasse nach dieser Definition, mit Fundstelle, und fragt nach, wenn aus Ihren Unterlagen nicht hervorgeht, ob ein Dachraum ausgebaut ist. Bei einem Umbau stuft es zuerst das Vorhaben ein und erst dann die Anforderung.',
          ],
        },
        {
          kind: 'text',
          title: 'Die Regel: mehr als die Hälfte über Gelände',
          body: [
            'Entscheidend ist die Summe der äußeren Begrenzungsflächen eines Geschoßes, nicht eine einzelne Fassade. Am ebenen Grundstück ist das selten eine Frage. Am Hang schon: Ein Geschoß, das talseitig frei steht und bergseitig im Erdreich liegt, kann oberirdisch sein, auch wenn es in der Zeichnung „Untergeschoß“ heißt.',
            'Maßgeblich ist das Gelände nach Fertigstellung. Eine Anschüttung kann ein Geschoß unter die Hälfte drücken, ein Abgraben für Lichthöfe oder eine Terrasse hebt es darüber. Beides steht im Einreichplan, und dort sollte man es auch prüfen.',
          ],
        },
        {
          kind: 'text',
          title: 'Die Ausnahme: Geschoße ohne Nutzungseinheiten',
          body: [
            'Ein Geschoß, in dem sich keine Wohnungen, Betriebseinheiten oder Teile davon befinden, zählt nicht. Die Definition nennt als Beispiele nicht ausgebaute Dachräume, Triebwerksräume und Räume für haustechnische Anlagen.',
            'Das „oder Teile von solchen“ ist die Stelle, an der man genau lesen muss: Liegt auch nur ein Teil einer Maisonette oder eines Büros im Dachgeschoß, ist es ein oberirdisches Geschoß. Die Galerie einer Wohnung im Dach zählt damit mit.',
          ],
        },
        {
          kind: 'list',
          title: 'Warum das Zählen Folgen hat',
          items: [
            'Die Zahl der oberirdischen Geschoße ist eine der Größen der Gebäudeklasse: höchstens drei für GK 1 bis 3, höchstens vier für GK 4.',
            'Das höchstgelegene oberirdische Geschoß bestimmt das Fluchtniveau. Ein zusätzliches Geschoß hebt beide Werte zugleich.',
            'Im Bestand ändert ein Dachausbau deshalb oft mehr als das Dach: Er kann die Gebäudeklasse und damit die Brandschutzanforderungen verschieben.',
            'Bauordnungen und Bebauungspläne verwenden für Gebäudehöhe und Bebauung teils eigene Geschoßbegriffe. Die OIB-Definition gilt für die OIB-Richtlinien, nicht automatisch für das Bebauungsrecht.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Ob ein Hanggeschoß zu mehr als der Hälfte über Gelände liegt, misst die Planung an den Ansichten; Piloti sagt, welche Flächen dafür zu vergleichen sind. Geht aus den Unterlagen nicht hervor, ob ein Dachraum ausgebaut ist, fragt es nach.',
          ],
        },
      ],
      faq: [
        {
          q: 'Ist ein Keller ein oberirdisches Geschoß?',
          a: 'Ein Keller, der überwiegend im Erdreich liegt, ist kein oberirdisches Geschoß. Liegen seine äußeren Begrenzungsflächen in Summe zu mehr als der Hälfte über dem Gelände nach Fertigstellung, etwa am Hang, und enthält er Wohnungen oder Betriebseinheiten, zählt er mit, gleich wie er in der Zeichnung heißt.',
        },
        {
          q: 'Zählt ein Dachgeschoß als oberirdisches Geschoß?',
          a: 'Ein nicht ausgebauter Dachraum zählt laut Definition nicht. Sobald sich im Dachgeschoß eine Wohnung, eine Betriebseinheit oder auch nur ein Teil davon befindet, ist es ein oberirdisches Geschoß.',
        },
        {
          q: 'Zählt ein Technikgeschoß mit?',
          a: 'Nein, solange sich darin keine Wohnungen, Betriebseinheiten oder Teile davon befinden. Die Definition nennt Triebwerksräume und Räume für haustechnische Anlagen ausdrücklich als Beispiele.',
        },
        {
          q: 'Gilt die OIB-Definition auch für die Bauordnung?',
          a: 'Nicht automatisch. Bauordnungen und Bebauungspläne regeln Gebäudehöhe und Bebauung teils mit eigenen Begriffen und Messregeln. Für die Gebäudeklasse und die OIB-Anforderungen gilt die OIB-Definition, für das Bebauungsrecht das Landesrecht.',
        },
      ],
    },
    en: {
      title: 'Above-ground storey: the OIB definition explained',
      description:
        'Above-ground storey (oberirdisches Geschoß) under OIB: when slope storeys, basements and roof storeys count – and why it can change the building class.',
      heading: 'What is an above-ground storey?',
      lede: 'How many storeys does the building have? For the OIB guidelines that is not a matter of counting but of definition. And the definition has two halves: a rule and an exception. Piloti counts by both halves, with the citation.',
      note: 'Definition from the OIB-Richtlinien, Begriffsbestimmungen, May 2023 edition, in our own translation.',
      answer:
        'Under the OIB definitions, an above-ground storey is a storey whose external boundary surfaces lie, in total, more than half above the adjoining ground after completion; storeys without dwellings, business units or parts of them, such as unconverted roof spaces, do not count. Piloti counts the storeys for the building class under this definition, with the citation.',
      blocks: [
        {
          kind: 'definition',
          term: 'Above-ground storey (Geschoß, oberirdisches)',
          text: '“Storey whose external boundary surfaces lie, in total, more than half above the adjoining ground after completion. Storeys in which there are no dwellings, business units or parts of them (e.g. unconverted roof spaces, machine rooms, rooms for building services) do not count as above-ground storeys.”',
          source: OIB_DEFS_EN,
          sourceUrl: OIB_URL,
        },
        {
          kind: 'text',
          title: 'How Piloti helps',
          body: [
            'Piloti counts the above-ground storeys for the building class under this definition, with the citation, and asks when your documents do not show whether a roof space is converted. For an alteration it first classifies the project, and only then the requirement.',
          ],
        },
        {
          kind: 'text',
          title: 'The rule: more than half above ground',
          body: [
            'What decides is the sum of a storey’s external boundary surfaces, not a single facade. On a level plot this is rarely a question. On a slope it is: a storey that stands free on the valley side and sits in the ground on the hill side can be above-ground, even if the drawing calls it “lower ground floor”.',
            'The ground after completion is what counts. Backfill can push a storey below half; excavating for light wells or a terrace lifts it above. Both are shown in the submission drawings, and that is where to check.',
          ],
        },
        {
          kind: 'text',
          title: 'The exception: storeys without units',
          body: [
            'A storey containing no dwellings, business units or parts of them does not count. The definition gives unconverted roof spaces, machine rooms and rooms for building services as examples.',
            '“Or parts of them” is where close reading matters: if even part of a maisonette or an office lies in the roof storey, it is an above-ground storey. A dwelling’s gallery in the roof therefore counts.',
          ],
        },
        {
          kind: 'list',
          title: 'Why counting has consequences',
          items: [
            'The number of above-ground storeys is one of the values of the building class: no more than three for GK 1 to 3, no more than four for GK 4.',
            'The highest above-ground storey sets the escape level. An additional storey raises both values at once.',
            'In an existing building, a roof conversion therefore often changes more than the roof: it can shift the building class and with it the fire safety requirements.',
            'Building codes and development plans sometimes use their own storey terms for building height and plot development. The OIB definition applies to the OIB guidelines, not automatically to plot development law.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Whether a slope storey lies more than half above ground, the design team measures on the elevations; Piloti says which surfaces to compare. If the documents do not show whether a roof space is converted, it asks.',
          ],
        },
      ],
      faq: [
        {
          q: 'Is a basement an above-ground storey?',
          a: 'A basement lying mostly in the ground is not an above-ground storey. If its external boundary surfaces lie, in total, more than half above the ground after completion, on a slope for example, and it contains dwellings or business units, it counts, whatever the drawing calls it.',
        },
        {
          q: 'Does a roof storey count as an above-ground storey?',
          a: 'By definition, an unconverted roof space does not count. As soon as the roof storey contains a dwelling, a business unit or even part of one, it is an above-ground storey.',
        },
        {
          q: 'Does a plant storey count?',
          a: 'No, as long as it contains no dwellings, business units or parts of them. The definition expressly names machine rooms and rooms for building services as examples.',
        },
        {
          q: 'Does the OIB definition also apply to the building code?',
          a: 'Not automatically. Building codes and development plans sometimes govern building height and plot development with their own terms and measuring rules. The OIB definition applies to the building class and the OIB requirements; state law applies to plot development.',
        },
      ],
    },
  },
  {
    slug: 'oib-richtlinien',
    checked: '2026-09',
    term: 'OIB-Richtlinien',
    related: ['glossar/gebaeudeklasse', 'glossar/ris', 'anwendungen/brandschutz', 'anwendungen/waermeschutz', 'baurecht/wien'],
    de: {
      title: 'OIB-Richtlinien einfach erklärt: was gilt wo?',
      description:
        'OIB-Richtlinien einfach erklärt: was die sechs Richtlinien regeln, wann sie verbindlich sind und welche Ausgabe laut OIB in welchem Bundesland gilt.',
      heading: 'Was sind die OIB-Richtlinien?',
      lede: 'Sie stehen in fast jedem Bescheid und in keinem Gesetz im Volltext. Die OIB-Richtlinien sind die gemeinsame bautechnische Sprache der Länder, aber jedes Land entscheidet selbst, ab wann es sie spricht. Piloti nennt für jedes Projekt die Ausgabe, die im Land gilt, und zitiert auf den Punkt genau.',
      note: 'Inkrafttreten laut OIB-Übersicht auf oib.or.at, Stand September 2025 bzw. Juli 2026 für die OIB-Richtlinie 6, Ausgabe 2025.',
      answer:
        'Die OIB-Richtlinien sind die vom Österreichischen Institut für Bautechnik herausgegebenen bautechnischen Richtlinien, mit denen die Bundesländer ihre technischen Anforderungen vereinheitlichen; verbindlich werden sie erst, wenn ein Land sie in seiner Bauordnung oder Bautechnikverordnung für verbindlich erklärt, und zwar in einer bestimmten Ausgabe. Piloti zitiert sie auf den Punkt genau und nennt die Ausgabe, die im Bundesland des Projekts gilt.',
      blocks: [
        {
          kind: 'text',
          title: 'Was sie sind und woher ihre Geltung kommt',
          body: [
            'Baurecht ist in Österreich Landesrecht. Damit ein Brandschutz- oder Wärmeschutzstandard nicht in neun Fassungen existiert, erarbeiten die Länder über das Österreichische Institut für Bautechnik (OIB) gemeinsame Richtlinien. Das OIB selbst erlässt kein Recht: Erst das Land erklärt die Richtlinien für verbindlich, meist in seiner Bautechnikverordnung oder im Baugesetz.',
            'Dazu gehören die Begriffsbestimmungen, in denen Wörter wie Gebäudeklasse, Fluchtniveau oder oberirdisches Geschoß definiert sind. Wer eine Richtlinie liest, ohne die Begriffsbestimmungen daneben zu haben, liest sie halb.',
          ],
        },
        {
          kind: 'text',
          title: 'Wie Piloti mit den Richtlinien arbeitet',
          body: [
            'Piloti zitiert die OIB-Richtlinien auf den Punkt genau, etwa „Pkt. 3.5.2 · S. 7“, und prüft die Fundstelle gegen den Quelltext, bevor sie erscheint. Es sagt, welche Ausgabe im Bundesland des Projekts gilt, wenn das die Antwort verändert.',
          ],
        },
        {
          kind: 'list',
          title: 'Die sechs Richtlinien',
          items: [
            'OIB-Richtlinie 1: Mechanische Festigkeit und Standsicherheit.',
            'OIB-Richtlinie 2: Brandschutz, mit eigenen Teilen für besondere Gebäude wie Betriebsbauten und Garagen.',
            'OIB-Richtlinie 3: Hygiene, Gesundheit und Umweltschutz, etwa Aufenthaltsräume, Belichtung, Lüftung.',
            'OIB-Richtlinie 4: Nutzungssicherheit und Barrierefreiheit.',
            'OIB-Richtlinie 5: Schallschutz.',
            'OIB-Richtlinie 6: Energieeinsparung und Wärmeschutz.',
          ],
        },
        {
          kind: 'table',
          title: 'Ausgabe 2023: wo sie laut OIB-Übersicht in Kraft ist',
          headA: 'OIB-RL 1–5',
          headB: 'OIB-RL 6',
          rows: [
            { label: 'Burgenland', a: '–', b: '–' },
            { label: 'Kärnten', a: '31.12.2024', b: '31.12.2024' },
            { label: 'Niederösterreich', a: '18.3.2025', b: '18.3.2025' },
            { label: 'Oberösterreich', a: '1.10.2025', b: '–' },
            { label: 'Salzburg', a: '–', b: '–' },
            { label: 'Steiermark', a: '–', b: '–' },
            { label: 'Tirol', a: '16.7.2026', b: '–' },
            { label: 'Vorarlberg', a: '–', b: '–' },
            { label: 'Wien', a: '23.2.2024', b: '23.2.2024' },
          ],
          note: 'Laut OIB-Übersicht, Stand September 2025. Die OIB-Richtlinie 6, Ausgabe 2025, gilt laut OIB-Übersicht (Stand Juli 2026) in Tirol seit 16.7.2026 und in Wien seit 15.7.2026. Wo die Ausgabe 2023 nicht verbindlich ist, gilt in der Regel noch die Ausgabe 2019. Die Länder können Ausnahmen und Übergangsregeln festlegen: Prüfen Sie die Bautechnikvorschrift Ihres Landes.',
        },
        {
          kind: 'text',
          title: 'Wo die Richtlinien aufhören',
          body: [
            'Die OIB-Richtlinien regeln die Bautechnik, nicht die Bebauung. Wie hoch, wie dicht und in welchem Abstand gebaut werden darf, steht in der Bauordnung und im Bebauungsplan. Auch das Verfahren, von der Einreichung bis zur Fertigstellungsanzeige, ist Landesrecht.',
            'Die Richtlinien verweisen an vielen Stellen auf ÖNORMen. Diese Normen sind ein eigenes Regelwerk, und welche Norm in welcher Fassung zählt, steht im Verweis der Richtlinie. Die Länder lassen in der Regel Abweichungen von den Richtlinien zu, wenn nachgewiesen wird, dass das gleiche Schutzniveau erreicht wird.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Verweist eine Richtlinie auf eine ÖNORM, nennt Piloti die Norm; den Wortlaut legt das Büro aus seiner Normensammlung daneben. Welche Ausgabe ein laufendes Verfahren trifft, regeln die Übergangsbestimmungen des Landes, auf die Piloti verweist.',
          ],
        },
      ],
      faq: [
        {
          q: 'Sind die OIB-Richtlinien verbindlich?',
          a: 'Nicht aus sich heraus. Verbindlich werden sie, wenn ein Bundesland sie in seiner Bauordnung oder Bautechnikverordnung für verbindlich erklärt, in einer bestimmten Ausgabe. Die Länder lassen in der Regel Abweichungen zu, wenn das gleiche Schutzniveau nachgewiesen wird.',
        },
        {
          q: 'Welche Ausgabe der OIB-Richtlinien gilt in meinem Bundesland?',
          a: 'Laut OIB-Übersicht (Stand September 2025) ist die Ausgabe 2023 in Kärnten, Niederösterreich, Wien und für die Richtlinien 1 bis 5 in Oberösterreich und Tirol in Kraft. In den übrigen Ländern gilt in der Regel noch die Ausgabe 2019. Übergangsregeln stehen in der Bautechnikvorschrift des Landes.',
        },
        {
          q: 'Wo finde ich die OIB-Richtlinien?',
          a: 'Auf der Website des OIB, oib.or.at, samt Begriffsbestimmungen, Erläuterungen und der Übersicht, wo welche Ausgabe gilt. Die Verbindlicherklärung selbst finden Sie im Landesrecht, im RIS.',
        },
        {
          q: 'Was ist der Unterschied zwischen OIB-Richtlinie und ÖNORM?',
          a: 'Die OIB-Richtlinien legen die bautechnischen Anforderungen fest, die das Land verbindlich macht. ÖNORMen sind technische Normen von Austrian Standards; verbindlich sind sie dort, wo ein Gesetz oder eine Richtlinie auf sie verweist.',
        },
      ],
    },
    en: {
      title: 'OIB guidelines explained simply: what applies where?',
      description:
        'The OIB guidelines explained simply: what the six guidelines govern, when they are binding and which edition applies in which Austrian state.',
      heading: 'What are the OIB guidelines?',
      lede: 'They appear in almost every permit and in no statute in full. The OIB guidelines are the states’ shared technical language, but each state decides for itself from when it speaks it. For every project Piloti names the edition in force in the state and cites down to the clause.',
      note: 'Entry into force per the OIB overview on oib.or.at, as of September 2025, and as of July 2026 for OIB guideline 6, 2025 edition.',
      answer:
        'The OIB guidelines are the building-technology guidelines issued by the Austrian Institute of Construction Engineering (OIB), with which the states harmonise their technical requirements; they become binding only when a state declares them binding in its building code or building-technology regulation, and then in a specific edition. Piloti cites them down to the clause and names the edition in force in the project’s state.',
      blocks: [
        {
          kind: 'text',
          title: 'What they are and where their force comes from',
          body: [
            'In Austria, building law is state law. So that a fire safety or thermal protection standard does not exist in nine versions, the states draw up joint guidelines through the Austrian Institute of Construction Engineering (OIB). The OIB itself makes no law: only the state declares the guidelines binding, usually in its building-technology regulation or building act.',
            'They come with the definitions (Begriffsbestimmungen), where words such as building class, escape level or above-ground storey are defined. Anyone reading a guideline without the definitions next to it reads half of it.',
          ],
        },
        {
          kind: 'text',
          title: 'How Piloti works with the guidelines',
          body: [
            'Piloti cites the OIB guidelines down to the clause, for example “Pkt. 3.5.2 · S. 7”, and checks the citation against the source text before it appears. It says which edition applies in the project’s state when that changes the answer.',
          ],
        },
        {
          kind: 'list',
          title: 'The six guidelines',
          items: [
            'OIB guideline 1: mechanical resistance and stability.',
            'OIB guideline 2: fire safety, with separate parts for special buildings such as industrial buildings and garages.',
            'OIB guideline 3: hygiene, health and environmental protection, for example habitable rooms, daylight, ventilation.',
            'OIB guideline 4: safety in use and accessibility.',
            'OIB guideline 5: sound insulation.',
            'OIB guideline 6: energy saving and thermal insulation.',
          ],
        },
        {
          kind: 'table',
          title: '2023 edition: where it is in force per the OIB overview',
          headA: 'OIB-RL 1–5',
          headB: 'OIB-RL 6',
          rows: [
            { label: 'Burgenland', a: '–', b: '–' },
            { label: 'Carinthia', a: '31.12.2024', b: '31.12.2024' },
            { label: 'Lower Austria', a: '18.3.2025', b: '18.3.2025' },
            { label: 'Upper Austria', a: '1.10.2025', b: '–' },
            { label: 'Salzburg', a: '–', b: '–' },
            { label: 'Styria', a: '–', b: '–' },
            { label: 'Tyrol', a: '16.7.2026', b: '–' },
            { label: 'Vorarlberg', a: '–', b: '–' },
            { label: 'Vienna', a: '23.2.2024', b: '23.2.2024' },
          ],
          note: 'Per the OIB overview, as of September 2025. OIB guideline 6, 2025 edition, applies per the OIB overview (as of July 2026) in Tyrol since 16.7.2026 and in Vienna since 15.7.2026. Where the 2023 edition is not binding, the 2019 edition generally still applies. States can set exceptions and transition rules: check your state’s building-technology rules.',
        },
        {
          kind: 'text',
          title: 'Where the guidelines stop',
          body: [
            'The OIB guidelines govern building technology, not plot development. How high, how dense and at what distance one may build is set by the building code and the development plan. The procedure, from submission to notice of completion, is state law too.',
            'The guidelines refer to ÖNORM standards in many places. Those standards are a body of rules of their own, and which standard in which version counts is stated in the guideline’s reference. States generally allow deviations from the guidelines where it is shown that the same level of protection is reached.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'When a guideline refers to an ÖNORM, Piloti names the standard; the office sets the wording beside it from its own collection of standards. Which edition governs a pending procedure is set by the state’s transition rules, which Piloti points to.',
          ],
        },
      ],
      faq: [
        {
          q: 'Are the OIB guidelines binding?',
          a: 'Not by themselves. They become binding when a state declares them binding in its building code or building-technology regulation, in a specific edition. States generally allow deviations where the same level of protection is shown.',
        },
        {
          q: 'Which edition of the OIB guidelines applies in my state?',
          a: 'Per the OIB overview (as of September 2025), the 2023 edition is in force in Carinthia, Lower Austria and Vienna, and for guidelines 1 to 5 in Upper Austria and Tyrol. In the other states the 2019 edition generally still applies. Transition rules are in the state’s building-technology rules.',
        },
        {
          q: 'Where can I find the OIB guidelines?',
          a: 'On the OIB website, oib.or.at, together with the definitions, explanatory notes and the overview of which edition applies where. The act that makes them binding is in state law, in the RIS.',
        },
        {
          q: 'What is the difference between an OIB guideline and an ÖNORM?',
          a: 'The OIB guidelines set the technical requirements the state makes binding. ÖNORMs are technical standards from Austrian Standards; they are binding where a law or a guideline refers to them.',
        },
      ],
    },
  },
  {
    slug: 'ris',
    checked: '2026-09',
    term: 'RIS – Rechtsinformationssystem des Bundes',
    related: ['vergleich/ris-und-google', 'glossar/oib-richtlinien', 'baurecht/wien', 'anwendungen/bestand'],
    de: {
      title: 'RIS Rechtsinformationssystem: Bauordnung finden',
      description:
        'RIS Rechtsinformationssystem und Bauordnung: wo das Landesrecht im RIS steht, wie man die geltende Fassung findet und was eine konsolidierte Fassung ist.',
      heading: 'Was ist das RIS?',
      lede: 'Jede Bauordnung Österreichs steht im RIS, kostenlos und aktuell. Trotzdem landet man bei der Suche nach einem Paragrafen oft auf einer veralteten Kopie. Wie man im RIS findet, was man sucht. Piloti öffnet jede zitierte Stelle direkt aus dem RIS, markiert.',
      answer:
        'Das RIS, das Rechtsinformationssystem des Bundes, ist die vom Bundeskanzleramt betriebene, frei zugängliche Datenbank des österreichischen Rechts; dort stehen unter anderem das Bundesrecht, das Landesrecht aller neun Bundesländer mit ihren Bauordnungen und die Entscheidungen der Höchstgerichte. Piloti zitiert das Landesrecht so, wie ein Bescheid es nennt, und öffnet die Stelle aus dem RIS.',
      blocks: [
        {
          kind: 'text',
          title: 'Was im RIS steht',
          body: [
            'Das RIS (ris.bka.gv.at) sammelt das Bundesrecht und das Landesrecht in konsolidierter Fassung, die Gesetzblätter und die Rechtsprechung, etwa des Verfassungsgerichtshofs, des Verwaltungsgerichtshofs und der Landesverwaltungsgerichte. Für Planer:innen ist das Landesrecht der wichtigste Teil: Bauordnung, Bautechnikverordnung, Raumordnungsgesetz und die Verordnung, mit der das Land die OIB-Richtlinien für verbindlich erklärt.',
            'Die konsolidierte Fassung fügt alle Novellen in einen lesbaren Text zusammen. Sie ist eine Lesehilfe. Maßgeblich ist, was im jeweiligen Gesetzblatt kundgemacht wurde, und im Zweifel schaut man dort nach.',
          ],
        },
        {
          kind: 'text',
          title: 'Wie Piloti das RIS nutzt',
          body: [
            'Piloti beantwortet Fragen aus den neun Landesbauordnungen und dem zugehörigen Landesrecht aus dem RIS und zitiert es, wie ein Bescheid es nennt, etwa „Bauordnung für Wien, § …“. Die Quelle öffnet sich in Piloti an der markierten Stelle, und die Fundstelle wird gegen den Text geprüft, bevor sie erscheint.',
          ],
        },
        {
          kind: 'text',
          title: 'Was nicht im RIS steht',
          body: [
            'Der Bebauungsplan Ihres Grundstücks steht in aller Regel nicht im RIS, sondern bei der Gemeinde oder im Geoportal des Landes. Die OIB-Richtlinien selbst stehen auf der Website des OIB; im RIS steht nur die Bestimmung, die sie verbindlich macht. ÖNORMen stehen weder da noch dort frei zur Verfügung.',
          ],
        },
        {
          kind: 'steps',
          title: 'So finden Sie die geltende Bauordnung im RIS',
          items: [
            { name: 'Landesrecht wählen', body: 'Unter „Landesrecht konsolidiert“ das Bundesland auswählen, in dem das Projekt steht.' },
            { name: 'Gesetz suchen', body: 'Nach dem Titel suchen, etwa „Bauordnung für Wien“ oder „NÖ Bauordnung 2014“. Kurztitel und Abkürzung sind die sichersten Suchbegriffe.' },
            { name: 'Fassung prüfen', body: 'Das Datum der Fassung beachten. Für ein laufendes Verfahren oder einen Bestand kann eine ältere Fassung maßgeblich sein; das RIS zeigt Fassungen zu einem Stichtag.' },
            { name: 'Übergangsbestimmungen lesen', body: 'Am Ende des Gesetzes steht, ab wann eine Novelle gilt und für welche Verfahren noch das alte Recht anzuwenden ist.' },
          ],
        },
        {
          kind: 'text',
          title: 'Warum Google hier nicht reicht',
          body: [
            'Eine Websuche nach einem Paragrafen findet oft Kopien auf Kammer-, Firmen- oder Behördenseiten, und nicht jede davon ist auf dem Stand der letzten Novelle. Ein Paragraf, der vor zwei Novellen richtig war, ist im Akt ein Fehler, der erst im Verfahren auffällt.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Piloti zitiert das Landesrecht in der geltenden Fassung. Für eine ältere Fassung, etwa beim Bestand, schlagen Sie im RIS mit dem Stichtag nach; welche Fassung für Ihr Verfahren gilt, entscheiden die Übergangsbestimmungen.',
          ],
        },
      ],
      faq: [
        {
          q: 'Was ist das RIS?',
          a: 'Das Rechtsinformationssystem des Bundes, eine vom Bundeskanzleramt betriebene, kostenlose Datenbank unter ris.bka.gv.at. Sie enthält Bundes- und Landesrecht, die Gesetzblätter und die Rechtsprechung der Höchstgerichte.',
        },
        {
          q: 'Ist die Fassung im RIS rechtlich verbindlich?',
          a: 'Die konsolidierte Fassung ist eine Lesehilfe, die alle Novellen zu einem Text zusammenführt. Maßgeblich ist, was im jeweiligen Gesetzblatt kundgemacht wurde. Im Alltag ist die konsolidierte Fassung der richtige Ausgangspunkt, bei einer strittigen Stelle lohnt der Blick ins Gesetzblatt.',
        },
        {
          q: 'Wo finde ich die Bauordnung meines Bundeslandes?',
          a: 'Im RIS unter „Landesrecht konsolidiert“, Bundesland auswählen, nach dem Titel suchen. Die Titel sind nicht einheitlich: In Wien heißt sie Bauordnung für Wien, in der Steiermark Steiermärkisches Baugesetz, in Vorarlberg Baugesetz.',
        },
        {
          q: 'Steht der Bebauungsplan im RIS?',
          a: 'In aller Regel nicht. Bebauungspläne sind Verordnungen der Gemeinde und liegen bei der Gemeinde oder im Geoportal des Landes. Das RIS enthält das Landesgesetz, auf dessen Grundlage sie erlassen werden.',
        },
      ],
    },
    en: {
      title: 'RIS legal information system: finding a building code',
      description:
        'The RIS legal information system and building codes: where state law sits in the RIS, how to find the version in force, and what a consolidated version is.',
      heading: 'What is the RIS?',
      lede: 'Every Austrian building code is in the RIS, free and up to date. Still, searching for a section often lands you on an outdated copy. How to find what you are looking for in the RIS. Piloti opens every cited passage straight from the RIS, marked.',
      answer:
        'The RIS, the federal legal information system (Rechtsinformationssystem des Bundes), is the freely accessible database of Austrian law run by the Federal Chancellery; among other things it holds federal law, the law of all nine states including their building codes, and the decisions of the highest courts. Piloti cites state law the way a permit names it and opens the passage from the RIS.',
      blocks: [
        {
          kind: 'text',
          title: 'What is in the RIS',
          body: [
            'The RIS (ris.bka.gv.at) collects federal and state law in consolidated form, the law gazettes and case law, for example of the Constitutional Court, the Supreme Administrative Court and the state administrative courts. For planners, state law is the key part: building code, building-technology regulation, spatial planning act and the regulation by which the state makes the OIB guidelines binding.',
            'The consolidated version merges all amendments into one readable text. It is a reading aid. What was promulgated in the relevant law gazette is what counts, and when in doubt that is where to look.',
          ],
        },
        {
          kind: 'text',
          title: 'How Piloti uses the RIS',
          body: [
            'Piloti answers questions from the nine state building codes and related state law from the RIS and cites them the way a permit would, for example “Bauordnung für Wien, § …”. The source opens inside Piloti at the marked passage, and the citation is checked against the text before it appears.',
          ],
        },
        {
          kind: 'text',
          title: 'What is not in the RIS',
          body: [
            'Your plot’s development plan is generally not in the RIS but with the municipality or in the state’s geoportal. The OIB guidelines themselves are on the OIB website; the RIS holds only the provision that makes them binding. ÖNORM standards are freely available in neither place.',
          ],
        },
        {
          kind: 'steps',
          title: 'How to find the building code in force in the RIS',
          items: [
            { name: 'Choose state law', body: 'Under “Landesrecht konsolidiert”, select the state the project is in.' },
            { name: 'Search for the act', body: 'Search by title, for example “Bauordnung für Wien” or “NÖ Bauordnung 2014”. Short title and abbreviation are the safest search terms.' },
            { name: 'Check the version', body: 'Note the date of the version. For a pending procedure or an existing building an older version may count; the RIS shows versions as of a given date.' },
            { name: 'Read the transition rules', body: 'The end of the act says from when an amendment applies and for which procedures the old law still applies.' },
          ],
        },
        {
          kind: 'text',
          title: 'Why Google is not enough here',
          body: [
            'A web search for a section often finds copies on chamber, company or authority sites, and not every one of them reflects the latest amendment. A section that was right two amendments ago is an error in the file that only surfaces in the procedure.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti cites state law in the version in force. For an older version, for an existing building say, look it up in the RIS by date; which version applies to your procedure is decided by the transition rules.',
          ],
        },
      ],
      faq: [
        {
          q: 'What is the RIS?',
          a: 'The federal legal information system, a free database run by the Federal Chancellery at ris.bka.gv.at. It holds federal and state law, the law gazettes and the case law of the highest courts.',
        },
        {
          q: 'Is the version in the RIS legally binding?',
          a: 'The consolidated version is a reading aid that merges all amendments into one text. What was promulgated in the relevant law gazette is what counts. In daily work the consolidated version is the right starting point; for a disputed passage, a look at the gazette is worth it.',
        },
        {
          q: 'Where do I find my state’s building code?',
          a: 'In the RIS under “Landesrecht konsolidiert”: select the state and search by title. The titles are not uniform: in Vienna it is the Bauordnung für Wien, in Styria the Steiermärkisches Baugesetz, in Vorarlberg the Baugesetz.',
        },
        {
          q: 'Is the development plan in the RIS?',
          a: 'Generally not. Development plans are municipal regulations and are held by the municipality or in the state’s geoportal. The RIS holds the state act on which they are based.',
        },
      ],
    },
  },
  {
    slug: 'bebauungsplan',
    checked: '2026-09',
    term: 'Bebauungsplan',
    related: ['anwendungen/bebauung', 'glossar/gebaeudeklasse', 'glossar/einreichplan', 'baurecht/wien'],
    de: {
      title: 'Bebauungsplan lesen: was er in Österreich regelt',
      description:
        'Bebauungsplan lesen: was Baulinien, Bauklasse, Bauweise und Dichte festlegen, wo Sie den Bebauungsplan finden und was gilt, wenn es für ein Grundstück keinen gibt.',
      heading: 'Wie liest man einen Bebauungsplan?',
      lede: 'Bevor irgendeine OIB-Frage zählt, entscheidet der Bebauungsplan, was auf dem Grundstück überhaupt stehen darf. Er ist Gemeinderecht auf Grundlage von Landesrecht, und in jedem Bundesland ein wenig anders. Piloti liest ihn mit, sobald er im Projekt liegt.',
      answer:
        'Ein Bebauungsplan ist eine Verordnung der Gemeinde, die auf Grundlage des Raumordnungs- oder Baurechts des Landes festlegt, wie ein Grundstück bebaut werden darf, etwa mit Baulinien, Gebäudehöhe oder Bauklasse, Bauweise und Dichte; was er genau enthält und wie er heißt, regelt jedes Bundesland selbst. Piloti liest ihn mit, sobald er im Projekt liegt, und nennt die Festlegung, auf die es sich stützt.',
      blocks: [
        {
          kind: 'text',
          title: 'Was ein Bebauungsplan ist',
          body: [
            'Der Flächenwidmungsplan sagt, wofür eine Fläche gewidmet ist, etwa Bauland-Wohngebiet oder Grünland. Der Bebauungsplan sagt, wie auf dem Bauland gebaut werden darf. Beide sind Verordnungen der Gemeinde, erlassen nach dem Raumordnungsgesetz oder der Bauordnung des Landes.',
            'Die Namen und Inhalte unterscheiden sich. In Wien sind Flächenwidmungs- und Bebauungsplan ein gemeinsames Plandokument nach der Bauordnung für Wien, dort steht auch die Bauklasse. In anderen Ländern gibt es Bebauungspläne, Teilbebauungspläne oder Bebauungsrichtlinien, und nicht jedes Grundstück ist von einem erfasst.',
          ],
        },
        {
          kind: 'text',
          title: 'Wie Piloti dabei hilft',
          body: [
            'Die Arbeitsweise „Bebauung“ klärt, was auf einem Grundstück gebaut werden darf: Bauklasse bzw. Gebäudehöhe, Bauwich, Widmung, Dichte, Stellplätze, nach Landes- und Gemeinderecht, nicht nach OIB. Liegt der Bebauungsplan im Projekt, liest Piloti ihn mit und nennt die Festlegung, auf die es sich stützt.',
          ],
        },
        {
          kind: 'list',
          title: 'Was typischerweise drinsteht',
          items: [
            'Baulinien, Baufluchtlinien oder Baugrenzen: wo das Gebäude stehen darf und wo es anschließen muss.',
            'Höhe: je nach Land als Bauklasse, als Gebäude- oder Traufhöhe oder als Zahl der Geschoße, jeweils mit eigenen Messregeln.',
            'Bauweise: offen, gekuppelt, geschlossen, und damit, ob und wie an die Nachbargrenze gebaut wird.',
            'Dichte und Ausnutzung, Dachform, Stellplätze, Grünflächen und besondere Bestimmungen, die nur für dieses Gebiet gelten.',
          ],
        },
        {
          kind: 'steps',
          title: 'So lesen Sie ihn',
          items: [
            { name: 'Fassung sichern', body: 'Plannummer bzw. Plandokument und Datum der Kundmachung notieren. Ein Bebauungsplan in Überarbeitung kann in wenigen Monaten anders aussehen.' },
            { name: 'Legende und Planzeichen', body: 'Jede Linie und jedes Kürzel hat eine Bedeutung, die in der Legende oder in der Planzeichenverordnung des Landes steht, nicht im allgemeinen Sprachgebrauch.' },
            { name: 'Textliche Bestimmungen', body: 'Die Festlegungen in Worten gehören zum Bebauungsplan. Sie enthalten oft das, woran eine Einreichung scheitert: Dachneigung, Einfriedung, Begrünung.' },
            { name: 'Lücken schließen', body: 'Was der Bebauungsplan nicht regelt, regelt das Landesrecht mit seinen allgemeinen Bestimmungen, etwa zu Abständen.' },
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Was der Bebauungsplan für genau dieses Grundstück festlegt, liest Piloti aus dem Bebauungsplan im Projekt. Liegt er dort nicht, sagt es das und wo Sie nachsehen, statt eine Festlegung anzunehmen.',
          ],
        },
      ],
      faq: [
        {
          q: 'Wo finde ich den Bebauungsplan für mein Grundstück?',
          a: 'Bei der Gemeinde, in größeren Städten beim zuständigen Amt, und in vielen Ländern im Geoportal des Landes. In Wien ist der Flächenwidmungs- und Bebauungsplan online bei der Stadt einsehbar. Im RIS steht er in aller Regel nicht.',
        },
        {
          q: 'Was ist der Unterschied zwischen Flächenwidmungsplan und Bebauungsplan?',
          a: 'Der Flächenwidmungsplan legt fest, wofür eine Fläche genutzt werden darf, etwa als Bauland oder Grünland. Der Bebauungsplan legt fest, wie auf dem Bauland gebaut werden darf: Lage, Höhe, Bauweise, Dichte. In Wien sind beide in einem Plandokument vereint.',
        },
        {
          q: 'Was gilt, wenn es keinen Bebauungsplan gibt?',
          a: 'Dann gelten die allgemeinen Bestimmungen des Landesrechts, etwa zu Abständen und zum Einfügen in die Umgebung. Wie diese lauten, unterscheidet sich von Land zu Land; die Baubehörde der Gemeinde gibt Auskunft.',
        },
        {
          q: 'Ist die Bauklasse im Bebauungsplan dasselbe wie die Gebäudeklasse?',
          a: 'Nein. Die Bauklasse, etwa in Wien, regelt die zulässige Gebäudehöhe nach der Bauordnung. Die Gebäudeklasse kommt aus den OIB-Richtlinien und steuert vor allem den Brandschutz.',
        },
      ],
    },
    en: {
      title: 'Reading a development plan (Bebauungsplan) in Austria',
      description:
        'Reading a development plan (Bebauungsplan): what building lines, Bauklasse, pattern and density fix, where to find it, and what applies without one.',
      heading: 'How do you read a development plan?',
      lede: 'Before any OIB question counts, the development plan decides what may stand on the plot at all. It is municipal law based on state law, and a little different in every state. Piloti reads it along as soon as it is in the project.',
      answer:
        'A development plan (Bebauungsplan) is a municipal regulation that, based on the state’s spatial planning or building law, sets how a plot may be built on, for example with building lines, building height or Bauklasse, building pattern and density; what exactly it contains and what it is called is up to each state. Piloti reads it as soon as it is in the project and names the provision it relies on.',
      blocks: [
        {
          kind: 'text',
          title: 'What a development plan is',
          body: [
            'The zoning plan (Flächenwidmungsplan) says what an area is zoned for, such as residential building land or green land. The development plan says how the building land may be built on. Both are municipal regulations, issued under the state’s spatial planning act or building code.',
            'Names and contents differ. In Vienna, the zoning and development plan is one document under the Bauordnung für Wien, and it sets the Bauklasse. Other states have development plans, partial development plans or development guidelines, and not every plot is covered by one.',
          ],
        },
        {
          kind: 'text',
          title: 'How Piloti helps',
          body: [
            'The “Bebauung” way of working clarifies what may be built on a plot: Bauklasse or building height, side distances, zoning, density, parking, under state and municipal law, not OIB. If the development plan is in the project, Piloti reads it too and names the provision it relies on.',
          ],
        },
        {
          kind: 'list',
          title: 'What it typically contains',
          items: [
            'Building lines, alignment lines or building limits: where the building may stand and where it must connect.',
            'Height: depending on the state as Bauklasse, as building or eaves height or as number of storeys, each with its own measuring rules.',
            'Building pattern: open, semi-detached, closed, and with it whether and how one builds to the neighbouring boundary.',
            'Density and plot use, roof form, parking, green areas and special provisions that apply only to that area.',
          ],
        },
        {
          kind: 'steps',
          title: 'How to read it',
          items: [
            { name: 'Pin the version', body: 'Note the number of the development plan or of its document, and the date of promulgation. A development plan under revision can look different in a few months.' },
            { name: 'Legend and symbols', body: 'Every line and abbreviation has a meaning set in the legend or the state’s plan symbols regulation, not in everyday language.' },
            { name: 'Written provisions', body: 'The provisions in words are part of the development plan. They often hold what a submission fails on: roof pitch, fencing, greening.' },
            { name: 'Close the gaps', body: 'What the development plan does not govern, state law governs with its general provisions, for example on distances.' },
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'What the development plan fixes for this very plot, Piloti reads from the development plan in the project. If it is not there, it says so and where to look, instead of assuming a provision.',
          ],
        },
      ],
      faq: [
        {
          q: 'Where do I find the development plan for my plot?',
          a: 'With the municipality, in larger cities with the responsible office, and in many states in the state’s geoportal. In Vienna, the zoning and development plan can be viewed online on the city’s site. It is generally not in the RIS.',
        },
        {
          q: 'What is the difference between a zoning plan and a development plan?',
          a: 'The zoning plan sets what an area may be used for, such as building land or green land. The development plan sets how the building land may be built on: position, height, building pattern, density. In Vienna both are combined in one document.',
        },
        {
          q: 'What applies if there is no development plan?',
          a: 'Then the general provisions of state law apply, for example on distances and on fitting into the surroundings. What they say differs from state to state; the municipal building authority can tell you.',
        },
        {
          q: 'Is the Bauklasse in the development plan the same as the building class?',
          a: 'No. The Bauklasse, for example in Vienna, governs the permitted building height under the building code. The building class comes from the OIB guidelines and mainly steers fire safety.',
        },
      ],
    },
  },
  {
    slug: 'einreichplan',
    checked: '2026-09',
    term: 'Einreichplan',
    related: ['anwendungen/einreichcheck', 'glossar/bebauungsplan', 'glossar/ris', 'baurecht/wien'],
    de: {
      title: 'Einreichplan: Inhalt und Unterlagen in Österreich',
      description:
        'Einreichplan Inhalt: welche Zeichnungen und Unterlagen ein Bauansuchen in Österreich braucht, wer unterschreibt und warum das je Bundesland anders ist.',
      heading: 'Was gehört in einen Einreichplan?',
      lede: 'Ein Einreichplan wird selten abgelehnt, weil der Entwurf schlecht ist, sondern weil etwas fehlt. Was hineingehört, bestimmt die Bauordnung des Landes, in dem das Projekt steht. Der Einreichcheck von Piloti zeigt, was dem Paket noch fehlt, bevor die Behörde es tut.',
      answer:
        'Der Einreichplan ist die Plandarstellung, die mit dem Bauansuchen oder der Bauanzeige bei der Baubehörde eingereicht wird, meist Lageplan, Grundrisse, Schnitte und Ansichten mit Baubeschreibung; was er genau enthalten muss und welche Unterlagen dazugehören, regelt die Bauordnung des jeweiligen Bundeslandes. Piloti prüft mit dem Einreichcheck, was dem Paket in diesem Bundesland noch fehlt, mit Fundstelle im Landesrecht.',
      blocks: [
        {
          kind: 'text',
          title: 'Was ein Einreichplan ist',
          body: [
            'Der Einreichplan zeigt der Behörde das Vorhaben so, dass sie es nach Bau- und Raumordnungsrecht beurteilen kann. Er ist kein Ausführungsplan: Details der Konstruktion gehören meist nicht hinein, Lage, Höhen, Nutzungen und Abstände sehr wohl.',
            'Welche Zeichnungen und Beilagen verlangt sind, steht in der Bauordnung und teils in eigenen Verordnungen des Landes. Auch das Verfahren unterscheidet sich: Bauansuchen, Bauanzeige, Bauanmeldung, je nach Land und Vorhaben mit anderen Unterlagen.',
          ],
        },
        {
          kind: 'text',
          title: 'Wie Piloti dabei hilft',
          body: [
            'Die Arbeitsweise „Einreichcheck“ prüft, was einer Einreichung in diesem Bundesland noch fehlt: die Vollständigkeit des Pakets, mit Fundstelle im Landesrecht. Sie läuft auch als Aufgabe, etwa „Mach den Einreichcheck bis Freitag“, unter Ihrem Namen und mit Ihren Berechtigungen; das Ergebnis landet als offene Punkte im Projekt.',
          ],
        },
        {
          kind: 'list',
          title: 'Was in der Regel dazugehört',
          items: [
            'Lageplan mit Grundgrenzen, Nachbargrundstücken, Baulinien und Abständen.',
            'Grundrisse aller Geschoße, Schnitte und Ansichten mit Höhenangaben zum bestehenden und künftigen Gelände.',
            'Baubeschreibung mit Nutzung, Konstruktion und den Angaben, die das Land verlangt.',
            'Nachweise und Beilagen je nach Land und Vorhaben, etwa Grundbuchsauszug, Zustimmung der Grundeigentümer:innen, Energieausweis.',
            'Die Unterschriften, die das Landesrecht vorsieht, in der Regel von Bauwerber:in, Grundeigentümer:in und Planverfasser:in.',
          ],
        },
        {
          kind: 'text',
          title: 'Warum die Vollständigkeit so viel Zeit kostet',
          body: [
            'Fehlt eine Beilage, stellt die Behörde einen Verbesserungsauftrag, und das Verfahren steht, bis sie nachgereicht ist. Das kostet Wochen, die in keinem Terminplan stehen. Die Liste der Unterlagen ist nicht schwer, aber sie ist je Land anders und ändert sich mit Novellen, und genau das macht sie fehleranfällig.',
            'Wer in mehreren Bundesländern einreicht, kennt das: Die Checkliste aus dem letzten Projekt passt zum Land von damals.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Der Einreichcheck sagt, was dem Paket fehlt; ob das Vorhaben genehmigungsfähig ist, beurteilen Planung und Behörde. Einzelfragen dazu, etwa zur Gebäudeklasse oder zum Brandschutz, beantwortet Piloti getrennt, mit Fundstelle.',
          ],
        },
      ],
      faq: [
        {
          q: 'Was muss ein Einreichplan enthalten?',
          a: 'In der Regel Lageplan, Grundrisse aller Geschoße, Schnitte und Ansichten mit Höhenangaben sowie eine Baubeschreibung. Welche Zeichnungen und Beilagen genau verlangt sind, legt die Bauordnung des Bundeslandes fest, teils ergänzt durch eigene Verordnungen.',
        },
        {
          q: 'Wer darf Einreichpläne erstellen?',
          a: 'Das regelt das Landesrecht zusammen mit den Berufsrechten. In der Regel sind das Ziviltechniker:innen mit passender Befugnis, etwa Architekt:innen, sowie Baumeister:innen. Für kleine Vorhaben sehen manche Länder Erleichterungen vor.',
        },
        {
          q: 'Was ist der Unterschied zwischen Bauansuchen und Bauanzeige?',
          a: 'Beim Bauansuchen entscheidet die Behörde mit Bescheid über eine Baubewilligung. Die Bauanzeige ist für bestimmte, meist kleinere Vorhaben ein vereinfachtes Verfahren. Welche Vorhaben wohin gehören, legt jedes Land selbst fest.',
        },
        {
          q: 'Prüft Piloti, ob mein Einreichplan genehmigt wird?',
          a: 'Nein. Der Einreichcheck prüft die Vollständigkeit des Pakets für das Bundesland, nicht die Übereinstimmung des Entwurfs mit dem Baurecht. Einzelfragen dazu, etwa zur Gebäudeklasse oder zum Brandschutz, beantwortet Piloti getrennt, mit Fundstelle.',
        },
      ],
    },
    en: {
      title: 'Submission drawings (Einreichplan): contents in Austria',
      description:
        'What submission drawings (Einreichplan) contain: which drawings and documents an Austrian building application needs, and why it differs by state.',
      heading: 'What goes into submission drawings?',
      lede: 'Submission drawings are rarely rejected because the design is bad, but because something is missing. What belongs in them is set by the building code of the state the project is in. Piloti’s submission check shows what the package still lacks before the authority does.',
      answer:
        'The Einreichplan is the set of drawings submitted to the building authority with the building application or building notice, usually site plan, floor plans, sections and elevations with a building description; what exactly it must contain and which documents go with it is governed by the building code of the state concerned. Piloti’s submission check says what the package still lacks in that state, citing state law.',
      blocks: [
        {
          kind: 'text',
          title: 'What submission drawings are',
          body: [
            'The submission drawings show the authority the project so that it can assess it under building and spatial planning law. They are not construction drawings: construction details usually do not belong in them; position, heights, uses and distances do.',
            'Which drawings and attachments are required is set by the building code and sometimes by separate state regulations. The procedure differs too: building application, building notice, building registration, each with different documents depending on the state and the project.',
          ],
        },
        {
          kind: 'text',
          title: 'How Piloti helps',
          body: [
            'The “Einreichcheck” way of working checks what a submission in this state still lacks: the completeness of the package, citing state law. It also runs as a task, for example “Do the submission check by Friday”, under your name and with your permissions; the result lands as open points in the project.',
          ],
        },
        {
          kind: 'list',
          title: 'What usually belongs in them',
          items: [
            'Site plan with plot boundaries, neighbouring plots, building lines and distances.',
            'Floor plans of all storeys, sections and elevations with levels for existing and future ground.',
            'Building description with use, construction and the details the state requires.',
            'Evidence and attachments depending on state and project, such as a land register extract, owners’ consent, energy certificate.',
            'The signatures state law provides for, usually of applicant, landowner and responsible planner.',
          ],
        },
        {
          kind: 'text',
          title: 'Why completeness costs so much time',
          body: [
            'If an attachment is missing, the authority issues a request for rectification, and the procedure stands still until it is supplied. That costs weeks that are in no schedule. The list of documents is not hard, but it differs by state and changes with amendments, which is exactly what makes it error-prone.',
            'Anyone who submits in several states knows this: the checklist from the last project fits the state of back then.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'The submission check says what the package lacks; whether the project can be approved is for the design team and the authority to judge. Piloti answers individual questions on that, such as building class or fire safety, separately and with citations.',
          ],
        },
      ],
      faq: [
        {
          q: 'What must submission drawings contain?',
          a: 'Usually a site plan, floor plans of all storeys, sections and elevations with levels, and a building description. Exactly which drawings and attachments are required is set by the state’s building code, sometimes supplemented by separate regulations.',
        },
        {
          q: 'Who may prepare submission drawings?',
          a: 'State law governs this together with professional law. Usually these are chartered civil engineers or architects (Ziviltechniker:innen) with the matching authorisation, and master builders. Some states provide relief for small projects.',
        },
        {
          q: 'What is the difference between a building application and a building notice?',
          a: 'With a building application, the authority decides on a building permit by formal decision. The building notice is a simplified procedure for certain, usually smaller projects. Each state decides which projects go where.',
        },
        {
          q: 'Does Piloti check whether my submission will be approved?',
          a: 'No. The submission check covers the completeness of the package for the state, not whether the design complies with building law. Piloti answers individual questions on that, such as building class or fire safety, separately and with citations.',
        },
      ],
    },
  },
  {
    slug: 'aufenthaltsraum',
    checked: '2026-09',
    term: 'Aufenthaltsraum',
    related: ['anwendungen/aufenthaltsraum', 'glossar/oib-richtlinien', 'anwendungen/bestand', 'glossar/oberirdisches-geschoss'],
    de: {
      title: 'Aufenthaltsraum Definition: was OIB-RL 3 verlangt',
      description:
        'Aufenthaltsraum Definition nach OIB: welche Räume dazu zählen, was die OIB-Richtlinie 3 für sie regelt und warum Dachausbau und Souterrain daran hängen.',
      heading: 'Was ist ein Aufenthaltsraum?',
      lede: 'Ob ein Raum Aufenthaltsraum ist, entscheidet, was er können muss: Raumhöhe, Belichtung, Lüftung. Die Einordnung kommt deshalb vor jeder Anforderung, und genau dort wird am häufigsten abgekürzt. Piloti klärt die Einordnung zuerst und erst dann die Anforderung.',
      answer:
        'Ein Aufenthaltsraum ist ein Raum, der zum längeren Aufenthalt von Menschen bestimmt ist, etwa Wohn-, Schlaf- und Arbeitsräume; die Anforderungen an ihn, etwa an Raumhöhe, Belichtung und Lüftung, stehen in der OIB-Richtlinie 3 in der Ausgabe, die das Bundesland für verbindlich erklärt hat. Piloti klärt zuerst, ob ein Raum Aufenthaltsraum ist, und dann, was er erfüllen muss.',
      blocks: [
        {
          kind: 'text',
          title: 'Was der Begriff meint',
          body: [
            'Der Begriff unterscheidet Räume, in denen sich Menschen länger aufhalten, von Räumen, die sie nur kurz betreten. Wohnzimmer, Schlafzimmer, Kinderzimmer, Büros und Besprechungsräume sind typische Aufenthaltsräume. Bad, WC, Abstellraum, Gang und Stiegenhaus sind es in der Regel nicht.',
            'Definiert wird der Begriff in den OIB-Begriffsbestimmungen, die Anforderungen stehen in der OIB-Richtlinie 3 „Hygiene, Gesundheit und Umweltschutz“. Welche Ausgabe gilt, entscheidet das Bundesland; manche Bauordnungen und Bautechnikverordnungen ergänzen eigene Regeln. Lesen Sie Definition und Anforderung deshalb immer in der Fassung Ihres Landes.',
          ],
        },
        {
          kind: 'text',
          title: 'Wie Piloti dabei hilft',
          body: [
            'Die Arbeitsweise „Hygiene“ klärt zuerst, ob ein Raum nach der OIB-Richtlinie 3 ein Aufenthaltsraum ist, und erst dann, was er erfüllen muss, mit Fundstelle bis auf den Punkt. Fehlt die Nutzung des Raums, fragt Piloti danach. Bei einem Umbau stuft die Arbeitsweise „Bestand“ zuerst das Vorhaben ein.',
          ],
        },
        {
          kind: 'list',
          title: 'Was an der Einordnung hängt',
          items: [
            'Raumhöhe: Die OIB-Richtlinie 3 legt eine lichte Raumhöhe für Aufenthaltsräume fest, mit Regeln für Dachschrägen.',
            'Belichtung und Sichtverbindung: Aufenthaltsräume brauchen Tageslicht über Fenster in bestimmter Größe im Verhältnis zur Raumfläche.',
            'Lüftung: natürliche oder mechanische Lüftung nach den Vorgaben der Richtlinie.',
            'Die konkreten Werte stehen in der Richtlinie in der Fassung Ihres Landes. Wir nennen sie hier bewusst nicht, weil sie je nach Ausgabe und Raumsituation anders zu lesen sind.',
          ],
        },
        {
          kind: 'text',
          title: 'Wo es in der Praxis strittig wird',
          body: [
            'Der Dachausbau mit niedrigen Drempeln, das Souterrain am Hang, das Büro im Keller, die Wohnküche, die Galerie, das Homeoffice im ehemaligen Abstellraum: In all diesen Fällen hängt an der Frage „Aufenthaltsraum oder nicht?“ die ganze weitere Planung.',
            'Im Bestand kommt dazu, dass eine Nutzungsänderung einen Raum zum Aufenthaltsraum machen kann, der die Anforderungen nie erfüllen musste. Dann ist zuerst zu klären, ob das Vorhaben als Nutzungsänderung gilt und welche Anforderungen für den Bestand gelten.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Belichtungsflächen und Raumhöhen nimmt Piloti aus Ihrer Planung; es sagt, welche Anforderung gilt und welcher Wert dafür gebraucht wird. Die Verantwortung für den Entwurf bleibt beim Büro.',
          ],
        },
      ],
      faq: [
        {
          q: 'Was ist ein Aufenthaltsraum laut OIB?',
          a: 'Ein Raum, der zum längeren Aufenthalt von Menschen bestimmt ist, etwa zum Wohnen, Schlafen oder Arbeiten. Der Begriff steht in den OIB-Begriffsbestimmungen, die Anforderungen in der OIB-Richtlinie 3, jeweils in der Ausgabe, die im Bundesland gilt.',
        },
        {
          q: 'Ist eine Küche ein Aufenthaltsraum?',
          a: 'Das hängt von Größe und Nutzung ab. Eine Wohnküche, in der man sich länger aufhält, wird meist als Aufenthaltsraum behandelt; eine kleine Kochnische eher nicht. Maßgeblich sind die Definition in der Fassung Ihres Landes und die Nutzung in der Zeichnung.',
        },
        {
          q: 'Darf ein Kellerraum ein Aufenthaltsraum sein?',
          a: 'Grundsätzlich ja, wenn er die Anforderungen der OIB-Richtlinie 3 erfüllt, vor allem an Raumhöhe, Belichtung und Lüftung. Im Souterrain oder am Hang ist das oft erreichbar, im tiefen Keller selten.',
        },
        {
          q: 'Welche Raumhöhe braucht ein Aufenthaltsraum?',
          a: 'Die Mindesthöhe steht in der OIB-Richtlinie 3, mit eigenen Regeln für Räume unter Dachschrägen. Maßgeblich ist die Ausgabe, die Ihr Bundesland für verbindlich erklärt hat, samt allfälliger Abweichungen im Landesrecht.',
        },
      ],
    },
    en: {
      title: 'Habitable room (Aufenthaltsraum): OIB definition',
      description:
        'Habitable room (Aufenthaltsraum) under OIB: which rooms count, what OIB guideline 3 requires of them, and why roof conversions hinge on it.',
      heading: 'What is a habitable room?',
      lede: 'Whether a room is a habitable room decides what it must provide: ceiling height, daylight, ventilation. The classification therefore comes before any requirement, and that is exactly where corners get cut most often. Piloti settles the classification first and only then the requirement.',
      answer:
        'A habitable room (Aufenthaltsraum) is a room intended for people to stay in for longer periods, such as living rooms, bedrooms and workrooms; its requirements, for example on ceiling height, daylight and ventilation, are in OIB guideline 3 in the edition the state has declared binding. Piloti first settles whether a room is habitable and then what it must meet.',
      blocks: [
        {
          kind: 'text',
          title: 'What the term means',
          body: [
            'The term separates rooms where people stay for longer from rooms they only enter briefly. Living rooms, bedrooms, children’s rooms, offices and meeting rooms are typical habitable rooms. Bathrooms, WCs, storage rooms, corridors and staircases generally are not.',
            'The term is defined in the OIB definitions, and the requirements are in OIB guideline 3, “Hygiene, health and environmental protection”. The state decides which edition applies; some building codes and building-technology regulations add their own rules. So always read definition and requirement in your state’s version.',
          ],
        },
        {
          kind: 'text',
          title: 'How Piloti helps',
          body: [
            'The “Hygiene” way of working first clarifies whether a room is a habitable room under OIB guideline 3, and only then what it must meet, citing down to the clause. If the room’s use is missing, Piloti asks for it. For an alteration, the “Bestand” way of working first classifies the project.',
          ],
        },
        {
          kind: 'list',
          title: 'What depends on the classification',
          items: [
            'Ceiling height: OIB guideline 3 sets a clear ceiling height for habitable rooms, with rules for sloping ceilings.',
            'Daylight and view: habitable rooms need daylight through windows of a certain size relative to the floor area.',
            'Ventilation: natural or mechanical ventilation as the guideline requires.',
            'The specific values are in the guideline in your state’s version. We deliberately do not state them here, because they read differently depending on edition and room situation.',
          ],
        },
        {
          kind: 'text',
          title: 'Where it gets contested in practice',
          body: [
            'The roof conversion with low knee walls, the lower-ground room on a slope, the office in the basement, the kitchen-living room, the gallery, the home office in a former storage room: in all of these, the whole further design hinges on the question “habitable room or not?”.',
            'In existing buildings, a change of use can also turn a room into a habitable room that never had to meet the requirements. Then the first question is whether the project counts as a change of use and which requirements apply to the existing building.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti takes window areas and ceiling heights from your design; it says which requirement applies and which value is needed for it. Responsibility for the design stays with the office.',
          ],
        },
      ],
      faq: [
        {
          q: 'What is a habitable room under OIB?',
          a: 'A room intended for people to stay in for longer periods, for example for living, sleeping or working. The term is in the OIB definitions and the requirements in OIB guideline 3, each in the edition that applies in the state.',
        },
        {
          q: 'Is a kitchen a habitable room?',
          a: 'It depends on size and use. A kitchen-living room where people stay for longer is usually treated as a habitable room; a small kitchenette usually not. The definition in your state’s version and the use shown in the drawing decide.',
        },
        {
          q: 'Can a basement room be a habitable room?',
          a: 'In principle yes, if it meets the requirements of OIB guideline 3, above all on ceiling height, daylight and ventilation. For a lower-ground room or on a slope this is often achievable, in a deep basement rarely.',
        },
        {
          q: 'What ceiling height does a habitable room need?',
          a: 'The minimum height is set in OIB guideline 3, with separate rules for rooms under sloping ceilings. The edition your state has declared binding is what counts, along with any deviations in state law.',
        },
      ],
    },
  },
  {
    slug: 'brandabschnitt',
    checked: '2026-09',
    term: 'Brandabschnitt',
    related: ['anwendungen/brandschutz', 'glossar/gebaeudeklasse', 'glossar/oib-richtlinien', 'glossar/reihenhaus'],
    de: {
      title: 'Brandabschnitt Definition: was OIB-RL 2 regelt',
      description:
        'Brandabschnitt Definition: was ein Brandabschnitt nach OIB-Richtlinie 2 ist, wovon seine Größe abhängt und wie er sich von der Brandwand unterscheidet.',
      heading: 'Was ist ein Brandabschnitt?',
      lede: 'Ein Brand soll dort bleiben, wo er entsteht. Der Brandabschnitt ist das Werkzeug dafür, und die OIB-Richtlinie 2 sagt, wie groß er sein darf und was ihn begrenzen muss. Piloti prüft die Abschnittsbildung als Tabelle, mit Fundstelle und Ergebnis je Zeile.',
      answer:
        'Ein Brandabschnitt ist ein Bereich eines Gebäudes, der durch brandabschnittsbildende Wände und Decken von anderen Bereichen getrennt ist, damit sich ein Brand für eine bestimmte Zeit nicht ausbreitet; zulässige Größe und Anforderungen regelt die OIB-Richtlinie 2 abhängig von Gebäudeklasse und Nutzung. Piloti prüft die Anforderungen, sobald die Gebäudeklasse feststeht, mit Fundstelle und Ergebnis je Zeile.',
      blocks: [
        {
          kind: 'text',
          title: 'Was ein Brandabschnitt leistet',
          body: [
            'Ein Brandabschnitt begrenzt, wie viel eines Gebäudes ein Brand erfassen kann. Er wird von Wänden und Decken mit bestimmtem Feuerwiderstand gebildet, und jede Öffnung darin, jede Tür, jeder Schacht und jede Leitungsdurchführung, muss diesen Feuerwiderstand halten.',
            'Die Anforderungen stehen in der OIB-Richtlinie 2 „Brandschutz“, für Betriebsbauten und Garagen in eigenen Teilen. Welche Ausgabe gilt, entscheidet das Bundesland; laut OIB-Übersicht ist das nicht überall dieselbe.',
          ],
        },
        {
          kind: 'text',
          title: 'Wie Piloti dabei hilft',
          body: [
            'Die Arbeitsweise „Brandschutz“ behandelt Brandabschnitte, Fluchtwege und Feuerwiderstand, sobald die Gebäudeklasse feststeht. Sie trennt dabei, was die Richtlinie verlangt, von dem, ob dieses Gebäude es erfüllt, und zeigt die Prüfung als Tabelle mit Fundstelle und Ergebnis je Zeile, etwa „2 erfüllt · 1 offen“. Zwei Varianten der Abschnittsbildung stellt Piloti nebeneinander.',
          ],
        },
        {
          kind: 'list',
          title: 'Wovon Größe und Ausbildung abhängen',
          items: [
            'Von der Gebäudeklasse: Mit ihr steigen die Anforderungen an den Feuerwiderstand der trennenden Bauteile.',
            'Von der Nutzung: Wohnen, Büro, Betrieb, Garage haben unterschiedliche Regeln.',
            'Von der Fläche und bei manchen Nutzungen von der Ausdehnung des Abschnitts.',
            'Von der Fassade: Ein Brand darf nicht über die Außenwand in den nächsten Abschnitt überschlagen, dafür regelt die Richtlinie Abstände und Auskragungen.',
            'Die Grenzwerte stehen in den Tabellen der Richtlinie. Wir nennen sie hier nicht, weil sie je nach Ausgabe, Gebäudeklasse und Nutzung anders ausfallen.',
          ],
        },
        {
          kind: 'text',
          title: 'Was er nicht ist',
          body: [
            'Eine Brandwand ist ein Bauteil, der Brandabschnitt ist der Bereich dahinter. Brandwände verlangt die Richtlinie unter bestimmten Voraussetzungen auch an der Grundstücks- oder Bauplatzgrenze, das ist eine eigene Frage. Ein Fluchtweg wiederum regelt, wie Menschen aus dem Gebäude kommen, nicht wie weit der Brand kommt. Die drei Begriffe greifen ineinander, werden aber getrennt nachgewiesen.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Bei größeren oder besonderen Vorhaben gehören Brandschutzkonzept und Brandschutzplaner:in dazu; Piloti liefert die Anforderungen mit Fundstelle zu. Flächen nimmt es aus Ihren Unterlagen, statt sie in der Zeichnung zu messen.',
          ],
        },
      ],
      faq: [
        {
          q: 'Was ist ein Brandabschnitt?',
          a: 'Ein Bereich eines Gebäudes, der durch Wände und Decken mit festgelegtem Feuerwiderstand von anderen Bereichen getrennt ist. So soll ein Brand für eine bestimmte Zeit auf diesen Bereich begrenzt bleiben. Die Anforderungen stehen in der OIB-Richtlinie 2.',
        },
        {
          q: 'Wie groß darf ein Brandabschnitt sein?',
          a: 'Das legt die OIB-Richtlinie 2 abhängig von Nutzung und Gebäudeklasse fest, für Betriebsbauten und Garagen in eigenen Teilen. Maßgeblich ist die Ausgabe, die Ihr Bundesland für verbindlich erklärt hat. Größere Abschnitte sind meist nur mit zusätzlichen Maßnahmen oder einem Brandschutzkonzept möglich.',
        },
        {
          q: 'Was ist der Unterschied zwischen Brandabschnitt und Brandwand?',
          a: 'Die Brandwand ist ein Bauteil mit hohem Feuerwiderstand, der Brandabschnitt ist der Bereich, den solche Bauteile begrenzen. Nicht jede brandabschnittsbildende Wand muss eine Brandwand sein; welche Anforderung gilt, steht in der OIB-Richtlinie 2.',
        },
        {
          q: 'Wer legt die Brandabschnitte fest?',
          a: 'Die Planung, bei größeren oder besonderen Vorhaben mit einer Brandschutzplaner:in und einem Brandschutzkonzept. Die Baubehörde prüft im Verfahren, ob die Anforderungen des Landesrechts und der verbindlichen OIB-Richtlinie erfüllt sind.',
        },
      ],
    },
    en: {
      title: 'Fire compartment (Brandabschnitt): OIB definition',
      description:
        'Fire compartment (Brandabschnitt) definition: what it is under OIB guideline 2, what its size depends on, and how it differs from a fire wall.',
      heading: 'What is a fire compartment?',
      lede: 'A fire should stay where it starts. The fire compartment is the tool for that, and OIB guideline 2 says how large it may be and what must bound it. Piloti checks the compartmentation as a table, with a citation and a result per row.',
      answer:
        'A fire compartment (Brandabschnitt) is an area of a building separated from other areas by compartment-forming walls and floors so that a fire does not spread for a set time; OIB guideline 2 governs its permitted size and requirements depending on building class and use. Piloti checks the requirements once the building class stands, with a citation and a result per row.',
      blocks: [
        {
          kind: 'text',
          title: 'What a fire compartment does',
          body: [
            'A fire compartment limits how much of a building a fire can reach. It is formed by walls and floors of a set fire resistance, and every opening in them, every door, shaft and service penetration, must keep that fire resistance.',
            'The requirements are in OIB guideline 2, “Fire safety”, with separate parts for industrial buildings and garages. The state decides which edition applies; per the OIB overview, it is not the same everywhere.',
          ],
        },
        {
          kind: 'text',
          title: 'How Piloti helps',
          body: [
            'The “Brandschutz” way of working covers fire compartments, escape routes and fire resistance once the building class stands. It separates what the guideline demands from whether this building meets it, and shows the check as a table with a citation and a result per row, for example “2 met · 1 open”. Piloti sets two compartment layouts side by side.',
          ],
        },
        {
          kind: 'list',
          title: 'What size and design depend on',
          items: [
            'On the building class: the fire resistance required of the separating elements rises with it.',
            'On the use: housing, office, industry and garages have different rules.',
            'On the area and, for some uses, on the extent of the compartment.',
            'On the facade: a fire must not leap across the outer wall into the next compartment, so the guideline sets distances and projections.',
            'The limits are in the guideline’s tables. We do not state them here, because they differ by edition, building class and use.',
          ],
        },
        {
          kind: 'text',
          title: 'What it is not',
          body: [
            'A fire wall is a building element; the fire compartment is the area behind it. Under certain conditions the guideline also requires fire walls at the plot boundary, which is a separate question. An escape route, in turn, governs how people get out of the building, not how far the fire gets. The three terms interlock but are demonstrated separately.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Larger or special projects call for a fire safety concept and a fire safety engineer; Piloti supplies the requirements with their citations. It takes areas from your documents instead of measuring them in the drawing.',
          ],
        },
      ],
      faq: [
        {
          q: 'What is a fire compartment?',
          a: 'An area of a building separated from other areas by walls and floors of a set fire resistance. That keeps a fire confined to the area for a set time. The requirements are in OIB guideline 2.',
        },
        {
          q: 'How large may a fire compartment be?',
          a: 'OIB guideline 2 sets that depending on use and building class, with separate parts for industrial buildings and garages. The edition your state has declared binding is what counts. Larger compartments are usually possible only with additional measures or a fire safety concept.',
        },
        {
          q: 'What is the difference between a fire compartment and a fire wall?',
          a: 'The fire wall is a building element with high fire resistance; the fire compartment is the area such elements bound. Not every compartment-forming wall has to be a fire wall; which requirement applies is set in OIB guideline 2.',
        },
        {
          q: 'Who defines the fire compartments?',
          a: 'The design team, for larger or special projects with a fire safety engineer and a fire safety concept. In the procedure, the building authority checks whether the requirements of state law and the binding OIB guideline are met.',
        },
      ],
    },
  },
  {
    slug: 'reihenhaus',
    checked: '2026-09',
    term: 'Reihenhaus',
    related: ['glossar/gebaeudeklasse', 'glossar/fluchtniveau', 'glossar/brandabschnitt', 'anwendungen/gebaeudeklasse'],
    de: {
      title: 'Reihenhaus: Definition und Gebäudeklasse nach OIB',
      description:
        'Reihenhaus und Gebäudeklasse: was nach den OIB-Begriffsbestimmungen als Reihenhaus gilt, warum ein Doppelhaus keines ist und wie das Fluchtniveau zählt.',
      heading: 'Was ist ein Reihenhaus nach OIB?',
      lede: 'Im Alltag ist jedes Haus in einer Reihe ein Reihenhaus. Für die OIB-Richtlinien ist es ein Begriff mit fünf Bedingungen, und von ihm hängt ab, ob das Projekt in Gebäudeklasse 2 fällt. Piloti prüft die fünf Bedingungen einzeln gegen Ihr Projekt.',
      note: 'Definition laut OIB-Richtlinien, Begriffsbestimmungen, Ausgabe Mai 2023.',
      answer:
        'Ein Reihenhaus ist nach den OIB-Begriffsbestimmungen ein Gebäude mit mehr als zwei unmittelbar aneinander gebauten, nicht übereinander angeordneten, durch eine vertikale Wand getrennten Wohnungen oder Betriebseinheiten von je höchstens 400 m² Brutto-Grundfläche, jede mit eigenem Eingang aus dem Freien; für die Gebäudeklasse wird das Fluchtniveau jeder Einheit gesondert betrachtet. Piloti prüft die Bedingungen gegen Ihr Projekt und stuft die Gebäudeklasse ein.',
      blocks: [
        {
          kind: 'definition',
          term: 'Reihenhaus',
          text: '„Gebäude mit mehr als zwei unmittelbar aneinander gebauten, nicht übereinander angeordneten, durch mindestens eine vertikale Wand voneinander getrennten selbstständigen Wohnungen bzw. Betriebseinheiten von jeweils nicht mehr als 400 m² Brutto-Grundfläche der oberirdischen Geschoße und mit jeweils einem eigenen Eingang aus dem Freien für jede Wohnung bzw. Betriebseinheit. Für die Einstufung in eine Gebäudeklasse gemäß der OIB-Richtlinie 2 ist jede Wohnung bzw. Betriebseinheit hinsichtlich des Fluchtniveaus gesondert zu betrachten.“',
          source: OIB_DEFS,
          sourceUrl: OIB_URL,
        },
        {
          kind: 'text',
          title: 'Wie Piloti dabei hilft',
          body: [
            'Piloti prüft die Bedingungen der Definition gegen Ihr Projekt und stuft die Gebäudeklasse ein, mit Fundstelle. Fehlt ein Wert, etwa die Fläche einer Einheit oder das Fluchtniveau des höchsten Hauses, fragt es danach. Die Anforderungen an die Wände zwischen den Einheiten klärt anschließend die Arbeitsweise „Brandschutz“.',
          ],
        },
        {
          kind: 'list',
          title: 'Die Bedingungen, einzeln gelesen',
          items: [
            'Mehr als zwei Einheiten: Ein Doppelhaus mit zwei Einheiten ist nach dieser Definition kein Reihenhaus.',
            'Unmittelbar aneinander gebaut und nicht übereinander: Gestapelte Maisonetten fallen nicht darunter, auch wenn sie von außen wie eine Reihe aussehen.',
            'Durch mindestens eine vertikale Wand getrennt und selbstständig: jede Einheit für sich, nicht Teile einer gemeinsamen Wohnung.',
            'Je höchstens 400 m² Brutto-Grundfläche der oberirdischen Geschoße: Eine einzige größere Einheit nimmt der ganzen Reihe den Status.',
            'Ein eigener Eingang aus dem Freien für jede Einheit: Ein gemeinsames Stiegenhaus passt nicht zur Definition.',
          ],
        },
        {
          kind: 'text',
          title: 'Was das für die Gebäudeklasse heißt',
          body: [
            'Die Definition der Gebäudeklasse 2 nennt Reihenhäuser ausdrücklich: mit höchstens drei oberirdischen Geschoßen, einem Fluchtniveau von höchstens 7,00 m und Einheiten von je höchstens 400 m² Brutto-Grundfläche. Anders als bei anderen Gebäuden kommt es dabei nicht auf die Gesamtfläche der Reihe an, sondern auf die Fläche jeder Einheit.',
            'Das Fluchtniveau wird für jede Einheit gesondert betrachtet. Am Hang kann eine Reihe deshalb Häuser mit unterschiedlichem Fluchtniveau haben, und die Frage, ob die Reihe als Ganzes die Bedingungen erfüllt, ist Haus für Haus zu beantworten.',
          ],
        },
        {
          kind: 'text',
          title: 'Reihenhaus ist nicht geschlossene Bauweise',
          body: [
            'Bebauungspläne sprechen von offener, gekuppelter oder geschlossener Bauweise. Das ist Bebauungsrecht des Landes und der Gemeinde und sagt, wie an die Grundgrenze gebaut wird. Ob ein Gebäude im Sinn der OIB-Richtlinien ein Reihenhaus ist, entscheidet allein die Definition oben. Beide Fragen sind getrennt zu klären.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Flächen und Höhen nimmt Piloti aus Ihren Unterlagen, die Einstufung bleibt Ihre Entscheidung. Die Bauweise nach dem Bebauungsplan liest es aus dem Bebauungsplan, sobald er im Projekt liegt.',
          ],
        },
      ],
      faq: [
        {
          q: 'Ist ein Doppelhaus ein Reihenhaus?',
          a: 'Nach den OIB-Begriffsbestimmungen nicht: Ein Reihenhaus verlangt mehr als zwei aneinander gebaute Einheiten. Ein Doppelhaus mit zwei Einheiten wird daher nach den allgemeinen Regeln der Gebäudeklassen eingestuft.',
        },
        {
          q: 'Welche Gebäudeklasse hat ein Reihenhaus?',
          a: 'Mit höchstens drei oberirdischen Geschoßen, einem Fluchtniveau von höchstens 7,00 m und Einheiten von je höchstens 400 m² Brutto-Grundfläche fällt es in Gebäudeklasse 2. Überschreitet eine Einheit diese Werte, ist die Einstufung neu zu prüfen.',
        },
        {
          q: 'Wie wird das Fluchtniveau beim Reihenhaus gemessen?',
          a: 'Für jede Wohnung oder Betriebseinheit gesondert, so sagt es die Definition ausdrücklich. Gemessen wird wie sonst von der Fußbodenoberkante des höchsten oberirdischen Geschoßes zum angrenzenden Gelände nach Fertigstellung, im Mittel.',
        },
        {
          q: 'Welche Anforderungen gelten für die Wände zwischen Reihenhäusern?',
          a: 'Die stehen in der OIB-Richtlinie 2 in der Ausgabe, die im Bundesland gilt, abhängig von der Gebäudeklasse. Dazu kann das Landesrecht weitere Anforderungen stellen, etwa zum Schallschutz nach OIB-Richtlinie 5.',
        },
      ],
    },
    en: {
      title: 'Row house: definition and building class under OIB',
      description:
        'Row house (Reihenhaus) and building class: what counts as a row house under OIB, why a semi-detached pair does not, and how the escape level counts.',
      heading: 'What is a row house under OIB?',
      lede: 'In everyday speech, every house in a row is a row house. For the OIB guidelines it is a term with five conditions, and it decides whether the project falls into building class 2. Piloti checks the five conditions one by one against your project.',
      note: 'Definition from the OIB-Richtlinien, Begriffsbestimmungen, May 2023 edition, in our own translation.',
      answer:
        'Under the OIB definitions, a row house (Reihenhaus) is a building with more than two dwellings or business units built directly against each other, not stacked, separated by a vertical wall, each with no more than 400 m² gross floor area and its own entrance from outside; for the building class, the escape level of each unit is considered separately. Piloti checks the conditions against your project and classifies the building class.',
      blocks: [
        {
          kind: 'definition',
          term: 'Row house (Reihenhaus)',
          text: '“Building with more than two self-contained dwellings or business units built directly against each other, not arranged one above the other, separated from each other by at least one vertical wall, each with no more than 400 m² gross floor area of the above-ground storeys and each with its own entrance from outside for every dwelling or business unit. For classification into a building class under OIB guideline 2, each dwelling or business unit is to be considered separately with regard to the escape level.”',
          source: OIB_DEFS_EN,
          sourceUrl: OIB_URL,
        },
        {
          kind: 'text',
          title: 'How Piloti helps',
          body: [
            'Piloti checks the conditions of the definition against your project and classifies the building class, with the citation. If a value is missing, such as a unit’s area or the escape level of the highest house, it asks for it. The “Brandschutz” way of working then clarifies the requirements for the walls between the units.',
          ],
        },
        {
          kind: 'list',
          title: 'The conditions, read one by one',
          items: [
            'More than two units: a semi-detached pair with two units is not a row house under this definition.',
            'Built directly against each other and not stacked: stacked maisonettes do not qualify, even if they look like a row from outside.',
            'Separated by at least one vertical wall and self-contained: each unit on its own, not parts of a shared dwelling.',
            'No more than 400 m² gross floor area of the above-ground storeys each: a single larger unit costs the whole row its status.',
            'Its own entrance from outside for every unit: a shared staircase does not fit the definition.',
          ],
        },
        {
          kind: 'text',
          title: 'What this means for the building class',
          body: [
            'The definition of building class 2 expressly names row houses: with no more than three above-ground storeys, an escape level of no more than 7.00 m and units of no more than 400 m² gross floor area each. Unlike other buildings, what counts is not the total area of the row but the area of each unit.',
            'The escape level is considered separately for each unit. On a slope, a row can therefore contain houses with different escape levels, and whether the row as a whole meets the conditions has to be answered house by house.',
          ],
        },
        {
          kind: 'text',
          title: 'Row house is not closed building pattern',
          body: [
            'Development plans speak of open, semi-detached or closed building patterns. That is state and municipal plot development law and says how one builds to the plot boundary. Whether a building is a row house in the sense of the OIB guidelines is decided by the definition above alone. The two questions have to be settled separately.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti takes areas and heights from your documents; the classification remains your decision. It reads the building pattern under the development plan as soon as it is in the project.',
          ],
        },
      ],
      faq: [
        {
          q: 'Is a semi-detached pair a row house?',
          a: 'Not under the OIB definitions: a row house requires more than two units built against each other. A semi-detached pair with two units is therefore classified under the general building class rules.',
        },
        {
          q: 'Which building class is a row house?',
          a: 'With no more than three above-ground storeys, an escape level of no more than 7.00 m and units of no more than 400 m² gross floor area each, it falls into building class 2. If a unit exceeds these values, the classification has to be checked again.',
        },
        {
          q: 'How is the escape level measured for a row house?',
          a: 'Separately for each dwelling or business unit, as the definition expressly says. It is measured as usual from the top of the floor of the highest above-ground storey to the adjoining ground after completion, on average.',
        },
        {
          q: 'What requirements apply to the walls between row houses?',
          a: 'They are in OIB guideline 2 in the edition that applies in the state, depending on the building class. State law can add further requirements, for example on sound insulation under OIB guideline 5.',
        },
      ],
    },
  },
]
