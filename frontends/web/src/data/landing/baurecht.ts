/**
 * The nine state pages under /baurecht/. Which laws each page names comes from
 * the curated RIS register (`configs/norms/at/registry.yml`); the OIB edition
 * status from the OIB overview „Inkrafttreten der OIB-Richtlinien“
 * (https://www.oib.or.at/de/inkrafttreten-der-oib-rl): the 2023 edition as of
 * September 2025, RL 6 edition 2025 as of July 2026. When either changes, the
 * page changes with it, and `checked` moves.
 */
import type { LandingEntry } from '../../lib/landing'

export const baurecht: LandingEntry[] = [
  // ---------------------------------------------------------------- Wien
  {
    slug: 'wien',
    checked: '2026-09',
    related: ['baurecht/niederoesterreich', 'glossar/oib-richtlinien', 'glossar/ris', 'anwendungen/einreichcheck', 'anwendungen/bebauung'],
    de: {
      title: 'Bauordnung Wien und OIB-Richtlinien: Baurecht mit KI',
      description:
        'Bauordnung für Wien, Bautechnikverordnung 2023, Garagen- und Kleingartengesetz: welche OIB-Richtlinien in Wien gelten und wie Piloti Wiener Fragen belegt.',
      heading: 'Baurecht in Wien: Bauordnung für Wien, WBTV 2023 und OIB-Richtlinien',
      lede: 'In Wien steht das Baurecht für ein Projekt selten in einem einzigen Text. Die Bauordnung regelt Widmung und Verfahren, die Bautechnikverordnung macht die OIB-Richtlinien verbindlich, Garagen und Kleingärten haben eigene Gesetze, und die MA 37 legt in Merkblättern aus, wie sie das alles liest.',
      note: 'OIB-Stand laut OIB-Übersicht „Inkrafttreten der OIB-Richtlinien“: Ausgabe 2023 Stand September 2025, RL 6 Ausgabe 2025 Stand Juli 2026. Gesetzestexte aus dem RIS.',
      answer:
        'In Wien gelten die Bauordnung für Wien und die Wiener Bautechnikverordnung 2023, die die OIB-Richtlinien verbindlich macht. Laut OIB-Übersicht (Stand: September 2025) gelten die OIB-Richtlinien 1 bis 6 in der Ausgabe 2023 seit 23.2.2024, die OIB-Richtlinie 6 Ausgabe 2025 laut Übersicht (Stand: Juli 2026) seit 15.7.2026.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was in Wien gilt',
          body: 'Diese Wiener Texte zieht Piloti aus dem RIS heran, jeweils mit Fundstelle. Dazu kommt Bundesrecht wie ASchG, Arbeitsstättenverordnung oder Denkmalschutzgesetz, wo das Projekt es berührt.',
          items: [
            {
              name: 'Bauordnung für Wien',
              body: 'Das Stadtentwicklungs-, Stadtplanungs- und Baugesetzbuch: Widmung, Bauklassen, Bauansuchen und Baubewilligung. Der erste Text für fast jede Wiener Frage.',
            },
            {
              name: 'Wiener Bautechnikverordnung 2023',
              body: 'Erklärt die OIB-Richtlinien in ihren Anlagen für einzuhalten, mit einzelnen Ausnahmen, und lässt Abweichungen zu, wenn das gleiche Schutzniveau erreicht wird. Wer in Wien eine OIB-Anforderung zitiert, prüft hier Ausgabe und Abweichungen.',
            },
            {
              name: 'Wiener Garagengesetz 2008',
              body: 'Bau von Garagen und die Pflicht, Stellplätze zu schaffen. Die Stellplatzfrage eines Wohnbaus beantwortet dieses Gesetz, nicht die Bauordnung.',
            },
            {
              name: 'Wiener Kleingartengesetz 1996',
              body: 'Gilt in Kleingartengebieten und tritt dort an die Stelle wesentlicher Teile der Bauordnung.',
            },
            {
              name: 'Merkblätter der MA 37',
              body: 'Merkblätter, Weisungen und Checklisten der Baupolizei zu Einreichung und Auslegung. Sie ergänzen Bauordnung und OIB-Richtlinien und begründen keine neuen Pflichten.',
            },
            {
              name: 'OIB-Richtlinien',
              body: 'RL 1–6 Ausgabe 2023 laut OIB-Übersicht seit 23.2.2024 verbindlich, die RL 6 Ausgabe 2025 laut Übersicht seit 15.7.2026.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Zwei Ausgaben der RL 6',
          body: [
            'Für Energieeinsparung und Wärmeschutz hat Wien 2026 die Ausgabe gewechselt: Laut OIB-Übersicht gilt die OIB-Richtlinie 6 Ausgabe 2025 seit 15.7.2026, die Richtlinien 1 bis 5 bleiben in der Ausgabe 2023. Welche Fassung ein Verfahren trifft, das um diesen Tag herum eingereicht wurde, entscheidet das Übergangsrecht, und das steht in der Bautechnikverordnung, nicht in der Richtlinie.',
            'Piloti nennt deshalb bei jeder Anforderung aus der RL 6 die Ausgabe, aus der der Wert stammt. Steht im Projekt kein Einreichdatum, fragt es danach oder schreibt dazu, welche Ausgabe es angenommen hat.',
          ],
        },
        {
          kind: 'steps',
          title: 'So beantwortet Piloti eine Wiener Frage',
          items: [
            {
              name: 'Quelle wählen',
              body: 'Die Stellplatzfrage geht ins Garagengesetz, die Laube im Kleingarten ins Kleingartengesetz, der Fluchtweg über die Bautechnikverordnung in die OIB-Richtlinie 2. Fehlt im Projekt das Bundesland, fragt Piloti einmal nach.',
            },
            {
              name: 'Zitieren wie ein Bescheid',
              body: 'Die Fundstelle steht so da, wie die Behörde sie schreibt, etwa „Bauordnung für Wien, § …“ oder „OIB-RL 2, Pkt. …“. Bevor sie erscheint, prüft Piloti sie gegen den Quelltext.',
            },
            {
              name: 'Im RIS öffnen',
              body: 'Ein Klick öffnet die zitierte Stelle aus dem RIS in Piloti, markiert. Sie lesen den Absatz, nicht eine Zusammenfassung davon.',
            },
            {
              name: 'Praxis getrennt nennen',
              body: 'Hat die MA 37 zu der Frage ein Merkblatt, stellt Piloti es neben das Gesetz, ausgewiesen als Auslegung der Behörde und nie als Norm.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti in Wien aufhört',
          items: [
            'Piloti ersetzt weder die MA 37 noch eine Auskunft der Baupolizei. Ob bewilligt wird, entscheidet die Behörde.',
            'Was Flächenwidmungs- und Bebauungsplan für Ihr Grundstück festsetzen, weiß Piloti nur, wenn der Plan im Projekt liegt. Sonst sagt es, dass er fehlt und wo Sie nachsehen.',
            'Ausnahmen und Übergangsbestimmungen der Wiener Bautechnikverordnung prüfen Sie für Ihr Verfahren selbst. Piloti weist darauf hin, entscheidet sie aber nicht.',
            'Ein Merkblatt ist Verwaltungspraxis. Piloti zitiert es so, und wo es vom Gesetzestext abzuweichen scheint, gilt der Gesetzestext.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche OIB-Richtlinien gelten in Wien?',
          a: 'Laut OIB-Übersicht (Stand: September 2025) gelten in Wien die OIB-Richtlinien 1 bis 6 in der Ausgabe 2023, verbindlich seit 23.2.2024. Für die RL 6 gilt laut Übersicht (Stand: Juli 2026) seit 15.7.2026 die Ausgabe 2025. Verbindlich macht sie die Wiener Bautechnikverordnung 2023; dort stehen auch Ausnahmen und Übergangsregeln.',
        },
        {
          q: 'Wo finde ich die Bauordnung für Wien im Volltext?',
          a: 'Im Rechtsinformationssystem des Bundes (RIS), kostenlos und in der geltenden Fassung. Dort stehen auch Bautechnikverordnung, Garagengesetz und Kleingartengesetz. Piloti öffnet eine zitierte Stelle direkt aus dem RIS, markiert.',
        },
        {
          q: 'Kann Piloti Fragen zur Bauordnung für Wien beantworten?',
          a: 'Ja. Piloti beantwortet Fragen zu einem Wiener Projekt aus Bauordnung, Bautechnikverordnung, Garagengesetz, Kleingartengesetz und OIB-Richtlinien, mit geprüfter Fundstelle, und nennt Merkblätter der MA 37 als Praxis dazu. Die Antwort ist eine belegte Arbeitsgrundlage, keine behördliche Auskunft.',
        },
        {
          q: 'Gilt die Bauordnung für Wien auch im Kleingarten?',
          a: 'Nur zum Teil. In Kleingartengebieten gilt das Wiener Kleingartengesetz 1996 und tritt an die Stelle wesentlicher Teile der Bauordnung. Piloti zieht bei einem Projekt im Kleingarten deshalb zuerst dieses Gesetz heran und wendet Regeln der Bauordnung oder der OIB-Richtlinien dort nicht ungeprüft an.',
        },
      ],
    },
    en: {
      title: 'Vienna building code and OIB guidelines: AI for building law',
      description:
        'Bauordnung für Wien, building technology ordinance 2023, garage and allotment acts: which OIB guidelines apply in Vienna and how Piloti cites answers.',
      heading: 'Building law in Vienna: Bauordnung für Wien, WBTV 2023 and OIB guidelines',
      lede: 'In Vienna the building law for a project rarely sits in one text. The building code governs zoning and procedure, the building technology ordinance makes the OIB guidelines binding, garages and allotment gardens have their own acts, and MA 37 explains in its information sheets how it reads all of that.',
      note: 'OIB status per the OIB overview “Inkrafttreten der OIB-Richtlinien”: 2023 edition as of September 2025, RL 6 edition 2025 as of July 2026. Legal texts from RIS.',
      answer:
        'Vienna applies the Bauordnung für Wien and the Wiener Bautechnikverordnung 2023, which makes the OIB guidelines binding. According to the OIB overview (as of September 2025), OIB guidelines 1 to 6 in the 2023 edition have applied since 23 February 2024, and according to the overview (as of July 2026) OIB guideline 6, edition 2025, since 15 July 2026.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What applies in Vienna',
          body: 'Piloti draws these Vienna texts from RIS, each with its citation. Federal law such as the ASchG, the workplace ordinance or the monuments act comes in where the project touches it.',
          items: [
            {
              name: 'Bauordnung für Wien',
              body: 'Vienna’s urban development, planning and building code: zoning, building classes (Bauklassen), applications and permits. The first text for almost every Vienna question.',
            },
            {
              name: 'Wiener Bautechnikverordnung 2023',
              body: 'Declares the OIB guidelines in its annexes binding, with some exceptions, and allows deviations that reach the same level of protection. Anyone citing an OIB requirement in Vienna checks the edition and the deviations here.',
            },
            {
              name: 'Wiener Garagengesetz 2008',
              body: 'Garage construction and the duty to provide parking spaces. The parking question of a housing project is answered by this act, not by the building code.',
            },
            {
              name: 'Wiener Kleingartengesetz 1996',
              body: 'Applies in allotment-garden zones and replaces substantial parts of the building code there.',
            },
            {
              name: 'MA 37 information sheets',
              body: 'Information sheets, instructions and checklists of Vienna’s building authority on submissions and interpretation. They supplement the building code and the OIB guidelines and create no new duties.',
            },
            {
              name: 'OIB guidelines',
              body: 'RL 1–6, 2023 edition, binding since 23 February 2024 according to the OIB overview; RL 6, edition 2025, since 15 July 2026 according to the overview.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Two editions of RL 6',
          body: [
            'For energy saving and thermal protection Vienna changed edition in 2026: according to the OIB overview, OIB guideline 6, edition 2025, has applied since 15 July 2026, while guidelines 1 to 5 stay in the 2023 edition. Which version governs a procedure filed around that date is a question of transition law, and that sits in the building technology ordinance, not in the guideline.',
            'Piloti therefore names the edition a value comes from for every RL 6 requirement. If the project has no submission date, it asks for one or states which edition it assumed.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti answers a Vienna question',
          items: [
            {
              name: 'Choose the source',
              body: 'The parking question goes to the garage act, the shed in an allotment garden to the allotment act, the escape route through the building technology ordinance to OIB guideline 2. If the project has no state, Piloti asks once.',
            },
            {
              name: 'Cite like a permit',
              body: 'The citation reads the way the authority writes it, such as “Bauordnung für Wien, § …” or “OIB-RL 2, Pkt. …”. Before it appears, Piloti checks it against the source text.',
            },
            {
              name: 'Open it in RIS',
              body: 'One click opens the cited passage from RIS inside Piloti, marked. You read the paragraph, not a summary of it.',
            },
            {
              name: 'Keep practice separate',
              body: 'If MA 37 has an information sheet on the question, Piloti places it next to the law, labelled as the authority’s interpretation and never as a rule.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops in Vienna',
          items: [
            'Piloti replaces neither MA 37 nor information from the building authority. Whether a permit is granted is the authority’s decision.',
            'What the zoning and development plan fixes for your plot, Piloti only knows if the plan is in the project. Otherwise it says the plan is missing and where to look.',
            'You check the exceptions and transition rules of the Wiener Bautechnikverordnung for your procedure yourself. Piloti points to them but does not decide them.',
            'An information sheet is administrative practice. Piloti cites it as such, and where it seems to depart from the legal text, the legal text governs.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which OIB guidelines apply in Vienna?',
          a: 'According to the OIB overview (as of September 2025), Vienna applies OIB guidelines 1 to 6 in the 2023 edition, binding since 23 February 2024. For RL 6, the overview (as of July 2026) lists the 2025 edition as applying since 15 July 2026. The Wiener Bautechnikverordnung 2023 makes them binding and also holds the exceptions and transition rules.',
        },
        {
          q: 'Where can I read the Bauordnung für Wien in full?',
          a: 'In the federal legal information system (RIS), free of charge and in its current version. The building technology ordinance, the garage act and the allotment act are there too. Piloti opens a cited passage straight from RIS, marked.',
        },
        {
          q: 'Can Piloti answer questions on the Vienna building code?',
          a: 'Yes. Piloti answers questions on a Vienna project from the building code, the building technology ordinance, the garage act, the allotment act and the OIB guidelines, with a checked citation, and names MA 37 information sheets as practice alongside. The answer is a documented working basis, not an official ruling.',
        },
        {
          q: 'Does the Vienna building code apply in allotment gardens?',
          a: 'Only in part. In allotment-garden zones the Wiener Kleingartengesetz 1996 applies and replaces substantial parts of the building code. For a project in an allotment garden Piloti therefore turns to that act first and does not apply building-code or OIB rules there unchecked.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------- Niederösterreich
  {
    slug: 'niederoesterreich',
    checked: '2026-09',
    related: ['baurecht/wien', 'baurecht/burgenland', 'baurecht/oberoesterreich', 'glossar/oib-richtlinien', 'glossar/ris', 'anwendungen/einreichcheck', 'anwendungen/bebauung'],
    de: {
      title: 'NÖ Bauordnung 2014 und OIB-Richtlinien: Baurecht mit KI',
      description:
        'Bauordnung Niederösterreich: NÖ Bauordnung 2014, OIB-Richtlinien 2023 seit 18.3.2025 und der Bebauungsplan der Gemeinde. Wie Piloti Fragen dazu belegt.',
      heading: 'Baurecht in Niederösterreich: NÖ Bauordnung 2014 und OIB-Richtlinien',
      lede: 'In Niederösterreich entscheiden zwei Ebenen über ein Projekt: die NÖ Bauordnung 2014 für das ganze Land und der Bebauungsplan der Gemeinde für das einzelne Grundstück. Piloti arbeitet mit der ersten aus dem RIS und mit der zweiten, sobald sie im Projekt liegt.',
      note: 'OIB-Stand laut OIB-Übersicht „Inkrafttreten der OIB-Richtlinien“: Ausgabe 2023 Stand September 2025, RL 6 Ausgabe 2025 Stand Juli 2026. Gesetzestext aus dem RIS.',
      answer:
        'In Niederösterreich gilt die NÖ Bauordnung 2014. Laut OIB-Übersicht (Stand: September 2025) sind dort die OIB-Richtlinien 1 bis 6 in der Ausgabe 2023 seit 18.3.2025 verbindlich; die OIB-Richtlinie 6 Ausgabe 2025 ist laut Übersicht (Stand: Juli 2026) in Niederösterreich nicht in Kraft.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was in Niederösterreich gilt',
          body: 'Im Register von Piloti steht für Niederösterreich das Landesgesetz, dazu die OIB-Richtlinien und Bundesrecht, wo ein Projekt es berührt.',
          items: [
            {
              name: 'NÖ Bauordnung 2014',
              body: 'Bauansuchen, Baubewilligung und die Regeln, an die der Bebauungsplan der Gemeinde anknüpft. Die Grundlage jeder Antwort zu einem Projekt in Niederösterreich.',
            },
            {
              name: 'OIB-Richtlinien 1–6',
              body: 'Ausgabe 2023, laut OIB-Übersicht seit 18.3.2025 verbindlich, alle sechs am selben Tag.',
            },
            {
              name: 'OIB-Richtlinie 6 Ausgabe 2025',
              body: 'Laut OIB-Übersicht (Stand: Juli 2026) in Niederösterreich nicht in Kraft. Für Energieeinsparung und Wärmeschutz bleibt es damit bei der Ausgabe 2023.',
            },
            {
              name: 'Bundesrecht',
              body: 'ASchG und Arbeitsstättenverordnung für Arbeitsstätten, die Gewerbeordnung für Betriebsanlagen, das Denkmalschutzgesetz: gilt neben der Bauordnung, mit eigenem Verfahren.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Der Bebauungsplan entscheidet mit',
          body: [
            'Viele Fragen zu einem Grundstück in Niederösterreich beantwortet nicht die Bauordnung allein. Was dort gebaut werden darf, hängt am Bebauungsplan der Gemeinde, und den erlässt jede Gemeinde für sich.',
            'Piloti trennt deshalb: Was die NÖ Bauordnung 2014 allgemein regelt, belegt es mit Fundstelle. Was nur der Bebauungsplan festlegen kann, liest es aus dem Plan, wenn er im Projekt liegt. Fehlt er, sagt Piloti das, statt einen Wert zu raten, und nennt die Baubehörde der Gemeinde als Stelle, die ihn hat.',
          ],
        },
        {
          kind: 'steps',
          title: 'So arbeitet Piloti an einem Projekt in Niederösterreich',
          items: [
            {
              name: 'Standort klären',
              body: 'Piloti fragt nach dem Bundesland, wenn es im Projekt fehlt. Für ein Wiener Büro ist das keine Formsache: Ein Grundstück hinter der Stadtgrenze fällt unter die NÖ Bauordnung 2014.',
            },
            {
              name: 'Ausgabe nennen',
              body: 'Hängt ein Wert an der OIB-Ausgabe, steht dabei, welche Piloti anwendet. Bei einem Verfahren, das vor dem 18.3.2025 begonnen hat, weist es auf die Übergangsregeln des Landes hin.',
            },
            {
              name: 'Belegen',
              body: 'Die Fundstelle steht wie in einem Bescheid, „NÖ Bauordnung 2014, § …“, vor dem Anzeigen gegen den Text geprüft und im RIS in Piloti an der markierten Stelle geöffnet.',
            },
            {
              name: 'Vergleichen, wo es zählt',
              body: 'Prüft das Büro zwei Standorte, stellt Piloti Wien und Niederösterreich in Tabs nebeneinander, jede Seite mit eigener Quelle.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti in Niederösterreich aufhört',
          items: [
            'Piloti ersetzt nicht die Baubehörde der Gemeinde. Ob ein Vorhaben bewilligt wird, entscheidet sie.',
            'Ohne Bebauungsplan im Projekt kann Piloti nicht sagen, was er für Ihr Grundstück festlegt.',
            'Ausnahmen und Übergangsbestimmungen zur Verbindlichkeit der OIB-Richtlinien stehen im Landesrecht. Die Verordnung, mit der das Land sie verbindlich erklärt, prüfen Sie für Ihr Verfahren selbst.',
            'Einen Energieausweis oder eine HWB-Berechnung erstellt Piloti nicht.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche OIB-Richtlinien gelten in Niederösterreich?',
          a: 'Laut OIB-Übersicht (Stand: September 2025) gelten in Niederösterreich die OIB-Richtlinien 1 bis 6 in der Ausgabe 2023, verbindlich seit 18.3.2025. Die OIB-Richtlinie 6 Ausgabe 2025 ist laut Übersicht (Stand: Juli 2026) dort nicht in Kraft. Ausnahmen und Übergangsregeln prüfen Sie im Landesrecht.',
        },
        {
          q: 'Wo finde ich die NÖ Bauordnung 2014 im Volltext?',
          a: 'Im Rechtsinformationssystem des Bundes (RIS), kostenlos und in der geltenden Fassung. Piloti öffnet jede zitierte Stelle direkt aus dem RIS, markiert, damit Sie den Absatz im Zusammenhang lesen.',
        },
        {
          q: 'Kann Piloti Fragen zur NÖ Bauordnung beantworten?',
          a: 'Ja, mit Fundstelle aus der NÖ Bauordnung 2014 und den OIB-Richtlinien, geprüft gegen den Quelltext, bevor sie erscheint. Was nur der Bebauungsplan Ihrer Gemeinde festlegt, beantwortet Piloti aus dem Plan, wenn er im Projekt liegt, sonst sagt es, dass er fehlt.',
        },
        {
          q: 'Gilt am Wiener Stadtrand die Wiener oder die niederösterreichische Bauordnung?',
          a: 'Es gilt das Recht des Bundeslands, in dem das Grundstück liegt, nicht das des Büros. Liegt es in einer niederösterreichischen Gemeinde, gelten die NÖ Bauordnung 2014 und der Bebauungsplan dieser Gemeinde. Piloti fragt nach dem Standort, wenn er im Projekt nicht steht.',
        },
      ],
    },
    en: {
      title: 'Lower Austria building code and OIB guidelines: AI help',
      description:
        'Building law in Lower Austria: NÖ Bauordnung 2014, OIB guidelines 2023 since 18 March 2025, and the municipal development plan. How Piloti cites answers.',
      heading: 'Building law in Lower Austria: NÖ Bauordnung 2014 and OIB guidelines',
      lede: 'In Lower Austria two levels decide a project: the NÖ Bauordnung 2014 for the whole state and the municipality’s development plan for the individual plot. Piloti works with the first from RIS, and with the second as soon as it is in the project.',
      note: 'OIB status per the OIB overview “Inkrafttreten der OIB-Richtlinien”: 2023 edition as of September 2025, RL 6 edition 2025 as of July 2026. Legal text from RIS.',
      answer:
        'Lower Austria applies the NÖ Bauordnung 2014. According to the OIB overview (as of September 2025), OIB guidelines 1 to 6 in the 2023 edition have been binding there since 18 March 2025; OIB guideline 6, edition 2025, is not in force in Lower Austria according to the overview (as of July 2026).',
      blocks: [
        {
          kind: 'pairs',
          title: 'What applies in Lower Austria',
          body: 'Piloti’s register holds the state act for Lower Austria, alongside the OIB guidelines and federal law where a project touches it.',
          items: [
            {
              name: 'NÖ Bauordnung 2014',
              body: 'Applications, permits and the rules the municipal development plan builds on. The basis of every answer on a project in Lower Austria.',
            },
            {
              name: 'OIB guidelines 1–6',
              body: '2023 edition, binding since 18 March 2025 according to the OIB overview, all six on the same day.',
            },
            {
              name: 'OIB guideline 6, edition 2025',
              body: 'Not in force in Lower Austria according to the OIB overview (as of July 2026). Energy saving and thermal protection stay with the 2023 edition.',
            },
            {
              name: 'Federal law',
              body: 'ASchG and the workplace ordinance for workplaces, the trade code for commercial facilities, the monuments act: applies alongside the building code, with its own procedure.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'The development plan has a say',
          body: [
            'Many questions about a plot in Lower Austria are not answered by the building code alone. What may be built there depends on the municipality’s development plan, and each municipality issues its own.',
            'Piloti therefore keeps them apart: what the NÖ Bauordnung 2014 governs in general, it cites with the passage. What only the development plan can fix, it reads from the plan if the plan is in the project. If it is missing, Piloti says so instead of guessing a value, and names the municipal building authority as the place that holds it.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti works on a project in Lower Austria',
          items: [
            {
              name: 'Settle the location',
              body: 'Piloti asks for the state if the project lacks it. For a Vienna office this is no formality: a plot just past the city boundary falls under the NÖ Bauordnung 2014.',
            },
            {
              name: 'Name the edition',
              body: 'When a value depends on the OIB edition, the answer says which one Piloti applies. For a procedure begun before 18 March 2025, it points to the state’s transition rules.',
            },
            {
              name: 'Cite',
              body: 'The citation reads like a permit, “NÖ Bauordnung 2014, § …”, checked against the text before it appears and opened in RIS inside Piloti at the marked passage.',
            },
            {
              name: 'Compare where it counts',
              body: 'If the office weighs two sites, Piloti sets Vienna and Lower Austria side by side in tabs, each with its own source.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops in Lower Austria',
          items: [
            'Piloti does not replace the municipal building authority. Whether a project is permitted is its decision.',
            'Without the development plan in the project, Piloti cannot say what it fixes for your plot.',
            'Exceptions and transition rules on the binding force of the OIB guidelines sit in state law. You check the ordinance by which the state declares them binding for your procedure yourself.',
            'Piloti does not produce an energy certificate or an HWB calculation.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which OIB guidelines apply in Lower Austria?',
          a: 'According to the OIB overview (as of September 2025), Lower Austria applies OIB guidelines 1 to 6 in the 2023 edition, binding since 18 March 2025. OIB guideline 6, edition 2025, is not in force there according to the overview (as of July 2026). Check exceptions and transition rules in state law.',
        },
        {
          q: 'Where can I read the NÖ Bauordnung 2014 in full?',
          a: 'In the federal legal information system (RIS), free of charge and in its current version. Piloti opens every cited passage straight from RIS, marked, so you read the paragraph in context.',
        },
        {
          q: 'Can Piloti answer questions on the Lower Austria building code?',
          a: 'Yes, with a citation from the NÖ Bauordnung 2014 and the OIB guidelines, checked against the source text before it appears. What only your municipality’s development plan fixes, Piloti answers from the plan if it is in the project; otherwise it says the plan is missing.',
        },
        {
          q: 'On the edge of Vienna, does the Vienna or the Lower Austria code apply?',
          a: 'The law of the state the plot lies in applies, not that of the office. If it lies in a Lower Austrian municipality, the NÖ Bauordnung 2014 and that municipality’s development plan apply. Piloti asks for the location if the project does not state it.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------- Oberösterreich
  {
    slug: 'oberoesterreich',
    checked: '2026-09',
    related: ['baurecht/salzburg', 'baurecht/niederoesterreich', 'baurecht/steiermark', 'glossar/oib-richtlinien', 'glossar/ris', 'anwendungen/einreichcheck', 'anwendungen/bebauung'],
    de: {
      title: 'Oö. Bauordnung 1994 und OIB-Richtlinien: Baurecht mit KI',
      description:
        'Bauordnung Oberösterreich: Oö. Bauordnung 1994, OIB-Richtlinien 1–5 in der Ausgabe 2023 seit 1.10.2025, RL 6 nicht. Was das heißt und wie Piloti es belegt.',
      heading: 'Baurecht in Oberösterreich: Oö. Bauordnung 1994 und OIB-Richtlinien',
      lede: 'Oberösterreich hat die OIB-Richtlinien 2023 nicht als Paket übernommen. Die Richtlinien 1 bis 5 gelten in der neuen Ausgabe, die Richtlinie 6 laut OIB-Übersicht nicht. Wer dort plant, arbeitet mit zwei Ausgaben in einem Projekt.',
      note: 'OIB-Stand laut OIB-Übersicht „Inkrafttreten der OIB-Richtlinien“: Ausgabe 2023 Stand September 2025, RL 6 Ausgabe 2025 Stand Juli 2026. Gesetzestext aus dem RIS.',
      answer:
        'In Oberösterreich gilt die Oö. Bauordnung 1994. Laut OIB-Übersicht (Stand: September 2025) sind dort die OIB-Richtlinien 1 bis 5 in der Ausgabe 2023 seit 1.10.2025 verbindlich; für die OIB-Richtlinie 6 weist die Übersicht die Ausgabe 2023 nicht als in Kraft aus, dort gilt in der Regel weiter die Ausgabe 2019.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was in Oberösterreich gilt',
          body: 'Diese Quellen zieht Piloti für ein Projekt in Oberösterreich heran, jede mit ihrer Fundstelle.',
          items: [
            {
              name: 'Oö. Bauordnung 1994',
              body: 'Bauansuchen und Baubewilligung. Die Grundlage jeder Antwort zu einem oberösterreichischen Projekt.',
            },
            {
              name: 'OIB-Richtlinien 1–5',
              body: 'Mechanische Festigkeit, Brandschutz, Hygiene, Nutzungssicherheit und Barrierefreiheit, Schallschutz: Ausgabe 2023, laut OIB-Übersicht seit 1.10.2025 verbindlich.',
            },
            {
              name: 'OIB-Richtlinie 6',
              body: 'Energieeinsparung und Wärmeschutz: Ausgabe 2023 laut OIB-Übersicht nicht in Kraft, die Ausgabe 2025 laut Übersicht (Stand: Juli 2026) ebenfalls nicht. In der Regel gilt weiter die Ausgabe 2019.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Zwei Ausgaben in einem Projekt',
          body: [
            'Ein Aktenvermerk, der für ein Projekt in Oberösterreich pauschal „nach OIB-Richtlinien 2023“ schreibt, stimmt für Brandschutz oder Schallschutz, beim Wärmeschutz aber in der Regel nicht. Dort ist laut OIB-Übersicht keine neuere Ausgabe als 2019 in Kraft.',
            'Dazu kommt der Stichtag: Die Richtlinien 1 bis 5 in der Ausgabe 2023 gelten erst seit 1.10.2025. Für Verfahren, die davor eingereicht wurden, kann noch die ältere Ausgabe maßgeblich sein. Das regeln die Übergangsbestimmungen des Landes, nicht die Richtlinie selbst.',
            'Piloti nennt deshalb bei jeder OIB-Anforderung die Ausgabe einzeln, statt eine für das ganze Projekt anzunehmen, und sagt dazu, wenn der Wert aus einer anderen Ausgabe stammt als der, die im Land gilt.',
          ],
        },
        {
          kind: 'steps',
          title: 'So beantwortet Piloti eine Frage zu einem Projekt in Oberösterreich',
          items: [
            {
              name: 'Bundesland und Datum',
              body: 'Fehlt das Bundesland im Projekt, fragt Piloti einmal. Hängt die Antwort an der OIB-Ausgabe, fragt es nach dem Einreichdatum oder schreibt die Annahme dazu.',
            },
            {
              name: 'Richtlinie und Ausgabe',
              body: 'Eine Brandschutzfrage belegt es aus der RL 2 Ausgabe 2023, eine Frage zum Wärmeschutz mit dem Hinweis, dass in Oberösterreich eine ältere Ausgabe gilt.',
            },
            {
              name: 'Zitieren wie ein Bescheid',
              body: '„Oö. Bauordnung 1994, § …“ oder „OIB-RL 2, Pkt. …“, vor dem Anzeigen gegen den Quelltext geprüft. Die Landesstelle öffnet Piloti aus dem RIS an der markierten Passage.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti in Oberösterreich aufhört',
          items: [
            'Piloti ersetzt nicht die Baubehörde der Gemeinde. Die Entscheidung über das Vorhaben trifft sie.',
            'Was der Bebauungsplan für Ihr Grundstück festlegt, liest Piloti nur aus dem Plan im Projekt. Fehlt er, sagt es das.',
            'Welche OIB-Ausgabe ein laufendes Verfahren trifft und welche Ausnahmen das Land festlegt, steht im Landesrecht, das die Richtlinien verbindlich erklärt. Das prüfen Sie für Ihr Verfahren selbst.',
            'Piloti zitiert die OIB-Richtlinien mit Ausgabe. Stammt ein Wert aus einer anderen Ausgabe als der in Oberösterreich geltenden, gleichen Sie ihn mit der geltenden ab.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche OIB-Richtlinien gelten in Oberösterreich?',
          a: 'Laut OIB-Übersicht (Stand: September 2025) gelten in Oberösterreich die OIB-Richtlinien 1 bis 5 in der Ausgabe 2023, verbindlich seit 1.10.2025. Die RL 6 Ausgabe 2023 ist dort nicht als in Kraft ausgewiesen, die Ausgabe 2025 laut Übersicht (Stand: Juli 2026) ebenso wenig; für Energieeinsparung und Wärmeschutz gilt in der Regel weiter die Ausgabe 2019. Ausnahmen und Übergangsregeln stehen im Landesrecht.',
        },
        {
          q: 'Wo finde ich die Oö. Bauordnung 1994 im Volltext?',
          a: 'Im Rechtsinformationssystem des Bundes (RIS), kostenlos und in der geltenden Fassung. Zitiert Piloti daraus, öffnet sich die Stelle direkt aus dem RIS in Piloti, markiert.',
        },
        {
          q: 'Kann Piloti Fragen zur Oö. Bauordnung beantworten?',
          a: 'Ja. Piloti belegt Antworten zu einem oberösterreichischen Projekt aus der Oö. Bauordnung 1994 und den OIB-Richtlinien, mit geprüfter Fundstelle und der Ausgabe je Richtlinie. Die Antwort ist eine Arbeitsgrundlage für das Büro, keine Auskunft der Behörde.',
        },
        {
          q: 'Warum gilt in Oberösterreich die RL 6 in einer anderen Ausgabe?',
          a: 'Jedes Bundesland entscheidet selbst, ob und wann es eine OIB-Ausgabe verbindlich erklärt, und kann das je Richtlinie tun. Laut OIB-Übersicht hat Oberösterreich die Ausgabe 2023 für die Richtlinien 1 bis 5 übernommen, für die RL 6 nicht. Die Gründe stehen nicht in der Übersicht; die geltende Regel im Landesrecht.',
        },
      ],
    },
    en: {
      title: 'Upper Austria building code and OIB guidelines: AI help',
      description:
        'Upper Austria building law: Oö. Bauordnung 1994, OIB guidelines 1–5 in the 2023 edition since 1 October 2025, RL 6 not. What that means, cited by Piloti.',
      heading: 'Building law in Upper Austria: Oö. Bauordnung 1994 and OIB guidelines',
      lede: 'Upper Austria did not adopt the 2023 OIB guidelines as a package. Guidelines 1 to 5 apply in the new edition, guideline 6 does not, according to the OIB overview. Anyone planning there works with two editions in one project.',
      note: 'OIB status per the OIB overview “Inkrafttreten der OIB-Richtlinien”: 2023 edition as of September 2025, RL 6 edition 2025 as of July 2026. Legal text from RIS.',
      answer:
        'Upper Austria applies the Oö. Bauordnung 1994. According to the OIB overview (as of September 2025), OIB guidelines 1 to 5 in the 2023 edition have been binding there since 1 October 2025; for OIB guideline 6 the overview does not list the 2023 edition as in force, so the 2019 edition generally still applies.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What applies in Upper Austria',
          body: 'Piloti draws on these sources for a project in Upper Austria, each with its citation.',
          items: [
            {
              name: 'Oö. Bauordnung 1994',
              body: 'Applications and permits. The basis of every answer on an Upper Austrian project.',
            },
            {
              name: 'OIB guidelines 1–5',
              body: 'Mechanical resistance, fire safety, hygiene, safety in use and accessibility, sound insulation: 2023 edition, binding since 1 October 2025 according to the OIB overview.',
            },
            {
              name: 'OIB guideline 6',
              body: 'Energy saving and thermal protection: the 2023 edition is not in force according to the OIB overview, nor the 2025 edition according to the overview (as of July 2026). The 2019 edition generally still applies.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Two editions in one project',
          body: [
            'A file note that writes “according to OIB guidelines 2023” across the board for a project in Upper Austria is right for fire safety or sound insulation, but generally not for thermal protection. There, according to the OIB overview, no edition newer than 2019 is in force.',
            'Then there is the effective date: guidelines 1 to 5 in the 2023 edition only apply since 1 October 2025. For procedures filed before that, the older edition can still govern. The state’s transition rules decide that, not the guideline itself.',
            'Piloti therefore names the edition for each OIB requirement separately instead of assuming one for the whole project, and says so when a value comes from a different edition than the one in force in the state.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti answers a question on a project in Upper Austria',
          items: [
            {
              name: 'State and date',
              body: 'If the project lacks the state, Piloti asks once. If the answer depends on the OIB edition, it asks for the submission date or states its assumption.',
            },
            {
              name: 'Guideline and edition',
              body: 'A fire-safety question it cites from RL 2, 2023 edition; a thermal-protection question with the note that an older edition applies in Upper Austria.',
            },
            {
              name: 'Cite like a permit',
              body: '“Oö. Bauordnung 1994, § …” or “OIB-RL 2, Pkt. …”, checked against the source text before it appears. Piloti opens the state passage from RIS at the marked place.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops in Upper Austria',
          items: [
            'Piloti does not replace the municipal building authority. It decides on the project.',
            'What the development plan fixes for your plot, Piloti reads only from the plan in the project. If it is missing, it says so.',
            'Which OIB edition governs a pending procedure, and which exceptions the state sets, is in the state law that declares the guidelines binding. You check that for your procedure yourself.',
            'Piloti cites the OIB guidelines with their edition. If a value comes from a different edition than the one in force in Upper Austria, check it against the one in force.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which OIB guidelines apply in Upper Austria?',
          a: 'According to the OIB overview (as of September 2025), Upper Austria applies OIB guidelines 1 to 5 in the 2023 edition, binding since 1 October 2025. RL 6 in the 2023 edition is not listed as in force there, nor the 2025 edition according to the overview (as of July 2026); for energy saving and thermal protection the 2019 edition generally still applies. Exceptions and transition rules are in state law.',
        },
        {
          q: 'Where can I read the Oö. Bauordnung 1994 in full?',
          a: 'In the federal legal information system (RIS), free of charge and in its current version. When Piloti cites from it, the passage opens straight from RIS inside Piloti, marked.',
        },
        {
          q: 'Can Piloti answer questions on the Upper Austria building code?',
          a: 'Yes. Piloti cites answers on an Upper Austrian project from the Oö. Bauordnung 1994 and the OIB guidelines, with a checked citation and the edition for each guideline. The answer is a working basis for the office, not information from the authority.',
        },
        {
          q: 'Why does RL 6 apply in a different edition in Upper Austria?',
          a: 'Each state decides whether and when it declares an OIB edition binding, and can do so guideline by guideline. According to the OIB overview, Upper Austria adopted the 2023 edition for guidelines 1 to 5 but not for RL 6. The overview does not give reasons; state law holds the rule in force.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------- Steiermark
  {
    slug: 'steiermark',
    checked: '2026-09',
    related: ['baurecht/kaernten', 'baurecht/niederoesterreich', 'baurecht/burgenland', 'glossar/oib-richtlinien', 'glossar/ris', 'anwendungen/einreichcheck', 'anwendungen/bebauung'],
    de: {
      title: 'Bauordnung Steiermark: Baugesetz und OIB-Richtlinien',
      description:
        'Bauordnung Steiermark heißt Steiermärkisches Baugesetz. Welche OIB-Richtlinien dort laut OIB-Übersicht gelten, warum nicht 2023, und wie Piloti belegt.',
      heading: 'Baurecht in der Steiermark: Steiermärkisches Baugesetz und OIB-Richtlinien',
      lede: 'Wer „Bauordnung Steiermark“ sucht, landet beim Steiermärkischen Baugesetz: So heißt das Gesetz im Land. Und wer die neuesten OIB-Richtlinien von der OIB-Website lädt, hat für ein steirisches Projekt laut OIB-Übersicht nicht die Ausgabe, die dort gilt.',
      note: 'OIB-Stand laut OIB-Übersicht „Inkrafttreten der OIB-Richtlinien“: Ausgabe 2023 Stand September 2025, RL 6 Ausgabe 2025 Stand Juli 2026. Gesetzestext aus dem RIS.',
      answer:
        'In der Steiermark gilt das Steiermärkische Baugesetz. Laut OIB-Übersicht (Stand: September 2025) hat die Steiermark die OIB-Richtlinien 2023 nicht für verbindlich erklärt, und auch die OIB-Richtlinie 6 Ausgabe 2025 ist dort laut Übersicht (Stand: Juli 2026) nicht in Kraft; es gilt in der Regel weiter die Ausgabe 2019.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was in der Steiermark gilt',
          body: 'Für ein steirisches Projekt zieht Piloti diese Quellen heran.',
          items: [
            {
              name: 'Steiermärkisches Baugesetz',
              body: 'Das steirische Gegenstück zur Bauordnung: Bauansuchen und Baubewilligung. Zitiert wird es unter seinem Namen, nicht als „Bauordnung“.',
            },
            {
              name: 'OIB-Richtlinien',
              body: 'Laut OIB-Übersicht ist die Ausgabe 2023 in der Steiermark für keine der sechs Richtlinien in Kraft, die RL 6 Ausgabe 2025 ebenso wenig. In Kraft ist die Ausgabe 2019.',
            },
            {
              name: 'Bundesrecht',
              body: 'Arbeitsstättenverordnung, Gewerbeordnung, Denkmalschutzgesetz und UVP-G gelten neben dem Baugesetz, wo das Projekt sie berührt.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Die neueste Ausgabe ist nicht die geltende',
          body: [
            'Auf der Website des OIB stehen die Richtlinien in der Ausgabe 2023 und die RL 6 in der Ausgabe 2025. Für ein Projekt in der Steiermark sind das laut OIB-Übersicht nicht die verbindlichen Texte: Dort gilt die Ausgabe 2019, solange das Land keine neuere für verbindlich erklärt. Ein Wert, der zwischen den Ausgaben geändert wurde, ist in einem steirischen Einreichplan dann schlicht falsch zitiert.',
            'Piloti zitiert die OIB-Richtlinien mit Ausgabe. Stammt eine Anforderung aus der Ausgabe 2023, sagt die Antwort das und weist darauf hin, dass in der Steiermark die Ausgabe 2019 gilt. Den Wert gleichen Sie dort ab, bevor er in einen Plan oder Bericht geht.',
            'Die OIB-Richtlinien 2027 werden vorbereitet. Wann die Steiermark welche Ausgabe übernimmt, sagt die Verordnung des Landes, nicht die OIB-Website.',
          ],
        },
        {
          kind: 'steps',
          title: 'So beantwortet Piloti eine Frage zu einem steirischen Projekt',
          items: [
            {
              name: 'Land festhalten',
              body: 'Steht das Bundesland nicht im Projekt, fragt Piloti einmal. Mit „Steiermark“ als bestätigter Tatsache im Projektgedächtnis fragt es beim nächsten Mal nicht wieder.',
            },
            {
              name: 'Gesetz und Richtlinie trennen',
              body: 'Was das Baugesetz regelt, belegt Piloti mit „Steiermärkisches Baugesetz, § …“. Was an einer OIB-Richtlinie hängt, mit Punkt und Ausgabe.',
            },
            {
              name: 'Prüfen und öffnen',
              body: 'Jede Fundstelle wird vor dem Anzeigen gegen den Quelltext geprüft. Die Stelle im Baugesetz öffnet Piloti aus dem RIS, markiert.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti in der Steiermark aufhört',
          items: [
            'Piloti ersetzt nicht die Baubehörde der Gemeinde. Bewilligt oder untersagt wird dort.',
            'Was der Bebauungsplan Ihrer Gemeinde für das Grundstück festlegt, liest Piloti nur aus dem Plan im Projekt.',
            'Mit welcher Verordnung das Land die OIB-Richtlinien verbindlich erklärt und mit welchen Ausnahmen, prüfen Sie im Landesrecht selbst. Piloti nennt den Stand laut OIB-Übersicht.',
            'Ein Wert aus der Ausgabe 2023 ist für ein steirisches Projekt ein Hinweis, kein Beleg, bis Sie ihn mit der Ausgabe 2019 abgeglichen haben.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche OIB-Richtlinien gelten in der Steiermark?',
          a: 'Laut OIB-Übersicht (Stand: September 2025) hat die Steiermark die OIB-Richtlinien 2023 nicht für verbindlich erklärt; die RL 6 Ausgabe 2025 ist dort laut Übersicht (Stand: Juli 2026) ebenfalls nicht in Kraft. In Kraft sind die OIB-Richtlinien 2019. Ausnahmen und Übergangsregeln stehen im Landesrecht.',
        },
        {
          q: 'Wo finde ich das Steiermärkische Baugesetz im Volltext?',
          a: 'Im Rechtsinformationssystem des Bundes (RIS), kostenlos und in der geltenden Fassung. Wer dort nach „Bauordnung Steiermark“ sucht, findet es unter „Steiermärkisches Baugesetz“. Piloti öffnet zitierte Stellen direkt aus dem RIS.',
        },
        {
          q: 'Kann Piloti Fragen zum Steiermärkischen Baugesetz beantworten?',
          a: 'Ja, mit Fundstelle aus dem Baugesetz und den OIB-Richtlinien, geprüft gegen den Quelltext, bevor sie erscheint. Bei OIB-Anforderungen sagt Piloti, aus welcher Ausgabe der Wert stammt, und weist darauf hin, dass in der Steiermark die Ausgabe 2019 gilt.',
        },
        {
          q: 'Gibt es eine „Steiermärkische Bauordnung“?',
          a: 'Das Gesetz, das in anderen Ländern Bauordnung heißt, heißt in der Steiermark Steiermärkisches Baugesetz. Wer im Einreichplan oder im Aktenvermerk zitiert, verwendet diesen Namen. Piloti zitiert es so.',
        },
      ],
    },
    en: {
      title: 'Styria building code: Baugesetz and OIB guidelines',
      description:
        'Styria’s building code is the Steiermärkisches Baugesetz. Which OIB guidelines apply there per the OIB overview, why not 2023, and how Piloti cites it.',
      heading: 'Building law in Styria: Steiermärkisches Baugesetz and OIB guidelines',
      lede: 'Anyone searching for Styria’s “building code” ends up at the Steiermärkisches Baugesetz: that is the act’s name in the state. And anyone downloading the newest OIB guidelines from the OIB website does not, for a Styrian project, have the edition that applies there according to the OIB overview.',
      note: 'OIB status per the OIB overview “Inkrafttreten der OIB-Richtlinien”: 2023 edition as of September 2025, RL 6 edition 2025 as of July 2026. Legal text from RIS.',
      answer:
        'Styria applies the Steiermärkisches Baugesetz. According to the OIB overview (as of September 2025), Styria has not declared the 2023 OIB guidelines binding, and OIB guideline 6, edition 2025, is not in force there either according to the overview (as of July 2026); the 2019 edition generally still applies.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What applies in Styria',
          body: 'For a Styrian project Piloti draws on these sources.',
          items: [
            {
              name: 'Steiermärkisches Baugesetz',
              body: 'Styria’s counterpart to a building code: applications and permits. It is cited under its own name, not as a “Bauordnung”.',
            },
            {
              name: 'OIB guidelines',
              body: 'According to the OIB overview, the 2023 edition is in force in Styria for none of the six guidelines, nor RL 6 in the 2025 edition. The 2019 edition is in force.',
            },
            {
              name: 'Federal law',
              body: 'The workplace ordinance, the trade code, the monuments act and the UVP-G apply alongside the Baugesetz where the project touches them.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'The newest edition is not the one in force',
          body: [
            'The OIB website carries the guidelines in the 2023 edition and RL 6 in the 2025 edition. For a project in Styria these are not the binding texts according to the OIB overview: the 2019 edition applies until the state declares a newer one binding. A value that changed between editions is then simply cited wrongly in a Styrian submission drawing.',
            'Piloti cites the OIB guidelines with their edition. If a requirement comes from the 2023 edition, the answer says so and points out that the 2019 edition applies in Styria. Check the value there before it goes into a drawing or report.',
            'The 2027 OIB guidelines are in preparation. When Styria adopts which edition is stated in the state’s ordinance, not on the OIB website.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti answers a question on a Styrian project',
          items: [
            {
              name: 'Fix the state',
              body: 'If the project does not state it, Piloti asks once. With “Styria” as a confirmed fact in the project memory, it does not ask again next time.',
            },
            {
              name: 'Keep act and guideline apart',
              body: 'What the Baugesetz governs, Piloti cites as “Steiermärkisches Baugesetz, § …”. What hinges on an OIB guideline, with clause and edition.',
            },
            {
              name: 'Check and open',
              body: 'Every citation is checked against the source text before it appears. Piloti opens the passage in the Baugesetz from RIS, marked.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops in Styria',
          items: [
            'Piloti does not replace the municipal building authority. Permits are granted or refused there.',
            'What your municipality’s development plan fixes for the plot, Piloti reads only from the plan in the project.',
            'Which ordinance declares the OIB guidelines binding in the state, and with which exceptions, you check in state law yourself. Piloti gives the status per the OIB overview.',
            'For a Styrian project, a value from the 2023 edition is a pointer, not evidence, until you have checked it against the 2019 edition.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which OIB guidelines apply in Styria?',
          a: 'According to the OIB overview (as of September 2025), Styria has not declared the 2023 OIB guidelines binding; RL 6, edition 2025, is not in force there either according to the overview (as of July 2026). The 2019 OIB guidelines are in force. Exceptions and transition rules are in state law.',
        },
        {
          q: 'Where can I read the Steiermärkisches Baugesetz in full?',
          a: 'In the federal legal information system (RIS), free of charge and in its current version. A search for a Styrian “Bauordnung” finds it as “Steiermärkisches Baugesetz”. Piloti opens cited passages straight from RIS.',
        },
        {
          q: 'Can Piloti answer questions on the Steiermärkisches Baugesetz?',
          a: 'Yes, with a citation from the Baugesetz and the OIB guidelines, checked against the source text before it appears. For OIB requirements Piloti says which edition the value comes from and points out that the 2019 edition applies in Styria.',
        },
        {
          q: 'Is there a “Steiermärkische Bauordnung”?',
          a: 'The act called a building code (Bauordnung) in other states is called the Steiermärkisches Baugesetz in Styria. Anyone citing in a submission drawing or file note uses that name. Piloti cites it that way.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------- Kärnten
  {
    slug: 'kaernten',
    checked: '2026-09',
    related: ['baurecht/steiermark', 'baurecht/salzburg', 'baurecht/tirol', 'glossar/oib-richtlinien', 'glossar/ris', 'anwendungen/einreichcheck', 'anwendungen/bebauung'],
    de: {
      title: 'Kärntner Bauordnung K-BO 1996 und OIB-Richtlinien',
      description:
        'Bauordnung Kärnten: K-BO 1996 und OIB-Richtlinien 2023, laut OIB-Übersicht seit 31.12.2024 verbindlich. Was in Kärnten gilt und wie Piloti es belegt.',
      heading: 'Baurecht in Kärnten: Kärntner Bauordnung 1996 und OIB-Richtlinien',
      lede: 'Kärnten war unter den ersten Ländern mit den OIB-Richtlinien 2023: laut OIB-Übersicht alle sechs Richtlinien am 31.12.2024. Die Kärntner Bauordnung 1996, kurz K-BO 1996, bleibt das Gesetz, auf das sich jede Antwort stützt.',
      note: 'OIB-Stand laut OIB-Übersicht „Inkrafttreten der OIB-Richtlinien“: Ausgabe 2023 Stand September 2025, RL 6 Ausgabe 2025 Stand Juli 2026. Gesetzestext aus dem RIS.',
      answer:
        'In Kärnten gilt die Kärntner Bauordnung 1996 (K-BO 1996). Laut OIB-Übersicht (Stand: September 2025) sind dort die OIB-Richtlinien 1 bis 6 in der Ausgabe 2023 seit 31.12.2024 verbindlich; die OIB-Richtlinie 6 Ausgabe 2025 ist laut Übersicht (Stand: Juli 2026) in Kärnten nicht in Kraft.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was in Kärnten gilt',
          body: 'Diese Quellen zieht Piloti für ein Projekt in Kärnten heran.',
          items: [
            {
              name: 'Kärntner Bauordnung 1996 (K-BO 1996)',
              body: 'Bauansuchen und Baubewilligung in Kärnten. Zitiert mit dem Kurztitel K-BO 1996, unter dem auch das RIS sie führt.',
            },
            {
              name: 'OIB-Richtlinien 1–6',
              body: 'Ausgabe 2023, laut OIB-Übersicht seit 31.12.2024 verbindlich, alle sechs zum selben Stichtag.',
            },
            {
              name: 'OIB-Richtlinie 6 Ausgabe 2025',
              body: 'Laut OIB-Übersicht (Stand: Juli 2026) in Kärnten nicht in Kraft. Für Energieeinsparung und Wärmeschutz bleibt es bei der Ausgabe 2023.',
            },
            {
              name: 'Bundesrecht',
              body: 'Denkmalschutzgesetz, Wasserrechtsgesetz, Forstgesetz, Gewerbeordnung: mit eigenem Verfahren neben der Baubewilligung, wo das Projekt sie berührt.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Eine Ausgabe für alle sechs Richtlinien',
          body: [
            'Anders als in Oberösterreich oder Tirol gilt in Kärnten laut OIB-Übersicht für alle sechs Richtlinien dieselbe Ausgabe. Das macht Antworten einfacher: Brandschutz, Schallschutz und Wärmeschutz stützen sich auf die Ausgabe 2023. Die neue RL 6 Ausgabe 2025, die Wien und Tirol 2026 übernommen haben, gilt in Kärnten laut Übersicht nicht.',
            'Offen bleibt der Blick auf das Verfahren: Wurde ein Projekt vor dem 31.12.2024 eingereicht, kann das Übergangsrecht des Landes noch die Ausgabe 2019 vorsehen. Piloti fragt in diesem Fall nach dem Einreichdatum oder schreibt dazu, welche Ausgabe es angenommen hat.',
          ],
        },
        {
          kind: 'steps',
          title: 'So beantwortet Piloti eine Frage zu einem Kärntner Projekt',
          items: [
            {
              name: 'Einordnen',
              body: 'Piloti klärt Bundesland und Art des Vorhabens: Neubau, Zubau, Umbau, Nutzungsänderung. Fehlt eine dieser Angaben und hängt die Antwort daran, fragt es genau diese eine.',
            },
            {
              name: 'Belegen',
              body: 'Die Fundstelle steht wie in einem Bescheid, „K-BO 1996, § …“ oder „OIB-RL 4, Pkt. …“, vor dem Anzeigen gegen den Quelltext geprüft.',
            },
            {
              name: 'Nachlesen',
              body: 'Ein Klick öffnet die Stelle der Kärntner Bauordnung aus dem RIS in Piloti, markiert.',
            },
            {
              name: 'Festhalten',
              body: 'Was geklärt ist, wird im Projekt zur Tatsache, was offen bleibt, zum offenen Punkt. Auf Wunsch wird daraus ein Aktenvermerk zur Freigabe im Büro.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti in Kärnten aufhört',
          items: [
            'Piloti ersetzt nicht die Baubehörde der Gemeinde, und keine Antwort ist eine Bewilligung.',
            'Den Bebauungsplan Ihrer Gemeinde liest Piloti nur, wenn er im Projekt liegt. Sonst sagt es, dass er fehlt.',
            'Ausnahmen und Übergangsbestimmungen zur Verbindlichkeit der OIB-Richtlinien prüfen Sie im Landesrecht selbst. Piloti nennt den Stand laut OIB-Übersicht.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche OIB-Richtlinien gelten in Kärnten?',
          a: 'Laut OIB-Übersicht (Stand: September 2025) gelten in Kärnten die OIB-Richtlinien 1 bis 6 in der Ausgabe 2023, verbindlich seit 31.12.2024. Die RL 6 Ausgabe 2025 ist laut Übersicht (Stand: Juli 2026) dort nicht in Kraft. Übergangsregeln für ältere Verfahren stehen im Landesrecht.',
        },
        {
          q: 'Wo finde ich die Kärntner Bauordnung 1996 im Volltext?',
          a: 'Im Rechtsinformationssystem des Bundes (RIS), kostenlos und in der geltenden Fassung, unter „Kärntner Bauordnung 1996 – K-BO 1996“. Piloti öffnet eine zitierte Stelle direkt aus dem RIS, markiert.',
        },
        {
          q: 'Kann Piloti Fragen zur K-BO 1996 beantworten?',
          a: 'Ja. Piloti beantwortet Fragen zu einem Kärntner Projekt aus der K-BO 1996 und den OIB-Richtlinien, mit geprüfter Fundstelle. Eine typische Antwort dauert etwa 30 Sekunden; eine Tiefenrecherche mit Bericht im Projekt länger.',
        },
        {
          q: 'Gilt in Kärnten schon die neue RL 6 Ausgabe 2025?',
          a: 'Laut OIB-Übersicht (Stand: Juli 2026) nein. Die RL 6 Ausgabe 2025 gilt bisher in Wien und Tirol. In Kärnten bleibt es für Energieeinsparung und Wärmeschutz bei der Ausgabe 2023, bis das Land eine neuere verbindlich erklärt.',
        },
      ],
    },
    en: {
      title: 'Carinthia building code K-BO 1996 and OIB guidelines',
      description:
        'Carinthia building law: K-BO 1996 and the 2023 OIB guidelines, binding since 31 December 2024 per the OIB overview. What applies and how Piloti cites it.',
      heading: 'Building law in Carinthia: Kärntner Bauordnung 1996 and OIB guidelines',
      lede: 'Carinthia was among the first states with the 2023 OIB guidelines: all six on 31 December 2024, according to the OIB overview. The Kärntner Bauordnung 1996, K-BO 1996 for short, remains the act every answer rests on.',
      note: 'OIB status per the OIB overview “Inkrafttreten der OIB-Richtlinien”: 2023 edition as of September 2025, RL 6 edition 2025 as of July 2026. Legal text from RIS.',
      answer:
        'Carinthia applies the Kärntner Bauordnung 1996 (K-BO 1996). According to the OIB overview (as of September 2025), OIB guidelines 1 to 6 in the 2023 edition have been binding there since 31 December 2024; OIB guideline 6, edition 2025, is not in force in Carinthia according to the overview (as of July 2026).',
      blocks: [
        {
          kind: 'pairs',
          title: 'What applies in Carinthia',
          body: 'Piloti draws on these sources for a project in Carinthia.',
          items: [
            {
              name: 'Kärntner Bauordnung 1996 (K-BO 1996)',
              body: 'Applications and permits in Carinthia. Cited by its short title K-BO 1996, which RIS also lists it under.',
            },
            {
              name: 'OIB guidelines 1–6',
              body: '2023 edition, binding since 31 December 2024 according to the OIB overview, all six on the same date.',
            },
            {
              name: 'OIB guideline 6, edition 2025',
              body: 'Not in force in Carinthia according to the OIB overview (as of July 2026). Energy saving and thermal protection stay with the 2023 edition.',
            },
            {
              name: 'Federal law',
              body: 'Monuments act, water rights act, forestry act, trade code: with their own procedures alongside the building permit, where the project touches them.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'One edition for all six guidelines',
          body: [
            'Unlike Upper Austria or Tyrol, Carinthia applies the same edition to all six guidelines, according to the OIB overview. That keeps answers simpler: fire safety, sound insulation and thermal protection rest on the 2023 edition. The new RL 6, edition 2025, which Vienna and Tyrol adopted in 2026, does not apply in Carinthia according to the overview.',
            'What remains is the procedure: if a project was filed before 31 December 2024, the state’s transition law may still point to the 2019 edition. In that case Piloti asks for the submission date or states which edition it assumed.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti answers a question on a Carinthian project',
          items: [
            {
              name: 'Classify',
              body: 'Piloti settles the state and the type of project: new build, extension, conversion, change of use. If one of these is missing and the answer depends on it, it asks for exactly that one.',
            },
            {
              name: 'Cite',
              body: 'The citation reads like a permit, “K-BO 1996, § …” or “OIB-RL 4, Pkt. …”, checked against the source text before it appears.',
            },
            {
              name: 'Read it',
              body: 'One click opens the passage of the Carinthian building code from RIS inside Piloti, marked.',
            },
            {
              name: 'Record it',
              body: 'What is settled becomes a fact in the project, what is still open an open point. On request it becomes a file note sent for approval in the office.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops in Carinthia',
          items: [
            'Piloti does not replace the municipal building authority, and no answer is a permit.',
            'Piloti reads your municipality’s development plan only if it is in the project. Otherwise it says the plan is missing.',
            'You check exceptions and transition rules on the binding force of the OIB guidelines in state law yourself. Piloti gives the status per the OIB overview.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which OIB guidelines apply in Carinthia?',
          a: 'According to the OIB overview (as of September 2025), Carinthia applies OIB guidelines 1 to 6 in the 2023 edition, binding since 31 December 2024. RL 6, edition 2025, is not in force there according to the overview (as of July 2026). Transition rules for older procedures are in state law.',
        },
        {
          q: 'Where can I read the Kärntner Bauordnung 1996 in full?',
          a: 'In the federal legal information system (RIS), free of charge and in its current version, under “Kärntner Bauordnung 1996 – K-BO 1996”. Piloti opens a cited passage straight from RIS, marked.',
        },
        {
          q: 'Can Piloti answer questions on the K-BO 1996?',
          a: 'Yes. Piloti answers questions on a Carinthian project from the K-BO 1996 and the OIB guidelines, with a checked citation. A typical answer takes about 30 seconds; in-depth research with a report filed in the project takes longer.',
        },
        {
          q: 'Does the new RL 6, edition 2025, apply in Carinthia yet?',
          a: 'Not according to the OIB overview (as of July 2026). RL 6, edition 2025, so far applies in Vienna and Tyrol. In Carinthia energy saving and thermal protection stay with the 2023 edition until the state declares a newer one binding.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------- Salzburg
  {
    slug: 'salzburg',
    checked: '2026-09',
    related: ['baurecht/oberoesterreich', 'baurecht/tirol', 'baurecht/kaernten', 'glossar/oib-richtlinien', 'glossar/ris', 'anwendungen/einreichcheck', 'anwendungen/bebauung'],
    de: {
      title: 'Bauordnung Salzburg: Bautechnikgesetz und Baupolizeigesetz',
      description:
        'Baurecht Salzburg in zwei Gesetzen: Bautechnikgesetz 2015 und Baupolizeigesetz 1997. Welche OIB-Richtlinien gelten und wie Piloti das richtige zitiert.',
      heading: 'Baurecht in Salzburg: Bautechnikgesetz 2015, Baupolizeigesetz 1997 und OIB-Richtlinien',
      lede: 'Eine einzige „Salzburger Bauordnung“ gibt es nicht. Was ein Bauwerk technisch erfüllen muss, steht im Salzburger Bautechnikgesetz 2015; ob und wie es bewilligt wird, im Baupolizeigesetz 1997. Eine Antwort, die das vermischt, zitiert das falsche Gesetz.',
      note: 'OIB-Stand laut OIB-Übersicht „Inkrafttreten der OIB-Richtlinien“: Ausgabe 2023 Stand September 2025, RL 6 Ausgabe 2025 Stand Juli 2026. Gesetzestexte aus dem RIS.',
      answer:
        'In Salzburg gelten das Salzburger Bautechnikgesetz 2015 für die technischen Anforderungen und das Baupolizeigesetz 1997 für Bewilligung und Bauanzeige. Laut OIB-Übersicht (Stand: September 2025) hat Salzburg die OIB-Richtlinien 2023 nicht für verbindlich erklärt; in Kraft sind die OIB-Richtlinien 1 bis 5 in der Ausgabe 2019, für die RL 6 weist die Übersicht keine Ausgabe aus.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was in Salzburg gilt',
          body: 'Piloti führt für Salzburg zwei Landesgesetze im Register und wählt je Frage das zuständige.',
          items: [
            {
              name: 'Salzburger Bautechnikgesetz 2015',
              body: 'Die technischen Anforderungen an Bauwerke. Das Bewilligungsverfahren steht nicht hier, sondern im Baupolizeigesetz.',
            },
            {
              name: 'Baupolizeigesetz 1997',
              body: 'Das Verfahren: was bewilligungspflichtig ist, welche Maßnahmen bewilligungsfrei sind und wann eine Bauanzeige genügt.',
            },
            {
              name: 'OIB-Richtlinien 1–5',
              body: 'Laut OIB-Übersicht in der Ausgabe 2019 in Kraft; die Ausgabe 2023 hat Salzburg laut Übersicht nicht für verbindlich erklärt.',
            },
            {
              name: 'OIB-Richtlinie 6',
              body: 'Für Salzburg weist die OIB-Übersicht weder die Ausgabe 2019 noch 2023 oder 2025 als in Kraft aus. Wo Energieeinsparung und Wärmeschutz geregelt sind, sagt das Landesrecht.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Welches Gesetz welche Frage beantwortet',
          body: [
            '„Brauche ich für das Carport eine Bewilligung?“ ist eine Frage an das Baupolizeigesetz 1997. „Welche Anforderungen gelten für das Stiegenhaus?“ ist eine Frage an das Bautechnikgesetz 2015 und, soweit es auf sie verweist, an die OIB-Richtlinien. Piloti ordnet die Frage zuerst zu und zitiert dann das Gesetz, das sie beantwortet.',
            'Bei der RL 6 ist Salzburg ein Sonderfall: Laut OIB-Übersicht gilt dort keine Ausgabe der Richtlinie 6 als in Kraft, auch nicht die Ausgabe 2019, die alle anderen Länder für die RL 6 übernommen hatten. Nennt Piloti für ein Salzburger Projekt eine Anforderung aus der RL 6, sagt es dazu, dass sie dort laut OIB-Übersicht nicht verbindlich ist, und verweist auf das Landesrecht.',
          ],
        },
        {
          kind: 'steps',
          title: 'So beantwortet Piloti eine Frage zu einem Salzburger Projekt',
          items: [
            {
              name: 'Frage zuordnen',
              body: 'Verfahren oder Technik? Danach richtet sich, ob Piloti im Baupolizeigesetz oder im Bautechnikgesetz sucht. Fehlt das Bundesland im Projekt, fragt es zuerst danach.',
            },
            {
              name: 'Ausgabe nennen',
              body: 'Hängt die Antwort an einer OIB-Richtlinie, sagt Piloti, aus welcher Ausgabe der Wert stammt, und dass in Salzburg laut OIB-Übersicht die Ausgabe 2019 gilt.',
            },
            {
              name: 'Zitieren wie ein Bescheid',
              body: '„Baupolizeigesetz 1997, § …“ oder „Salzburger Bautechnikgesetz 2015, § …“, vor dem Anzeigen gegen den Quelltext geprüft und aus dem RIS an der markierten Stelle geöffnet.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti in Salzburg aufhört',
          items: [
            'Piloti ersetzt nicht die Baubehörde der Gemeinde. Ob ein Vorhaben bewilligungspflichtig ist, bestätigt im Zweifel sie.',
            'Den Bebauungsplan Ihrer Gemeinde liest Piloti nur, wenn er im Projekt liegt.',
            'Wie das Land die OIB-Richtlinien verbindlich macht, mit welchen Ausnahmen und Übergangsregeln, prüfen Sie im Landesrecht selbst.',
            'Ein OIB-Wert aus einer anderen Ausgabe als 2019 ist für ein Salzburger Projekt ein Hinweis, kein Beleg, bis Sie ihn abgeglichen haben.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche OIB-Richtlinien gelten in Salzburg?',
          a: 'Laut OIB-Übersicht (Stand: September 2025) hat Salzburg die OIB-Richtlinien 2023 nicht für verbindlich erklärt. In Kraft sind die Richtlinien 1 bis 5 in der Ausgabe 2019; für die RL 6 weist die Übersicht in Salzburg keine Ausgabe als in Kraft aus, auch die Ausgabe 2025 nicht (Stand: Juli 2026). Die geltende Regel steht im Landesrecht.',
        },
        {
          q: 'Wo finde ich das Salzburger Bautechnikgesetz und das Baupolizeigesetz im Volltext?',
          a: 'Beide im Rechtsinformationssystem des Bundes (RIS), kostenlos und in der geltenden Fassung. Piloti öffnet eine zitierte Stelle aus beiden Gesetzen direkt aus dem RIS, markiert.',
        },
        {
          q: 'Kann Piloti Fragen zum Salzburger Baurecht beantworten?',
          a: 'Ja. Piloti beantwortet Fragen zu einem Salzburger Projekt aus dem Bautechnikgesetz 2015, dem Baupolizeigesetz 1997 und den OIB-Richtlinien, mit geprüfter Fundstelle und der Ausgabe dazu. Es sagt, welches der beiden Gesetze die Frage beantwortet.',
        },
        {
          q: 'Gibt es eine Salzburger Bauordnung?',
          a: 'Nicht unter diesem Namen. Die Aufgaben, die in anderen Ländern eine Bauordnung erfüllt, teilen sich in Salzburg das Bautechnikgesetz 2015 (Anforderungen an Bauwerke) und das Baupolizeigesetz 1997 (Bewilligung, bewilligungsfreie Maßnahmen, Bauanzeige).',
        },
        {
          q: 'Wann reicht in Salzburg eine Bauanzeige?',
          a: 'Das regelt das Baupolizeigesetz 1997, zusammen mit der Frage, was bewilligungsfrei ist. Piloti sucht die Stelle für Ihr Vorhaben heraus und zitiert sie; ob Ihr Fall darunter fällt, bestätigt im Zweifel die Baubehörde der Gemeinde.',
        },
      ],
    },
    en: {
      title: 'Salzburg building law: Bautechnikgesetz and Baupolizeigesetz',
      description:
        'Salzburg building law sits in two acts: Bautechnikgesetz 2015 and Baupolizeigesetz 1997. Which OIB guidelines apply and how Piloti cites the right one.',
      heading: 'Building law in Salzburg: Bautechnikgesetz 2015, Baupolizeigesetz 1997 and OIB guidelines',
      lede: 'There is no single “Salzburg building code”. What a building must meet technically is in the Salzburger Bautechnikgesetz 2015; whether and how it is permitted, in the Baupolizeigesetz 1997. An answer that mixes the two cites the wrong act.',
      note: 'OIB status per the OIB overview “Inkrafttreten der OIB-Richtlinien”: 2023 edition as of September 2025, RL 6 edition 2025 as of July 2026. Legal texts from RIS.',
      answer:
        'Salzburg applies the Salzburger Bautechnikgesetz 2015 for technical requirements and the Baupolizeigesetz 1997 for permits and notification. According to the OIB overview (as of September 2025), Salzburg has not declared the 2023 OIB guidelines binding; OIB guidelines 1 to 5 in the 2019 edition are in force, and for RL 6 the overview lists no edition.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What applies in Salzburg',
          body: 'Piloti holds two state acts for Salzburg in its register and picks the one responsible for each question.',
          items: [
            {
              name: 'Salzburger Bautechnikgesetz 2015',
              body: 'The technical requirements on buildings. The permit procedure is not here but in the Baupolizeigesetz.',
            },
            {
              name: 'Baupolizeigesetz 1997',
              body: 'The procedure: what needs a permit, which measures are exempt, and when a notification (Bauanzeige) is enough.',
            },
            {
              name: 'OIB guidelines 1–5',
              body: 'In force in the 2019 edition according to the OIB overview; Salzburg has not declared the 2023 edition binding according to the overview.',
            },
            {
              name: 'OIB guideline 6',
              body: 'For Salzburg the OIB overview lists neither the 2019 nor the 2023 or 2025 edition as in force. Where energy saving and thermal protection are regulated is for state law to say.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Which act answers which question',
          body: [
            '“Do I need a permit for the carport?” is a question for the Baupolizeigesetz 1997. “What requirements apply to the staircase?” is a question for the Bautechnikgesetz 2015 and, as far as it refers to them, the OIB guidelines. Piloti first assigns the question and then cites the act that answers it.',
            'On RL 6 Salzburg is a special case: according to the OIB overview no edition of guideline 6 is in force there, not even the 2019 edition that every other state adopted for RL 6. When Piloti gives an RL 6 requirement for a Salzburg project, it says that the guideline is not binding there according to the OIB overview, and points to state law.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti answers a question on a Salzburg project',
          items: [
            {
              name: 'Assign the question',
              body: 'Procedure or technology? That decides whether Piloti searches the Baupolizeigesetz or the Bautechnikgesetz. If the project lacks the state, it asks for it first.',
            },
            {
              name: 'Name the edition',
              body: 'If the answer hinges on an OIB guideline, Piloti says which edition the value comes from, and that the 2019 edition applies in Salzburg according to the OIB overview.',
            },
            {
              name: 'Cite like a permit',
              body: '“Baupolizeigesetz 1997, § …” or “Salzburger Bautechnikgesetz 2015, § …”, checked against the source text before it appears and opened from RIS at the marked passage.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops in Salzburg',
          items: [
            'Piloti does not replace the municipal building authority. Whether a project needs a permit, it confirms when in doubt.',
            'Piloti reads your municipality’s development plan only if it is in the project.',
            'How the state makes the OIB guidelines binding, with which exceptions and transition rules, you check in state law yourself.',
            'For a Salzburg project, an OIB value from an edition other than 2019 is a pointer, not evidence, until you have checked it.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which OIB guidelines apply in Salzburg?',
          a: 'According to the OIB overview (as of September 2025), Salzburg has not declared the 2023 OIB guidelines binding. Guidelines 1 to 5 in the 2019 edition are in force; for RL 6 the overview lists no edition as in force in Salzburg, not the 2025 edition either (as of July 2026). The rule in force is in state law.',
        },
        {
          q: 'Where can I read the Salzburg Bautechnikgesetz and Baupolizeigesetz in full?',
          a: 'Both in the federal legal information system (RIS), free of charge and in their current version. Piloti opens a cited passage from either act straight from RIS, marked.',
        },
        {
          q: 'Can Piloti answer questions on Salzburg building law?',
          a: 'Yes. Piloti answers questions on a Salzburg project from the Bautechnikgesetz 2015, the Baupolizeigesetz 1997 and the OIB guidelines, with a checked citation and its edition. It says which of the two acts answers the question.',
        },
        {
          q: 'Is there a Salzburg building code?',
          a: 'Not under that name. The jobs a building code does in other states are shared in Salzburg between the Bautechnikgesetz 2015 (requirements on buildings) and the Baupolizeigesetz 1997 (permits, exempt measures, notification).',
        },
        {
          q: 'When is a notification enough in Salzburg?',
          a: 'The Baupolizeigesetz 1997 governs that, together with what is exempt from a permit. Piloti finds the passage for your project and cites it; whether your case falls under it, the municipal building authority confirms when in doubt.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------- Tirol
  {
    slug: 'tirol',
    checked: '2026-09',
    related: ['baurecht/vorarlberg', 'baurecht/salzburg', 'baurecht/kaernten', 'glossar/oib-richtlinien', 'glossar/ris', 'anwendungen/einreichcheck', 'anwendungen/bebauung'],
    de: {
      title: 'Tiroler Bauordnung 2022 und OIB-Richtlinien: Baurecht KI',
      description:
        'Bauordnung Tirol: Tiroler Bauordnung 2022, seit 16.7.2026 OIB-Richtlinien 1–5 Ausgabe 2023 und RL 6 Ausgabe 2025. Was sich geändert hat, belegt von Piloti.',
      heading: 'Baurecht in Tirol: Tiroler Bauordnung 2022 und OIB-Richtlinien',
      lede: 'In Tirol hat sich im Sommer 2026 die technische Grundlage verschoben. Laut OIB-Übersicht gelten seit 16.7.2026 die Richtlinien 1 bis 5 in der Ausgabe 2023 und die Richtlinie 6 gleich in der Ausgabe 2025. Die RL 6 Ausgabe 2023 hat Tirol übersprungen.',
      note: 'OIB-Stand laut OIB-Übersicht „Inkrafttreten der OIB-Richtlinien“ und, für die RL 6 Ausgabe 2025, Stand Juli 2026. Gesetzestext aus dem RIS.',
      answer:
        'In Tirol gilt die Tiroler Bauordnung 2022. Laut OIB-Übersicht sind dort seit 16.7.2026 die OIB-Richtlinien 1 bis 5 in der Ausgabe 2023 und die OIB-Richtlinie 6 in der Ausgabe 2025 verbindlich; die RL 6 Ausgabe 2023 war in Tirol laut Übersicht nicht in Kraft.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was in Tirol gilt',
          body: 'Diese Quellen zieht Piloti für ein Projekt in Tirol heran.',
          items: [
            {
              name: 'Tiroler Bauordnung 2022',
              body: 'Bauansuchen und Baubewilligung in Tirol. Zitiert als „Tiroler Bauordnung 2022“, damit keine Vorgängerfassung gemeint sein kann.',
            },
            {
              name: 'OIB-Richtlinien 1–5',
              body: 'Ausgabe 2023, laut OIB-Übersicht seit 16.7.2026 verbindlich.',
            },
            {
              name: 'OIB-Richtlinie 6',
              body: 'Ausgabe 2025, laut OIB-Übersicht (Stand: Juli 2026) seit 16.7.2026 verbindlich. Die Ausgabe 2023 der RL 6 ist in Tirol laut Übersicht nicht in Kraft getreten.',
            },
            {
              name: 'Bundesrecht',
              body: 'Forstgesetz, Wasserrechtsgesetz, Denkmalschutzgesetz, UVP-G: mit eigenem Verfahren neben der Baubewilligung, wo das Projekt sie berührt.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Was sich am 16.7.2026 geändert hat',
          body: [
            'Bis Mitte Juli 2026 galt in Tirol laut OIB-Übersicht die Ausgabe 2019. Seit 16.7.2026 stehen zwei neuere Ausgaben nebeneinander: 2023 für Standsicherheit, Brandschutz, Hygiene, Nutzungssicherheit und Schallschutz, 2025 für Energieeinsparung und Wärmeschutz. Ein Projekt, das vor dem Stichtag eingereicht wurde, kann noch unter die Ausgabe 2019 fallen. Das entscheidet das Übergangsrecht des Landes.',
            'Für ein Tiroler Büro heißt das: Es kann in einem Jahr drei OIB-Ausgaben in laufenden Projekten haben. Piloti nennt deshalb bei jeder Anforderung Richtlinie, Punkt und Ausgabe, fragt nach dem Einreichdatum, wenn die Antwort daran hängt, und stellt auf Wunsch die alte und die neue Anforderung in Tabs nebeneinander.',
          ],
        },
        {
          kind: 'steps',
          title: 'So beantwortet Piloti eine Frage zu einem Tiroler Projekt',
          items: [
            {
              name: 'Stichtag klären',
              body: 'Liegt die Einreichung vor oder nach dem 16.7.2026? Steht das nicht im Projekt, fragt Piloti oder schreibt dazu, welche Ausgabe es angenommen hat.',
            },
            {
              name: 'Belegen',
              body: '„Tiroler Bauordnung 2022, § …“ oder „OIB-RL 6, Pkt. …“ mit Ausgabe, vor dem Anzeigen gegen den Quelltext geprüft.',
            },
            {
              name: 'Im RIS nachlesen',
              body: 'Die zitierte Stelle der Bauordnung öffnet Piloti aus dem RIS, markiert, damit Sie sie im Zusammenhang lesen.',
            },
            {
              name: 'Offenes festhalten',
              body: 'Bleibt die Ausgabe ungeklärt, wird daraus ein offener Punkt im Projekt, den jemand im Team mit „Klären“ zur eigenen Aufgabe macht.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti in Tirol aufhört',
          items: [
            'Piloti ersetzt nicht die Baubehörde der Gemeinde. Die Entscheidung über das Ansuchen trifft sie.',
            'Den Bebauungsplan Ihrer Gemeinde liest Piloti nur, wenn er im Projekt liegt. Sonst sagt es, dass er fehlt.',
            'Welche Ausgabe ein Verfahren rund um den 16.7.2026 trifft und welche Ausnahmen das Land vorsieht, steht in der Verordnung, mit der Tirol die Richtlinien verbindlich erklärt. Das prüfen Sie selbst.',
            'Nennt Piloti eine Anforderung aus einer anderen Ausgabe als der in Tirol geltenden, sagt es das dazu. Den Wert gleichen Sie dann mit der geltenden Ausgabe ab.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche OIB-Richtlinien gelten in Tirol?',
          a: 'Laut OIB-Übersicht gelten in Tirol seit 16.7.2026 die OIB-Richtlinien 1 bis 5 in der Ausgabe 2023 und die RL 6 in der Ausgabe 2025 (Stand: Juli 2026). Die RL 6 Ausgabe 2023 war in Tirol nicht in Kraft. Für Verfahren vor diesem Tag können Übergangsregeln des Landes noch die Ausgabe 2019 vorsehen.',
        },
        {
          q: 'Wo finde ich die Tiroler Bauordnung 2022 im Volltext?',
          a: 'Im Rechtsinformationssystem des Bundes (RIS), kostenlos und in der geltenden Fassung. Piloti öffnet eine zitierte Stelle direkt aus dem RIS, markiert.',
        },
        {
          q: 'Kann Piloti Fragen zur Tiroler Bauordnung beantworten?',
          a: 'Ja. Piloti beantwortet Fragen zu einem Tiroler Projekt aus der Tiroler Bauordnung 2022 und den OIB-Richtlinien, mit geprüfter Fundstelle und der Ausgabe je Richtlinie. Hängt die Antwort am Einreichdatum, fragt es danach.',
        },
        {
          q: 'Warum gilt in Tirol die RL 6 Ausgabe 2025, aber nicht 2023?',
          a: 'Jedes Land erklärt OIB-Ausgaben selbst für verbindlich, auch je Richtlinie. Laut OIB-Übersicht hat Tirol die Richtlinien 1 bis 5 in der Ausgabe 2023 übernommen und für die RL 6 gleich die Ausgabe 2025, beide zum 16.7.2026. Die Gründe nennt die Übersicht nicht.',
        },
      ],
    },
    en: {
      title: 'Tyrol building code 2022 and OIB guidelines: AI help',
      description:
        'Tyrol building law: Tiroler Bauordnung 2022; since 16 July 2026 OIB guidelines 1–5 in the 2023 edition and RL 6 in the 2025 edition. What changed.',
      heading: 'Building law in Tyrol: Tiroler Bauordnung 2022 and OIB guidelines',
      lede: 'In Tyrol the technical basis shifted in summer 2026. According to the OIB overview, guidelines 1 to 5 in the 2023 edition and guideline 6 straight in the 2025 edition have applied since 16 July 2026. Tyrol skipped RL 6 in the 2023 edition.',
      note: 'OIB status per the OIB overview “Inkrafttreten der OIB-Richtlinien” and, for RL 6 edition 2025, as of July 2026. Legal text from RIS.',
      answer:
        'Tyrol applies the Tiroler Bauordnung 2022. According to the OIB overview, OIB guidelines 1 to 5 in the 2023 edition and OIB guideline 6 in the 2025 edition have been binding there since 16 July 2026; RL 6 in the 2023 edition was not in force in Tyrol according to the overview.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What applies in Tyrol',
          body: 'Piloti draws on these sources for a project in Tyrol.',
          items: [
            {
              name: 'Tiroler Bauordnung 2022',
              body: 'Applications and permits in Tyrol. Cited as “Tiroler Bauordnung 2022”, so no earlier version can be meant.',
            },
            {
              name: 'OIB guidelines 1–5',
              body: '2023 edition, binding since 16 July 2026 according to the OIB overview.',
            },
            {
              name: 'OIB guideline 6',
              body: '2025 edition, binding since 16 July 2026 according to the OIB overview (as of July 2026). RL 6 in the 2023 edition did not come into force in Tyrol according to the overview.',
            },
            {
              name: 'Federal law',
              body: 'Forestry act, water rights act, monuments act, UVP-G: with their own procedures alongside the building permit, where the project touches them.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'What changed on 16 July 2026',
          body: [
            'Until mid-July 2026 Tyrol applied the 2019 edition according to the OIB overview. Since 16 July 2026 two newer editions sit side by side: 2023 for structural safety, fire safety, hygiene, safety in use and sound insulation, 2025 for energy saving and thermal protection. A project filed before that date may still fall under the 2019 edition. The state’s transition law decides that.',
            'For a Tyrolean office this means three OIB editions can be live across its projects within one year. Piloti therefore names guideline, clause and edition for every requirement, asks for the submission date when the answer depends on it, and on request sets the old and the new requirement side by side in tabs.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti answers a question on a Tyrolean project',
          items: [
            {
              name: 'Settle the date',
              body: 'Was the application filed before or after 16 July 2026? If the project does not say, Piloti asks or states which edition it assumed.',
            },
            {
              name: 'Cite',
              body: '“Tiroler Bauordnung 2022, § …” or “OIB-RL 6, Pkt. …” with its edition, checked against the source text before it appears.',
            },
            {
              name: 'Read it in RIS',
              body: 'Piloti opens the cited passage of the building code from RIS, marked, so you read it in context.',
            },
            {
              name: 'Record what is open',
              body: 'If the edition stays unresolved, it becomes an open point in the project that someone on the team turns into their own task with “Klären”.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops in Tyrol',
          items: [
            'Piloti does not replace the municipal building authority. It decides on the application.',
            'Piloti reads your municipality’s development plan only if it is in the project. Otherwise it says the plan is missing.',
            'Which edition governs a procedure around 16 July 2026, and which exceptions the state provides, is in the ordinance by which Tyrol declares the guidelines binding. You check that yourself.',
            'If Piloti gives a requirement from an edition other than the one in force in Tyrol, it says so. Check the value against the edition in force.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which OIB guidelines apply in Tyrol?',
          a: 'According to the OIB overview, Tyrol has applied OIB guidelines 1 to 5 in the 2023 edition and RL 6 in the 2025 edition since 16 July 2026 (as of July 2026). RL 6 in the 2023 edition was not in force in Tyrol. For procedures before that date the state’s transition rules may still point to the 2019 edition.',
        },
        {
          q: 'Where can I read the Tiroler Bauordnung 2022 in full?',
          a: 'In the federal legal information system (RIS), free of charge and in its current version. Piloti opens a cited passage straight from RIS, marked.',
        },
        {
          q: 'Can Piloti answer questions on the Tyrol building code?',
          a: 'Yes. Piloti answers questions on a Tyrolean project from the Tiroler Bauordnung 2022 and the OIB guidelines, with a checked citation and the edition for each guideline. If the answer depends on the submission date, it asks for it.',
        },
        {
          q: 'Why does Tyrol apply RL 6 in the 2025 edition but not 2023?',
          a: 'Each state declares OIB editions binding itself, guideline by guideline if it wants. According to the OIB overview, Tyrol adopted guidelines 1 to 5 in the 2023 edition and went straight to the 2025 edition for RL 6, both as of 16 July 2026. The overview gives no reasons.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------- Vorarlberg
  {
    slug: 'vorarlberg',
    checked: '2026-09',
    related: ['baurecht/tirol', 'glossar/oib-richtlinien', 'glossar/ris', 'anwendungen/einreichcheck', 'anwendungen/bebauung'],
    de: {
      title: 'Bauordnung Vorarlberg: Baugesetz und OIB-Richtlinien',
      description:
        'Bauordnung Vorarlberg heißt Baugesetz (Vbg. BauG). Welche OIB-Richtlinien laut OIB-Übersicht gelten, was anders ist als in Tirol, wie Piloti belegt.',
      heading: 'Baurecht in Vorarlberg: Baugesetz und OIB-Richtlinien',
      lede: 'Vorarlberg regelt das Bauen im Baugesetz, kurz Vbg. BauG. Bei den OIB-Richtlinien geht das Land laut OIB-Übersicht einen anderen Weg als der Nachbar Tirol: Die Ausgaben 2023 und 2025 sind dort nicht in Kraft.',
      note: 'OIB-Stand laut OIB-Übersicht „Inkrafttreten der OIB-Richtlinien“: Ausgabe 2023 Stand September 2025, RL 6 Ausgabe 2025 Stand Juli 2026. Gesetzestext aus dem RIS.',
      answer:
        'In Vorarlberg gilt das Baugesetz (Vbg. BauG). Laut OIB-Übersicht (Stand: September 2025) hat Vorarlberg die OIB-Richtlinien 2023 nicht für verbindlich erklärt, und die RL 6 Ausgabe 2025 ist dort laut Übersicht (Stand: Juli 2026) ebenfalls nicht in Kraft; es gilt in der Regel weiter die Ausgabe 2019.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was in Vorarlberg gilt',
          body: 'Diese Quellen zieht Piloti für ein Projekt in Vorarlberg heran.',
          items: [
            {
              name: 'Baugesetz (Vbg. BauG)',
              body: 'Das Vorarlberger Gegenstück zur Bauordnung: Bauansuchen und Baubewilligung. Zitiert als „Baugesetz“ mit Landeskürzel, damit es nicht mit einem anderen Baugesetz verwechselt wird.',
            },
            {
              name: 'OIB-Richtlinien',
              body: 'Laut OIB-Übersicht ist die Ausgabe 2023 in Vorarlberg für keine Richtlinie in Kraft, die RL 6 Ausgabe 2025 ebenso wenig. In Kraft sind die OIB-Richtlinien 2019.',
            },
            {
              name: 'Bundesrecht',
              body: 'Gewerbeordnung für Betriebsanlagen, ASchG und Arbeitsstättenverordnung für Arbeitsstätten, Denkmalschutzgesetz: neben dem Baugesetz, wo das Projekt sie berührt.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Zwei Nachbarn, zwei Stände',
          body: [
            'Wer am Arlberg auf beiden Seiten plant, hat seit 16.7.2026 laut OIB-Übersicht zwei verschiedene technische Grundlagen: in Tirol die Ausgaben 2023 und 2025, in Vorarlberg die Ausgabe 2019. Eine Anforderung, die ein Büro gerade für ein Tiroler Projekt nachgeschlagen hat, gilt für das Vorarlberger nicht zwingend.',
            'Piloti hält das Bundesland im Projekt fest und nennt bei jeder OIB-Anforderung die Ausgabe. Stammt ein Wert aus einer anderen Ausgabe als 2019, sagt die Antwort das. Auf Wunsch stellt Piloti Vorarlberg und Tirol in Tabs nebeneinander, jede Seite mit eigener Quelle.',
          ],
        },
        {
          kind: 'steps',
          title: 'So beantwortet Piloti eine Frage zu einem Vorarlberger Projekt',
          items: [
            {
              name: 'Land aus dem Projekt',
              body: 'Piloti liest das Bundesland aus dem Projekt. Fehlt es, fragt es einmal, statt vom Standort des Büros auszugehen.',
            },
            {
              name: 'Zitieren wie ein Bescheid',
              body: '„Baugesetz, § …“ mit Landesbezug oder „OIB-RL 2, Pkt. …“ mit Ausgabe, vor dem Anzeigen gegen den Quelltext geprüft.',
            },
            {
              name: 'Im RIS öffnen',
              body: 'Die Stelle im Baugesetz öffnet Piloti aus dem RIS, markiert. Sie lesen den Paragrafen, bevor Sie ihn in einen Aktenvermerk übernehmen.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti in Vorarlberg aufhört',
          items: [
            'Piloti ersetzt nicht die Baubehörde der Gemeinde. Ob gebaut werden darf, entscheidet sie.',
            'Was der Bebauungsplan Ihrer Gemeinde festlegt, liest Piloti nur aus dem Plan im Projekt.',
            'Mit welcher Verordnung das Land die OIB-Richtlinien verbindlich erklärt und mit welchen Ausnahmen, prüfen Sie im Landesrecht selbst. Piloti nennt den Stand laut OIB-Übersicht.',
            'Ein OIB-Wert aus der Ausgabe 2023 ist für ein Vorarlberger Projekt ein Hinweis, bis Sie ihn mit der Ausgabe 2019 abgeglichen haben.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche OIB-Richtlinien gelten in Vorarlberg?',
          a: 'Laut OIB-Übersicht (Stand: September 2025) hat Vorarlberg die OIB-Richtlinien 2023 nicht für verbindlich erklärt; die RL 6 Ausgabe 2025 ist laut Übersicht (Stand: Juli 2026) dort ebenfalls nicht in Kraft. In Kraft sind die OIB-Richtlinien 2019. Ausnahmen und Übergangsregeln stehen im Landesrecht.',
        },
        {
          q: 'Wo finde ich das Vorarlberger Baugesetz im Volltext?',
          a: 'Im Rechtsinformationssystem des Bundes (RIS), kostenlos und in der geltenden Fassung, unter dem Titel „Baugesetz“ im Landesrecht Vorarlberg. Piloti öffnet eine zitierte Stelle direkt aus dem RIS, markiert.',
        },
        {
          q: 'Kann Piloti Fragen zum Vorarlberger Baugesetz beantworten?',
          a: 'Ja, mit Fundstelle aus dem Baugesetz und den OIB-Richtlinien, geprüft gegen den Quelltext, bevor sie erscheint. Bei OIB-Anforderungen sagt Piloti, aus welcher Ausgabe der Wert stammt, und dass in Vorarlberg laut OIB-Übersicht die Ausgabe 2019 gilt.',
        },
        {
          q: 'Gelten in Vorarlberg dieselben OIB-Richtlinien wie in Tirol?',
          a: 'Laut OIB-Übersicht nicht mehr. Tirol hat zum 16.7.2026 die Richtlinien 1 bis 5 in der Ausgabe 2023 und die RL 6 in der Ausgabe 2025 übernommen, Vorarlberg bleibt bei der Ausgabe 2019. Für Projekte auf beiden Seiten der Landesgrenze zählt jeweils das Land des Grundstücks.',
        },
      ],
    },
    en: {
      title: 'Vorarlberg building code: Baugesetz and OIB guidelines',
      description:
        'Vorarlberg’s building code is the Baugesetz (Vbg. BauG). Which OIB guidelines apply per the OIB overview, how that differs from Tyrol, how Piloti cites.',
      heading: 'Building law in Vorarlberg: Baugesetz and OIB guidelines',
      lede: 'Vorarlberg governs building in its Baugesetz, Vbg. BauG for short. On the OIB guidelines the state takes a different path from its neighbour Tyrol, according to the OIB overview: the 2023 and 2025 editions are not in force there.',
      note: 'OIB status per the OIB overview “Inkrafttreten der OIB-Richtlinien”: 2023 edition as of September 2025, RL 6 edition 2025 as of July 2026. Legal text from RIS.',
      answer:
        'Vorarlberg applies the Baugesetz (Vbg. BauG). According to the OIB overview (as of September 2025), Vorarlberg has not declared the 2023 OIB guidelines binding, and RL 6, edition 2025, is not in force there either according to the overview (as of July 2026); the 2019 edition generally still applies.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What applies in Vorarlberg',
          body: 'Piloti draws on these sources for a project in Vorarlberg.',
          items: [
            {
              name: 'Baugesetz (Vbg. BauG)',
              body: 'Vorarlberg’s counterpart to a building code: applications and permits. Cited as “Baugesetz” with the state abbreviation, so it is not confused with another Baugesetz.',
            },
            {
              name: 'OIB guidelines',
              body: 'According to the OIB overview, the 2023 edition is in force in Vorarlberg for no guideline, nor RL 6 in the 2025 edition. The 2019 OIB guidelines are in force.',
            },
            {
              name: 'Federal law',
              body: 'Trade code for commercial facilities, ASchG and the workplace ordinance for workplaces, monuments act: alongside the Baugesetz, where the project touches them.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Two neighbours, two states of play',
          body: [
            'Anyone planning on both sides of the Arlberg has had two different technical bases since 16 July 2026, according to the OIB overview: the 2023 and 2025 editions in Tyrol, the 2019 edition in Vorarlberg. A requirement an office just looked up for a Tyrolean project does not necessarily apply to the one in Vorarlberg.',
            'Piloti keeps the state in the project and names the edition for every OIB requirement. If a value comes from an edition other than 2019, the answer says so. On request Piloti sets Vorarlberg and Tyrol side by side in tabs, each with its own source.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti answers a question on a Vorarlberg project',
          items: [
            {
              name: 'State from the project',
              body: 'Piloti reads the state from the project. If it is missing, it asks once instead of assuming the office’s location.',
            },
            {
              name: 'Cite like a permit',
              body: '“Baugesetz, § …” with the state reference or “OIB-RL 2, Pkt. …” with its edition, checked against the source text before it appears.',
            },
            {
              name: 'Open it in RIS',
              body: 'Piloti opens the passage in the Baugesetz from RIS, marked. You read the section before you take it into a file note.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops in Vorarlberg',
          items: [
            'Piloti does not replace the municipal building authority. Whether you may build, it decides.',
            'What your municipality’s development plan fixes, Piloti reads only from the plan in the project.',
            'Which ordinance declares the OIB guidelines binding in the state, and with which exceptions, you check in state law yourself. Piloti gives the status per the OIB overview.',
            'For a Vorarlberg project, an OIB value from the 2023 edition is a pointer until you have checked it against the 2019 edition.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which OIB guidelines apply in Vorarlberg?',
          a: 'According to the OIB overview (as of September 2025), Vorarlberg has not declared the 2023 OIB guidelines binding; RL 6, edition 2025, is not in force there either according to the overview (as of July 2026). The 2019 OIB guidelines are in force. Exceptions and transition rules are in state law.',
        },
        {
          q: 'Where can I read the Vorarlberg Baugesetz in full?',
          a: 'In the federal legal information system (RIS), free of charge and in its current version, under the title “Baugesetz” in Vorarlberg state law. Piloti opens a cited passage straight from RIS, marked.',
        },
        {
          q: 'Can Piloti answer questions on the Vorarlberg Baugesetz?',
          a: 'Yes, with a citation from the Baugesetz and the OIB guidelines, checked against the source text before it appears. For OIB requirements Piloti says which edition the value comes from, and that the 2019 edition applies in Vorarlberg according to the OIB overview.',
        },
        {
          q: 'Do the same OIB guidelines apply in Vorarlberg as in Tyrol?',
          a: 'Not any more, according to the OIB overview. Tyrol adopted guidelines 1 to 5 in the 2023 edition and RL 6 in the 2025 edition as of 16 July 2026; Vorarlberg stays with the 2019 edition. For projects on either side of the state border, the state the plot lies in counts.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------- Burgenland
  {
    slug: 'burgenland',
    checked: '2026-09',
    related: ['baurecht/niederoesterreich', 'baurecht/steiermark', 'glossar/oib-richtlinien', 'glossar/ris', 'anwendungen/einreichcheck', 'anwendungen/bebauung'],
    de: {
      title: 'Bauordnung Burgenland: Baugesetz 1997 und OIB-Richtlinien',
      description:
        'Bauordnung Burgenland heißt Burgenländisches Baugesetz 1997. Welche OIB-Richtlinien laut OIB-Übersicht gelten und warum andere als in Niederösterreich.',
      heading: 'Baurecht im Burgenland: Burgenländisches Baugesetz 1997 und OIB-Richtlinien',
      lede: 'Wer aus Wien oder Niederösterreich für das Burgenland plant, wechselt die OIB-Ausgabe: Dort gelten die Richtlinien 2023, im Burgenland laut OIB-Übersicht noch die Ausgabe 2019. Das Landesgesetz heißt Burgenländisches Baugesetz 1997.',
      note: 'OIB-Stand laut OIB-Übersicht „Inkrafttreten der OIB-Richtlinien“: Ausgabe 2023 Stand September 2025, RL 6 Ausgabe 2025 Stand Juli 2026. Gesetzestext aus dem RIS.',
      answer:
        'Im Burgenland gilt das Burgenländische Baugesetz 1997. Laut OIB-Übersicht (Stand: September 2025) hat das Burgenland die OIB-Richtlinien 2023 nicht für verbindlich erklärt, und die RL 6 Ausgabe 2025 ist dort laut Übersicht (Stand: Juli 2026) ebenfalls nicht in Kraft; es gilt in der Regel weiter die Ausgabe 2019.',
      blocks: [
        {
          kind: 'pairs',
          title: 'Was im Burgenland gilt',
          body: 'Diese Quellen zieht Piloti für ein Projekt im Burgenland heran.',
          items: [
            {
              name: 'Burgenländisches Baugesetz 1997',
              body: 'Bauansuchen und Baubewilligung im Burgenland, unter diesem Namen zitiert. Wer nach „Bauordnung Burgenland“ sucht, meint dieses Gesetz.',
            },
            {
              name: 'OIB-Richtlinien',
              body: 'Laut OIB-Übersicht ist die Ausgabe 2023 im Burgenland für keine der sechs Richtlinien in Kraft, die RL 6 Ausgabe 2025 ebenso wenig. In Kraft sind die OIB-Richtlinien 2019.',
            },
            {
              name: 'Bundesrecht',
              body: 'Wasserrechtsgesetz, Denkmalschutzgesetz, Gewerbeordnung, UVP-G: mit eigenem Verfahren neben der Baubewilligung, wo das Projekt sie berührt.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'Die Ausgabe aus dem Nachbarland ist nicht die richtige',
          body: [
            'Ein Büro in Wien oder Niederösterreich arbeitet im Alltag laut OIB-Übersicht mit der Ausgabe 2023. Plant es im Burgenland, gilt dort die Ausgabe 2019. Eine Anforderung, die zwischen den Ausgaben geändert wurde, kann dann im Einreichplan mit dem falschen Wert stehen, ohne dass es beim Zeichnen auffällt.',
            'Piloti nennt bei jeder OIB-Anforderung die Ausgabe. Stammt ein Wert aus der Ausgabe 2023, sagt die Antwort das und weist darauf hin, dass im Burgenland die Ausgabe 2019 gilt. Wer zwei Standorte prüft, bekommt Burgenland und Niederösterreich auf Wunsch in Tabs nebeneinander.',
          ],
        },
        {
          kind: 'steps',
          title: 'So beantwortet Piloti eine Frage zu einem burgenländischen Projekt',
          items: [
            {
              name: 'Bundesland prüfen',
              body: 'Piloti nimmt das Bundesland aus dem Projekt, nicht aus dem Sitz des Büros. Fehlt es, fragt es einmal nach.',
            },
            {
              name: 'Belegen',
              body: '„Burgenländisches Baugesetz 1997, § …“ oder „OIB-RL 3, Pkt. …“ mit Ausgabe, vor dem Anzeigen gegen den Quelltext geprüft.',
            },
            {
              name: 'Nachlesen',
              body: 'Ein Klick öffnet die Stelle im Baugesetz aus dem RIS in Piloti, markiert.',
            },
            {
              name: 'Einreichung vorbereiten',
              body: 'Im Einreichcheck sagt Piloti, was dem Paket für die Baubehörde noch fehlt. Ob der Entwurf den Anforderungen entspricht, ist eine eigene Prüfung.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti im Burgenland aufhört',
          items: [
            'Piloti ersetzt nicht die Baubehörde der Gemeinde. Die Bewilligung erteilt sie.',
            'Den Bebauungsplan Ihrer Gemeinde liest Piloti nur, wenn er im Projekt liegt. Fehlt er, sagt es das, statt einen Wert anzunehmen.',
            'Mit welcher Verordnung das Land die OIB-Richtlinien verbindlich erklärt, mit welchen Ausnahmen und Übergangsregeln, prüfen Sie im Landesrecht selbst.',
            'Ein Wert aus der Ausgabe 2023 ist für ein Projekt im Burgenland ein Hinweis, bis Sie ihn mit der Ausgabe 2019 abgeglichen haben.',
          ],
        },
      ],
      faq: [
        {
          q: 'Welche OIB-Richtlinien gelten im Burgenland?',
          a: 'Laut OIB-Übersicht (Stand: September 2025) hat das Burgenland die OIB-Richtlinien 2023 nicht für verbindlich erklärt; die RL 6 Ausgabe 2025 ist laut Übersicht (Stand: Juli 2026) dort ebenfalls nicht in Kraft. In Kraft sind die OIB-Richtlinien 2019. Ausnahmen und Übergangsregeln stehen im Landesrecht.',
        },
        {
          q: 'Wo finde ich das Burgenländische Baugesetz 1997 im Volltext?',
          a: 'Im Rechtsinformationssystem des Bundes (RIS), kostenlos und in der geltenden Fassung. Piloti öffnet eine zitierte Stelle direkt aus dem RIS, markiert.',
        },
        {
          q: 'Kann Piloti Fragen zum Burgenländischen Baugesetz beantworten?',
          a: 'Ja, mit Fundstelle aus dem Baugesetz und den OIB-Richtlinien, geprüft gegen den Quelltext, bevor sie erscheint. Bei OIB-Anforderungen sagt Piloti, aus welcher Ausgabe der Wert stammt, und dass im Burgenland laut OIB-Übersicht die Ausgabe 2019 gilt.',
        },
        {
          q: 'Gelten im Burgenland dieselben OIB-Richtlinien wie in Niederösterreich?',
          a: 'Laut OIB-Übersicht nicht. Niederösterreich hat die OIB-Richtlinien 2023 zum 18.3.2025 verbindlich erklärt, das Burgenland nicht. Für ein Projekt zählt das Land, in dem das Grundstück liegt, nicht das, in dem das Büro sitzt.',
        },
      ],
    },
    en: {
      title: 'Burgenland building code: Baugesetz 1997 and OIB guidelines',
      description:
        'Burgenland’s building code is the Burgenländisches Baugesetz 1997. Which OIB guidelines apply per the OIB overview, and why not those of Lower Austria.',
      heading: 'Building law in Burgenland: Burgenländisches Baugesetz 1997 and OIB guidelines',
      lede: 'An office from Vienna or Lower Austria planning in Burgenland changes OIB edition: the 2023 guidelines apply at home; in Burgenland, according to the OIB overview, the 2019 edition still does. The state act is called the Burgenländisches Baugesetz 1997.',
      note: 'OIB status per the OIB overview “Inkrafttreten der OIB-Richtlinien”: 2023 edition as of September 2025, RL 6 edition 2025 as of July 2026. Legal text from RIS.',
      answer:
        'Burgenland applies the Burgenländisches Baugesetz 1997. According to the OIB overview (as of September 2025), Burgenland has not declared the 2023 OIB guidelines binding, and RL 6, edition 2025, is not in force there either according to the overview (as of July 2026); the 2019 edition generally still applies.',
      blocks: [
        {
          kind: 'pairs',
          title: 'What applies in Burgenland',
          body: 'Piloti draws on these sources for a project in Burgenland.',
          items: [
            {
              name: 'Burgenländisches Baugesetz 1997',
              body: 'Applications and permits in Burgenland, cited under this name. Anyone searching for Burgenland’s “building code” means this act.',
            },
            {
              name: 'OIB guidelines',
              body: 'According to the OIB overview, the 2023 edition is in force in Burgenland for none of the six guidelines, nor RL 6 in the 2025 edition. The 2019 OIB guidelines are in force.',
            },
            {
              name: 'Federal law',
              body: 'Water rights act, monuments act, trade code, UVP-G: with their own procedures alongside the building permit, where the project touches them.',
            },
          ],
        },
        {
          kind: 'text',
          title: 'The neighbour’s edition is not the right one',
          body: [
            'An office in Vienna or Lower Austria works day to day with the 2023 edition, according to the OIB overview. When it plans in Burgenland, the 2019 edition applies there. A requirement that changed between editions can then end up in the submission drawing with the wrong value, without anyone noticing while drawing.',
            'Piloti names the edition for every OIB requirement. If a value comes from the 2023 edition, the answer says so and points out that the 2019 edition applies in Burgenland. Anyone weighing two sites gets Burgenland and Lower Austria side by side in tabs on request.',
          ],
        },
        {
          kind: 'steps',
          title: 'How Piloti answers a question on a Burgenland project',
          items: [
            {
              name: 'Check the state',
              body: 'Piloti takes the state from the project, not from where the office sits. If it is missing, it asks once.',
            },
            {
              name: 'Cite',
              body: '“Burgenländisches Baugesetz 1997, § …” or “OIB-RL 3, Pkt. …” with its edition, checked against the source text before it appears.',
            },
            {
              name: 'Read it',
              body: 'One click opens the passage in the Baugesetz from RIS inside Piloti, marked.',
            },
            {
              name: 'Prepare the submission',
              body: 'In the submission check Piloti says what the package for the building authority still lacks. Whether the design meets the requirements is a separate check.',
            },
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops in Burgenland',
          items: [
            'Piloti does not replace the municipal building authority. It grants the permit.',
            'Piloti reads your municipality’s development plan only if it is in the project. If it is missing, it says so instead of assuming a value.',
            'Which ordinance declares the OIB guidelines binding in the state, with which exceptions and transition rules, you check in state law yourself.',
            'For a Burgenland project, a value from the 2023 edition is a pointer until you have checked it against the 2019 edition.',
          ],
        },
      ],
      faq: [
        {
          q: 'Which OIB guidelines apply in Burgenland?',
          a: 'According to the OIB overview (as of September 2025), Burgenland has not declared the 2023 OIB guidelines binding; RL 6, edition 2025, is not in force there either according to the overview (as of July 2026). The 2019 OIB guidelines are in force. Exceptions and transition rules are in state law.',
        },
        {
          q: 'Where can I read the Burgenländisches Baugesetz 1997 in full?',
          a: 'In the federal legal information system (RIS), free of charge and in its current version. Piloti opens a cited passage straight from RIS, marked.',
        },
        {
          q: 'Can Piloti answer questions on the Burgenland Baugesetz?',
          a: 'Yes, with a citation from the Baugesetz and the OIB guidelines, checked against the source text before it appears. For OIB requirements Piloti says which edition the value comes from, and that the 2019 edition applies in Burgenland according to the OIB overview.',
        },
        {
          q: 'Do the same OIB guidelines apply in Burgenland as in Lower Austria?',
          a: 'Not according to the OIB overview. Lower Austria declared the 2023 OIB guidelines binding as of 18 March 2025; Burgenland did not. For a project, the state the plot lies in counts, not the one the office sits in.',
        },
      ],
    },
  },
]
