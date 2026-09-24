/**
 * Two live answers as the WebSocket delivered them (2026-09-24, ADR-0066): the
 * masthead ahead of the prose, the prose deltas, the settled snapshot, the
 * live cards, and the terminal frame with its cards and anatomy, each
 * stamped with its second since the turn began. Recorded, not written: the replay at `/dev/stream-replay` is only as honest as these.
 */

export interface RecordedFrame {
  t: number
  status: 'in_progress' | 'complete'
  content: string
  stream_replace?: boolean
  sources?: unknown[]
  cards?: unknown[]
  answer_meta?: unknown
  answer_confidence?: 'low' | 'medium' | 'high'
  /** Every other extra the frame carried, kept as recorded. */
  [extra: string]: unknown
}

export interface RecordedTurn {
  question: string
  frames: RecordedFrame[]
}

export const STREAM_FRAMES: Record<'varianten' | 'oib2', RecordedTurn> = {
 "varianten": {
  "question": "Neubau Wohngebäude in Gebäudeklasse 4, Wien: Für den zweiten Fluchtweg vergleichen wir eine offene Außentreppe mit einem zweiten Treppenhaus. Was müssten wir bei jeder Variante nachweisen?",
  "frames": [
   {
    "t": 91.295,
    "status": "in_progress",
    "content": "",
    "answer_meta": {
     "v": 1,
     "kind": "ruling",
     "summary": "Tragen Sie die gewählte Lösung mit Wegführung, Bauteilaufbauten und den jeweiligen Nachweisen in den Brandschutznachweis ein. Vor Einreichung ist noch die in Wien für das Verfahren maßgebliche OIB-Ausgabe zu bestätigen.",
     "verdict": {
      "value": "Außentreppe: A2; Treppenhaus: REI 60",
      "subject": "Wesentliche Brandschutzanforderung für den zweiten Fluchtweg in GK 4",
      "reference": {
       "document": "OIB-Richtlinie 2",
       "section": "Tabelle 3",
       "edition": "Ausgabe Mai 2023"
      }
     },
     "topic": "Zweiter Fluchtweg",
     "context": "OIB-Richtlinie 2, Ausgabe Mai 2023 · Wien"
    }
   },
   {
    "t": 91.478,
    "status": "in_progress",
    "content": "**Die Außentreppe ist in GK 4 in A2"
   },
   {
    "t": 91.57,
    "status": "in_progress",
    "content": " auszuführen; das zweite"
   },
   {
    "t": 91.641,
    "status": "in_progress",
    "content": " Treppenhaus braucht"
   },
   {
    "t": 91.723,
    "status": "in_progress",
    "content": " oberirdisch grundsätzlich"
   },
   {
    "t": 91.822,
    "status": "in_progress",
    "content": " Wände in REI 60/EI"
   },
   {
    "t": 91.913,
    "status": "in_progress",
    "content": " 60 und Treppenläufe und Podeste in R"
   },
   {
    "t": 92.017,
    "status": "in_progress",
    "content": " 60** "
   },
   {
    "t": 92.102,
    "status": "in_progress",
    "content": "[2]. Für beide"
   },
   {
    "t": 92.222,
    "status": "in_progress",
    "content": " Varianten ist nicht nur die"
   },
   {
    "t": 92.274,
    "status": "in_progress",
    "content": " Treppe,"
   },
   {
    "t": 92.346,
    "status": "in_progress",
    "content": " sondern der unabhängige Fluchtweg"
   },
   {
    "t": 92.483,
    "status": "in_progress",
    "content": " bis zu einem sicheren Ort im Freien"
   },
   {
    "t": 92.586,
    "status": "in_progress",
    "content": " nachzuweisen:"
   },
   {
    "t": 92.644,
    "status": "in_progress",
    "content": " Bei der zusätzlichen Route"
   },
   {
    "t": 92.724,
    "status": "in_progress",
    "content": " nach Punkt 5.1.4"
   },
   {
    "t": 92.794,
    "status": "in_progress",
    "content": " ist die Gehwe"
   },
   {
    "t": 92.86,
    "status": "in_progress",
    "content": "glänge nicht begrenzt "
   },
   {
    "t": 92.926,
    "status": "in_progress",
    "content": "[1].\n\n"
   },
   {
    "t": 93.067,
    "status": "in_progress",
    "content": "| Nachweis | Offene Außentreppe | Zweites Tre"
   },
   {
    "t": 93.145,
    "status": "in_progress",
    "content": "ppenhaus |\n|---|---|---|\n"
   },
   {
    "t": 93.466,
    "status": "in_progress",
    "content": "| Unabhängige Wegführung | Weg zum weiteren, unabh"
   },
   {
    "t": 93.526,
    "status": "in_progress",
    "content": "ängigen Fluchtweg; Ausgang zu sicher"
   },
   {
    "t": 93.605,
    "status": "in_progress",
    "content": "em Ort im Freien | Weg zum"
   },
   {
    "t": 93.684,
    "status": "in_progress",
    "content": " weiteren, unabhängigen Fluchtweg; Ausgang zu sicher"
   },
   {
    "t": 93.736,
    "status": "in_progress",
    "content": "em Ort im Freien"
   },
   {
    "t": 93.86,
    "status": "in_progress",
    "content": " |\n| Feuerwiderstand der Treppe | A"
   },
   {
    "t": 93.943,
    "status": "in_progress",
    "content": "2 | Treppenläufe und Pod"
   },
   {
    "t": 94.007,
    "status": "in_progress",
    "content": "este: R 60 |"
   },
   {
    "t": 94.059,
    "status": "in_progress",
    "content": "\n"
   },
   {
    "t": 94.195,
    "status": "in_progress",
    "content": "| Brandbeanspruchung | Im Brandfall keine Beeinträ"
   },
   {
    "t": 94.257,
    "status": "in_progress",
    "content": "chtigung durch Flammeneinwirkung"
   },
   {
    "t": 94.319,
    "status": "in_progress",
    "content": " oder gefährdende Strahlungswär"
   },
   {
    "t": 94.394,
    "status": "in_progress",
    "content": "me | Treppenhauswände ober"
   },
   {
    "t": 94.445,
    "status": "in_progress",
    "content": "irdisch: REI 60/EI"
   },
   {
    "t": 94.521,
    "status": "in_progress",
    "content": " 60; unter"
   },
   {
    "t": 94.602,
    "status": "in_progress",
    "content": "irdisch: REI "
   },
   {
    "t": 94.672,
    "status": "in_progress",
    "content": "90 und A2/EI 90 und A2;"
   },
   {
    "t": 94.773,
    "status": "in_progress",
    "content": " Decke darüber: REI 60"
   },
   {
    "t": 94.858,
    "status": "in_progress",
    "content": " |\n"
   },
   {
    "t": 95.002,
    "status": "in_progress",
    "content": "| Türen | Nachweis der für den Flucht"
   },
   {
    "t": 95.076,
    "status": "in_progress",
    "content": "weg und seine Anschlüsse geltenden Tür"
   },
   {
    "t": 95.166,
    "status": "in_progress",
    "content": "anforderungen |"
   },
   {
    "t": 95.217,
    "status": "in_progress",
    "content": " Zu Wohnungen: EI₂ 30;"
   },
   {
    "t": 95.293,
    "status": "in_progress",
    "content": " zu oberirdischen Gängen: E "
   },
   {
    "t": 95.368,
    "status": "in_progress",
    "content": "30-C; zu unterirdischen G"
   },
   {
    "t": 95.435,
    "status": "in_progress",
    "content": "ängen und Räumen: EI₂ "
   },
   {
    "t": 95.52,
    "status": "in_progress",
    "content": "30-C |\n"
   },
   {
    "t": 95.655,
    "status": "in_progress",
    "content": "| Rauchabzug | Keine Rauchabzugseinrichtung aus Tabelle 3 für"
   },
   {
    "t": 95.712,
    "status": "in_progress",
    "content": " die Außentreppe genannt | Rauch"
   },
   {
    "t": 95.815,
    "status": "in_progress",
    "content": "abzug an ober"
   },
   {
    "t": 95.868,
    "status": "in_progress",
    "content": "ster Stelle, geometrisch freier Querschnitt"
   },
   {
    "t": 95.92,
    "status": "in_progress",
    "content": " 1"
   },
   {
    "t": 95.975,
    "status": "in_progress",
    "content": ",00 m²"
   },
   {
    "t": 96.037,
    "status": "in_progress",
    "content": "; Auslösung in der Angriffsebene"
   },
   {
    "t": 96.14,
    "status": "in_progress",
    "content": " der Feuerwehr und beim obersten Podest"
   },
   {
    "t": 96.194,
    "status": "in_progress",
    "content": " mit Zugängen zu Aufenthaltsräumen"
   },
   {
    "t": 96.282,
    "status": "in_progress",
    "content": ", unabhängig vom öffentlichen Stromnetz |\n"
   },
   {
    "t": 96.348,
    "status": "in_progress",
    "content": "\n"
   },
   {
    "t": 96.441,
    "status": "in_progress",
    "content": "Die Tabelle fasst die GK-4-Anforderungen aus Tabelle 3 zusammen"
   },
   {
    "t": 96.546,
    "status": "in_progress",
    "content": "; deren Abweich"
   },
   {
    "t": 96.619,
    "status": "in_progress",
    "content": "ungsmöglichkeiten und Fuß"
   },
   {
    "t": 96.72,
    "status": "in_progress",
    "content": "noten sind im Einzelfall mitzu"
   },
   {
    "t": 96.799,
    "status": "in_progress",
    "content": "prüfen [2]. Bei einem offenen"
   },
   {
    "t": 96.857,
    "status": "in_progress",
    "content": " Laubengang"
   },
   {
    "t": 96.944,
    "status": "in_progress",
    "content": " als Zubringer"
   },
   {
    "t": 97.036,
    "status": "in_progress",
    "content": " kann in GK "
   },
   {
    "t": 97.106,
    "status": "in_progress",
    "content": "4 A2 genügen, wenn die"
   },
   {
    "t": 97.171,
    "status": "in_progress",
    "content": " Fluchtwege zu zwei verschiedenen Treppen"
   },
   {
    "t": 97.262,
    "status": "in_progress",
    "content": "häusern bzw."
   },
   {
    "t": 97.328,
    "status": "in_progress",
    "content": " Außentreppen führen und die Standfest"
   },
   {
    "t": 97.433,
    "status": "in_progress",
    "content": "igkeit des Laubengangs"
   },
   {
    "t": 97.507,
    "status": "in_progress",
    "content": " im Brandfall gesichert ist "
   },
   {
    "t": 97.568,
    "status": "in_progress",
    "content": "[3]. Die Anforderungen an"
   },
   {
    "t": 97.632,
    "status": "in_progress",
    "content": " Fenster und Türen zum offenen Laubeng"
   },
   {
    "t": 97.78,
    "status": "in_progress",
    "content": "ang haben eigene Aus"
   },
   {
    "t": 97.85,
    "status": "in_progress",
    "content": "nahmen, darunter den"
   },
   {
    "t": 97.934,
    "status": "in_progress",
    "content": " Fall zweier verschiedener"
   },
   {
    "t": 97.994,
    "status": "in_progress",
    "content": " Treppenhäuser oder Außentreppen "
   },
   {
    "t": 98.074,
    "status": "in_progress",
    "content": "[3].\n\n"
   },
   {
    "t": 98.228,
    "status": "in_progress",
    "content": "Für Wohnungen wird die Gehweglänge in den hier einschlägigen"
   },
   {
    "t": 98.288,
    "status": "in_progress",
    "content": " Fällen ab der Wohnungseingangst"
   },
   {
    "t": 98.376,
    "status": "in_progress",
    "content": "üre gemessen; die"
   },
   {
    "t": 98.441,
    "status": "in_progress",
    "content": " Wohnungen dürfen sich dabei über höchstens zwei"
   },
   {
    "t": 98.525,
    "status": "in_progress",
    "content": " Geschoße erstrecken "
   },
   {
    "t": 98.621,
    "status": "in_progress",
    "content": "[1]. In jedem Geschoß mit Aufent"
   },
   {
    "t": 98.674,
    "status": "in_progress",
    "content": "haltsräumen muss"
   },
   {
    "t": 98.791,
    "status": "in_progress",
    "content": " zusätzlich ein Rettungsweg, ein unabh"
   },
   {
    "t": 98.877,
    "status": "in_progress",
    "content": "ängiger Weg zu einer weiteren Tre"
   },
   {
    "t": 98.928,
    "status": "in_progress",
    "content": "ppe nach Tabelle 3"
   },
   {
    "t": 99.088,
    "status": "in_progress",
    "content": " oder ein Weg in einen benachb"
   },
   {
    "t": 99.149,
    "status": "in_progress",
    "content": "arten Brandabschnitt vorhanden"
   },
   {
    "t": 99.203,
    "status": "in_progress",
    "content": " sein [1].\n\n"
   },
   {
    "t": 99.406,
    "status": "in_progress",
    "content": "Wiener Bautechnikverordnung § 1 erklärt die"
   },
   {
    "t": 99.469,
    "status": "in_progress",
    "content": " in ihren Anlagen enthaltenen"
   },
   {
    "t": 99.521,
    "status": "in_progress",
    "content": " OIB-Richt"
   },
   {
    "t": 99.603,
    "status": "in_progress",
    "content": "linien für maßgeblich, soweit sie"
   },
   {
    "t": 99.658,
    "status": "in_progress",
    "content": " bautechnische"
   },
   {
    "t": 99.776,
    "status": "in_progress",
    "content": " Anforderungen regeln "
   },
   {
    "t": 99.863,
    "status": "in_progress",
    "content": "[4]. Der abgerufene Paragraph"
   },
   {
    "t": 99.968,
    "status": "in_progress",
    "content": " nennt die konkrete Ausgabe der OIB-R"
   },
   {
    "t": 100.064,
    "status": "in_progress",
    "content": "L 2 nicht"
   },
   {
    "t": 100.146,
    "status": "in_progress",
    "content": "; daher ist vor"
   },
   {
    "t": 100.239,
    "status": "in_progress",
    "content": " Einreichung zu verifizieren, welche"
   },
   {
    "t": 100.368,
    "status": "in_progress",
    "content": " Ausgabe für das konkrete Verfahren gilt.\n"
   },
   {
    "t": 100.424,
    "status": "in_progress",
    "content": "\n[[card:1]]\n"
   },
   {
    "t": 100.523,
    "status": "in_progress",
    "content": "\n"
   },
   {
    "t": 101.405,
    "status": "in_progress",
    "content": "**Die Außentreppe ist in GK 4 in A2 auszuführen; das zweite Treppenhaus braucht oberirdisch grundsätzlich Wände in REI 60/EI 60 und Treppenläufe und Podeste in R 60** [2]. Für beide Varianten ist nicht nur die Treppe, sondern der unabhängige Fluchtweg bis zu einem sicheren Ort im Freien nachzuweisen: Bei der zusätzlichen Route nach Punkt 5.1.4 ist die Gehweglänge nicht begrenzt [1].\n\n| Nachweis | Offene Außentreppe | Zweites Treppenhaus |\n|---|---|---|\n| Unabhängige Wegführung | Weg zum weiteren, unabhängigen Fluchtweg; Ausgang zu sicherem Ort im Freien | Weg zum weiteren, unabhängigen Fluchtweg; Ausgang zu sicherem Ort im Freien |\n| Feuerwiderstand der Treppe | A2 | Treppenläufe und Podeste: R 60 |\n| Brandbeanspruchung | Im Brandfall keine Beeinträchtigung durch Flammeneinwirkung oder gefährdende Strahlungswärme | Treppenhauswände oberirdisch: REI 60/EI 60; unterirdisch: REI 90 und A2/EI 90 und A2; Decke darüber: REI 60 |\n| Türen | Nachweis der für den Fluchtweg und seine Anschlüsse geltenden Türanforderungen | Zu Wohnungen: EI₂ 30; zu oberirdischen Gängen: E 30-C; zu unterirdischen Gängen und Räumen: EI₂ 30-C |\n| Rauchabzug | Keine Rauchabzugseinrichtung aus Tabelle 3 für die Außentreppe genannt | Rauchabzug an oberster Stelle, geometrisch freier Querschnitt 1,00 m²; Auslösung in der Angriffsebene der Feuerwehr und beim obersten Podest mit Zugängen zu Aufenthaltsräumen, unabhängig vom öffentlichen Stromnetz |\n\nDie Tabelle fasst die GK-4-Anforderungen aus Tabelle 3 zusammen; deren Abweichungsmöglichkeiten und Fußnoten sind im Einzelfall mitzuprüfen [2]. Bei einem offenen Laubengang als Zubringer kann in GK 4 A2 genügen, wenn die Fluchtwege zu zwei verschiedenen Treppenhäusern bzw. Außentreppen führen und die Standfestigkeit des Laubengangs im Brandfall gesichert ist [3]. Die Anforderungen an Fenster und Türen zum offenen Laubengang haben eigene Ausnahmen, darunter den Fall zweier verschiedener Treppenhäuser oder Außentreppen [3].\n\nFür Wohnungen wird die Gehweglänge in den hier einschlägigen Fällen ab der Wohnungseingangstüre gemessen; die Wohnungen dürfen sich dabei über höchstens zwei Geschoße erstrecken [1]. In jedem Geschoß mit Aufenthaltsräumen muss zusätzlich ein Rettungsweg, ein unabhängiger Weg zu einer weiteren Treppe nach Tabelle 3 oder ein Weg in einen benachbarten Brandabschnitt vorhanden sein [1].\n\nWiener Bautechnikverordnung § 1 erklärt die in ihren Anlagen enthaltenen OIB-Richtlinien für maßgeblich, soweit sie bautechnische Anforderungen regeln [4]. Der abgerufene Paragraph nennt die konkrete Ausgabe der OIB-RL 2 nicht; daher ist vor Einreichung zu verifizieren, welche Ausgabe für das konkrete Verfahren gilt.\n\n[[card:1]]\n\n## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13\n- [2] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.30\n- [3] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.14\n- [4] [RIS] Wiener Bautechnikverordnung 2023, § 1",
    "sources": [
     {
      "number": 1,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.13",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "read_passage",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 13,
      "punkt": "5.1",
      "score": 0.5996370911598206,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege\n\n5.1 Fluchtwege\n\nOIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.1 Fluchtwege\n\n5.1.1 Von jeder Stelle jedes Raumes – ausgenommen nicht ausgebaute Dachräume – muss in höchstens 40 m Gehweglänge erreichbar sein:\na) ein direkter Ausgang zu einem sicheren Ort des angrenzenden Geländes im Freien, oder\nb) ein Treppenhaus oder eine Außentreppe gemäß Tabelle 2a bzw. 2b mit jeweils einem Ausgang\nzu einem sicheren Ort des angrenzenden Geländes im Freien, oder\nc) ein Treppenhaus oder eine Außentreppe gemäß Tabelle 3 mit jeweils einem Ausgang zu einem\nsicheren Ort des angrenzenden Geländes im Freien, wobei zusätzlich Punkt 5.1.4 gilt.\n\nOIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.1 Fluchtwege\n\n5.1.2 Bei Wohnungen wird abweichend von Punkt 5.1.1 in den Fällen b) und c) die Gehweglänge ab der\nWohnungseingangstüre gemessen. Dabei dürfen sich die Wohnungen über höchstens zwei Geschoße erstrecken.\n\nOIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.1 Fluchtwege\n\n5.1.4 Im Falle von Punkt 5.1.1 c) muss in jedem Geschoß mit Aufenthaltsräumen zusätzlich\na) ein Rettungsweg gemäß Punkt 5.2 vorhanden sein,"
     },
     {
      "number": 2,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.30",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.30",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "knowledge_search",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 30,
      "punkt": "Tabelle 3",
      "score": 0.5915181636810303,
      "snippet": "[CHART from page 30]\n\nDie Seite enthält Tabelle 3 der OIB-Richtlinie 2 mit Anforderungen an Treppenhäuser und Außentreppen im Verlauf von Fluchtwegen für die Gebäudeklassen GK 2 bis GK 5.\nProject: OIB-Richtlinie 2\nDetails: Österreichisches Institut für Bautechnik\n\nTable — Tabelle 3: Anforderungen an Treppenhäuser bzw. Außentreppen im Verlauf von Fluchtwegen gemäß Punkt 5.1.1 c)\nDie Tabelle stellt Anforderungen der Gebäudeklassen GK 2 bis GK 5 an Treppenhäuser und Außentreppen im Verlauf von Fluchtwegen gegenüber. Sie behandelt Bauteile, Türen, Treppenläufe und Podeste sowie die Rauchabzugseinrichtung.\nCirculation: Treppenläufe und Podeste (Anforderungen an Treppen in Treppenhäusern), Außentreppen (Anforderungen an Feuerwiderstand und Schutz vor Flammen- und Strahlungswärmeeinwirkung)\nStructure: Wände von Treppenhäusern (Anforderungen an den Feuerwiderstand in oberirdischen und unterirdischen Geschoßen), Decke über dem Treppenhaus (Anforderung an den Feuerwiderstand)\nEnvelope: Türen in Wänden von Treppenhäusern (Anforderungen für Türen zu Wohnungen, Betriebseinheiten und Gängen bzw. Räumen)\nBuilding services: Rauchabzugseinrichtung (Vorgaben zu Lage, Größe und"
     },
     {
      "number": 3,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.14",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.14",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "knowledge_search",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 14,
      "punkt": "5.3.5",
      "score": 0.5881398916244507,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.3 Gänge, Treppen und Türen im Verlauf von Fluchtwegen\n\n5.3.5 Wände und Decken von offenen Laubengängen müssen den Anforderungen an Trennwänden und\nTrenndecken gemäß Tabelle 1b entsprechen. Abweichend davon genügt bei Gebäuden bis einschließlich der Gebäudeklasse 4 bei offenen Laubengängen eine Ausführung in A2, wenn Fluchtwege zu zwei verschiedenen Treppenhäusern bzw. Außentreppen bestehen und die Standfestigkeit des Laubenganges unter Brandeinwirkung sichergestellt ist.\n\nOIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.3 Gänge, Treppen und Türen im Verlauf von Fluchtwegen\n\n5.3.6 Die auf offene Laubengänge mündenden Fenster müssen in EI 30 entweder als Fixverglasung\noder selbstschließend ausgeführt werden. Alternativ können vor die Fenster Abschlüsse in EI 30\nvorgesetzt werden, die im Brandfall selbsttätig schließen. Die auf offene Laubengänge mündenden\nTüren sind in EI2 30 auszuführen. Die Anforderungen gelten nicht, wenn\na) die Gehweglänge gemäß Punkt 5.1.1 zu einem sicheren Ort des angrenzenden Geländes im\nFreien nicht mehr als 40 m beträgt, oder\nb) Fluchtwege zu zwei verschiedenen Treppenhäusern bzw."
     },
     {
      "number": 4,
      "document_id": "doc:ris/lrkons/wien:wiener bautechnikverordnung 2023, § 1",
      "content": "[RIS] Wiener Bautechnikverordnung 2023, § 1",
      "title": "Wiener Bautechnikverordnung 2023",
      "citation_key": "Wiener Bautechnikverordnung 2023, § 1",
      "collection": "ris/LrKons/Wien",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "ris_lookup_tool",
      "origin": "ris",
      "kind": "baurecht",
      "lane": "baurecht_ris",
      "lane_label": "Rechtsquelle (RIS)",
      "rank": "landesgesetz",
      "binding_status": "bindend",
      "punkt": "§ 1",
      "score": 1.0,
      "snippet": "§ 1.\nDen im 9. Teil der Bauordnung für Wien festgelegten bautechnischen Vorschriften wird entsprochen, wenn die in den Anlagen enthaltenen Richtlinien des Österreichischen Instituts für Bautechnik, soweit in ihnen bautechnische Anforderungen geregelt werden, eingehalten werden. Ausgenommen sind die Punkte 2.1.5 und 2.1.6 der Anlage 11, Punkt 5 der Anlage 12 und die Buchstaben A und B des Punktes 4.10 der Anlage 13 aufgrund der Vorgaben des § 118e Abs. 3 der Bauordnung für Wien. Weiters tritt in der Anlage 13 der Begriff der Beherbergungsstätte nach § 120 Abs. 4 der Bauordnung für Wien an die Stelle des Begriffs des Beherbergungsbetriebs und es sind für die Ausstellung von Energieausweisen nur die jeweiligen Muster der Anlage 13 ohne QR-Code heranzuziehen."
     }
    ],
    "answer_meta": {
     "v": 1,
     "kind": "ruling",
     "summary": "Tragen Sie die gewählte Lösung mit Wegführung, Bauteilaufbauten und den jeweiligen Nachweisen in den Brandschutznachweis ein. Vor Einreichung ist noch die in Wien für das Verfahren maßgebliche OIB-Ausgabe zu bestätigen.",
     "verdict": {
      "value": "Außentreppe: A2; Treppenhaus: REI 60",
      "subject": "Wesentliche Brandschutzanforderung für den zweiten Fluchtweg in GK 4",
      "reference": {
       "document": "OIB-Richtlinie 2",
       "section": "Tabelle 3",
       "edition": "Ausgabe Mai 2023"
      }
     },
     "topic": "Zweiter Fluchtweg",
     "context": "OIB-Richtlinie 2, Ausgabe Mai 2023 · Wien"
    },
    "stream_replace": true
   },
   {
    "t": 103.217,
    "status": "in_progress",
    "content": "",
    "cards": [
     {
      "type": "legal_basis",
      "law": "OIB-Richtlinie 2",
      "lane": "baurecht_oib",
      "edition": "Ausgabe Mai 2023",
      "article": "5.1.4",
      "summary": "Ein unabhängiger zusätzlicher Fluchtweg kann zu einem weiteren Treppenhaus oder einer weiteren Außentreppe gemäß Tabelle 3 führen.",
      "original_text": "ein unabhängiger Fluchtweg zu einem weiteren Treppenhaus oder einer weiteren Außentreppe jeweils gemäß Tabelle 3 erreichbar sein"
     }
    ]
   },
   {
    "t": 103.525,
    "status": "complete",
    "content": "**Die Außentreppe ist in GK 4 in A2 auszuführen; das zweite Treppenhaus braucht oberirdisch grundsätzlich Wände in REI 60/EI 60 und Treppenläufe und Podeste in R 60** [2]. Für beide Varianten ist nicht nur die Treppe, sondern der unabhängige Fluchtweg bis zu einem sicheren Ort im Freien nachzuweisen: Bei der zusätzlichen Route nach Punkt 5.1.4 ist die Gehweglänge nicht begrenzt [1].\n\n| Nachweis | Offene Außentreppe | Zweites Treppenhaus |\n|---|---|---|\n| Unabhängige Wegführung | Weg zum weiteren, unabhängigen Fluchtweg; Ausgang zu sicherem Ort im Freien | Weg zum weiteren, unabhängigen Fluchtweg; Ausgang zu sicherem Ort im Freien |\n| Feuerwiderstand der Treppe | A2 | Treppenläufe und Podeste: R 60 |\n| Brandbeanspruchung | Im Brandfall keine Beeinträchtigung durch Flammeneinwirkung oder gefährdende Strahlungswärme | Treppenhauswände oberirdisch: REI 60/EI 60; unterirdisch: REI 90 und A2/EI 90 und A2; Decke darüber: REI 60 |\n| Türen | Nachweis der für den Fluchtweg und seine Anschlüsse geltenden Türanforderungen | Zu Wohnungen: EI₂ 30; zu oberirdischen Gängen: E 30-C; zu unterirdischen Gängen und Räumen: EI₂ 30-C |\n| Rauchabzug | Keine Rauchabzugseinrichtung aus Tabelle 3 für die Außentreppe genannt | Rauchabzug an oberster Stelle, geometrisch freier Querschnitt 1,00 m²; Auslösung in der Angriffsebene der Feuerwehr und beim obersten Podest mit Zugängen zu Aufenthaltsräumen, unabhängig vom öffentlichen Stromnetz |\n\nDie Tabelle fasst die GK-4-Anforderungen aus Tabelle 3 zusammen; deren Abweichungsmöglichkeiten und Fußnoten sind im Einzelfall mitzuprüfen [2]. Bei einem offenen Laubengang als Zubringer kann in GK 4 A2 genügen, wenn die Fluchtwege zu zwei verschiedenen Treppenhäusern bzw. Außentreppen führen und die Standfestigkeit des Laubengangs im Brandfall gesichert ist [3]. Die Anforderungen an Fenster und Türen zum offenen Laubengang haben eigene Ausnahmen, darunter den Fall zweier verschiedener Treppenhäuser oder Außentreppen [3].\n\nFür Wohnungen wird die Gehweglänge in den hier einschlägigen Fällen ab der Wohnungseingangstüre gemessen; die Wohnungen dürfen sich dabei über höchstens zwei Geschoße erstrecken [1]. In jedem Geschoß mit Aufenthaltsräumen muss zusätzlich ein Rettungsweg, ein unabhängiger Weg zu einer weiteren Treppe nach Tabelle 3 oder ein Weg in einen benachbarten Brandabschnitt vorhanden sein [1].\n\nWiener Bautechnikverordnung § 1 erklärt die in ihren Anlagen enthaltenen OIB-Richtlinien für maßgeblich, soweit sie bautechnische Anforderungen regeln [4]. Der abgerufene Paragraph nennt die konkrete Ausgabe der OIB-RL 2 nicht; daher ist vor Einreichung zu verifizieren, welche Ausgabe für das konkrete Verfahren gilt.\n\n[[card:1]]\n\n## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13\n- [2] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.30\n- [3] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.14\n- [4] [RIS] Wiener Bautechnikverordnung 2023, § 1\n",
    "cards": [
     {
      "type": "legal_basis",
      "law": "OIB-Richtlinie 2",
      "lane": "baurecht_oib",
      "edition": "Ausgabe Mai 2023",
      "article": "5.1.4",
      "summary": "Ein unabhängiger zusätzlicher Fluchtweg kann zu einem weiteren Treppenhaus oder einer weiteren Außentreppe gemäß Tabelle 3 führen.",
      "original_text": "ein unabhängiger Fluchtweg zu einem weiteren Treppenhaus oder einer weiteren Außentreppe jeweils gemäß Tabelle 3 erreichbar sein"
     }
    ],
    "answer_confidence": "medium",
    "sources": [
     {
      "number": 1,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.13",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "read_passage",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 13,
      "punkt": "5.1",
      "score": 0.5996370911598206,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege\n\n5.1 Fluchtwege\n\nOIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.1 Fluchtwege\n\n5.1.1 Von jeder Stelle jedes Raumes – ausgenommen nicht ausgebaute Dachräume – muss in höchstens 40 m Gehweglänge erreichbar sein:\na) ein direkter Ausgang zu einem sicheren Ort des angrenzenden Geländes im Freien, oder\nb) ein Treppenhaus oder eine Außentreppe gemäß Tabelle 2a bzw. 2b mit jeweils einem Ausgang\nzu einem sicheren Ort des angrenzenden Geländes im Freien, oder\nc) ein Treppenhaus oder eine Außentreppe gemäß Tabelle 3 mit jeweils einem Ausgang zu einem\nsicheren Ort des angrenzenden Geländes im Freien, wobei zusätzlich Punkt 5.1.4 gilt.\n\nOIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.1 Fluchtwege\n\n5.1.2 Bei Wohnungen wird abweichend von Punkt 5.1.1 in den Fällen b) und c) die Gehweglänge ab der\nWohnungseingangstüre gemessen. Dabei dürfen sich die Wohnungen über höchstens zwei Geschoße erstrecken.\n\nOIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.1 Fluchtwege\n\n5.1.4 Im Falle von Punkt 5.1.1 c) muss in jedem Geschoß mit Aufenthaltsräumen zusätzlich\na) ein Rettungsweg gemäß Punkt 5.2 vorhanden sein,"
     },
     {
      "number": 2,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.30",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.30",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "knowledge_search",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 30,
      "punkt": "Tabelle 3",
      "score": 0.5915181636810303,
      "snippet": "[CHART from page 30]\n\nDie Seite enthält Tabelle 3 der OIB-Richtlinie 2 mit Anforderungen an Treppenhäuser und Außentreppen im Verlauf von Fluchtwegen für die Gebäudeklassen GK 2 bis GK 5.\nProject: OIB-Richtlinie 2\nDetails: Österreichisches Institut für Bautechnik\n\nTable — Tabelle 3: Anforderungen an Treppenhäuser bzw. Außentreppen im Verlauf von Fluchtwegen gemäß Punkt 5.1.1 c)\nDie Tabelle stellt Anforderungen der Gebäudeklassen GK 2 bis GK 5 an Treppenhäuser und Außentreppen im Verlauf von Fluchtwegen gegenüber. Sie behandelt Bauteile, Türen, Treppenläufe und Podeste sowie die Rauchabzugseinrichtung.\nCirculation: Treppenläufe und Podeste (Anforderungen an Treppen in Treppenhäusern), Außentreppen (Anforderungen an Feuerwiderstand und Schutz vor Flammen- und Strahlungswärmeeinwirkung)\nStructure: Wände von Treppenhäusern (Anforderungen an den Feuerwiderstand in oberirdischen und unterirdischen Geschoßen), Decke über dem Treppenhaus (Anforderung an den Feuerwiderstand)\nEnvelope: Türen in Wänden von Treppenhäusern (Anforderungen für Türen zu Wohnungen, Betriebseinheiten und Gängen bzw. Räumen)\nBuilding services: Rauchabzugseinrichtung (Vorgaben zu Lage, Größe und"
     },
     {
      "number": 3,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.14",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.14",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "knowledge_search",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 14,
      "punkt": "5.3.5",
      "score": 0.5881398916244507,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.3 Gänge, Treppen und Türen im Verlauf von Fluchtwegen\n\n5.3.5 Wände und Decken von offenen Laubengängen müssen den Anforderungen an Trennwänden und\nTrenndecken gemäß Tabelle 1b entsprechen. Abweichend davon genügt bei Gebäuden bis einschließlich der Gebäudeklasse 4 bei offenen Laubengängen eine Ausführung in A2, wenn Fluchtwege zu zwei verschiedenen Treppenhäusern bzw. Außentreppen bestehen und die Standfestigkeit des Laubenganges unter Brandeinwirkung sichergestellt ist.\n\nOIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.3 Gänge, Treppen und Türen im Verlauf von Fluchtwegen\n\n5.3.6 Die auf offene Laubengänge mündenden Fenster müssen in EI 30 entweder als Fixverglasung\noder selbstschließend ausgeführt werden. Alternativ können vor die Fenster Abschlüsse in EI 30\nvorgesetzt werden, die im Brandfall selbsttätig schließen. Die auf offene Laubengänge mündenden\nTüren sind in EI2 30 auszuführen. Die Anforderungen gelten nicht, wenn\na) die Gehweglänge gemäß Punkt 5.1.1 zu einem sicheren Ort des angrenzenden Geländes im\nFreien nicht mehr als 40 m beträgt, oder\nb) Fluchtwege zu zwei verschiedenen Treppenhäusern bzw."
     },
     {
      "number": 4,
      "document_id": "doc:ris/lrkons/wien:wiener bautechnikverordnung 2023, § 1",
      "content": "[RIS] Wiener Bautechnikverordnung 2023, § 1",
      "title": "Wiener Bautechnikverordnung 2023",
      "citation_key": "Wiener Bautechnikverordnung 2023, § 1",
      "collection": "ris/LrKons/Wien",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "ris_lookup_tool",
      "origin": "ris",
      "kind": "baurecht",
      "lane": "baurecht_ris",
      "lane_label": "Rechtsquelle (RIS)",
      "rank": "landesgesetz",
      "binding_status": "bindend",
      "punkt": "§ 1",
      "score": 1.0,
      "snippet": "§ 1.\nDen im 9. Teil der Bauordnung für Wien festgelegten bautechnischen Vorschriften wird entsprochen, wenn die in den Anlagen enthaltenen Richtlinien des Österreichischen Instituts für Bautechnik, soweit in ihnen bautechnische Anforderungen geregelt werden, eingehalten werden. Ausgenommen sind die Punkte 2.1.5 und 2.1.6 der Anlage 11, Punkt 5 der Anlage 12 und die Buchstaben A und B des Punktes 4.10 der Anlage 13 aufgrund der Vorgaben des § 118e Abs. 3 der Bauordnung für Wien. Weiters tritt in der Anlage 13 der Begriff der Beherbergungsstätte nach § 120 Abs. 4 der Bauordnung für Wien an die Stelle des Begriffs des Beherbergungsbetriebs und es sind für die Ausstellung von Energieausweisen nur die jeweiligen Muster der Anlage 13 ohne QR-Code heranzuziehen."
     }
    ],
    "read_sources": [
     {
      "document_id": "doc:oib_knowledge:erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf",
      "title": "Erläuterungen zu OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf, p.23",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib_erlaeuterung",
      "lane_label": "OIB-Erläuterung",
      "file_name": "erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 23
     },
     {
      "document_id": "doc:oib_knowledge:oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
      "title": "OIB-Richtlinie 2.2, Ausgabe Mai 2023",
      "citation_key": "oib-richtlinie_2.2_ausgabe_mai_2023.pdf, p.7",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "file_name": "oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
      "page": 7
     },
     {
      "document_id": "doc:oib_knowledge:oib-rl_2.3_ausgabe_mai_2023.pdf",
      "title": "OIB-Richtlinie 2.3, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2.3_ausgabe_mai_2023.pdf, p.11",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "file_name": "oib-rl_2.3_ausgabe_mai_2023.pdf",
      "page": 11
     },
     {
      "document_id": "doc:oib_knowledge:erlaeuterungen_oib-rl_2.3_ausgabe_mai_2023.pdf",
      "title": "Erläuterungen zu OIB-Richtlinie 2.3, Ausgabe Mai 2023",
      "citation_key": "erlaeuterungen_oib-rl_2.3_ausgabe_mai_2023.pdf, p.13",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib_erlaeuterung",
      "lane_label": "OIB-Erläuterung",
      "file_name": "erlaeuterungen_oib-rl_2.3_ausgabe_mai_2023.pdf",
      "page": 13
     },
     {
      "document_id": "doc:oib_knowledge:oib-rl_2.1_ausgabe_mai_2023.pdf",
      "title": "OIB-Richtlinie 2.1, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2.1_ausgabe_mai_2023.pdf, p.6",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "file_name": "oib-rl_2.1_ausgabe_mai_2023.pdf",
      "page": 6
     },
     {
      "document_id": "doc:oib_knowledge:erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf",
      "title": "Erläuterungen zu OIB-Richtlinie 2.1, Ausgabe Mai 2023",
      "citation_key": "erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib_erlaeuterung",
      "lane_label": "OIB-Erläuterung",
      "file_name": "erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf",
      "page": 4
     },
     {
      "document_id": "doc:oib_knowledge:oib-rl_4_ausgabe_mai_2023.pdf",
      "title": "OIB-Richtlinie 4, Ausgabe Mai 2023",
      "citation_key": "oib-rl_4_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "file_name": "oib-rl_4_ausgabe_mai_2023.pdf",
      "page": 4
     },
     {
      "document_id": "doc:oib_knowledge:erlaeuterungen_oib-rl_4_ausgabe_mai_2023.pdf",
      "title": "Erläuterungen zu OIB-Richtlinie 4, Ausgabe Mai 2023",
      "citation_key": "erlaeuterungen_oib-rl_4_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib_erlaeuterung",
      "lane_label": "OIB-Erläuterung",
      "file_name": "erlaeuterungen_oib-rl_4_ausgabe_mai_2023.pdf",
      "page": 4
     },
     {
      "document_id": "doc:ris/lrkons/wien:wiener bautechnikverordnung 2023, § 5",
      "title": "Wiener Bautechnikverordnung 2023",
      "citation_key": "Wiener Bautechnikverordnung 2023, § 5",
      "collection": "ris/LrKons/Wien",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_ris",
      "lane_label": "Rechtsquelle (RIS)"
     }
    ],
    "routing_decision": "shallow",
    "answer_confidence_reason": "OIB-Anforderungen belegt; die in Wien maßgebliche Ausgabe ist im abgerufenen § 1 nicht ausgewiesen",
    "answer_meta": {
     "v": 1,
     "kind": "ruling",
     "summary": "Tragen Sie die gewählte Lösung mit Wegführung, Bauteilaufbauten und den jeweiligen Nachweisen in den Brandschutznachweis ein. Vor Einreichung ist noch die in Wien für das Verfahren maßgebliche OIB-Ausgabe zu bestätigen.",
     "verdict": {
      "value": "Außentreppe: A2; Treppenhaus: REI 60",
      "subject": "Wesentliche Brandschutzanforderung für den zweiten Fluchtweg in GK 4",
      "reference": {
       "document": "OIB-Richtlinie 2",
       "section": "Tabelle 3",
       "edition": "Ausgabe Mai 2023"
      }
     },
     "topic": "Zweiter Fluchtweg",
     "context": "OIB-Richtlinie 2, Ausgabe Mai 2023 · Wien"
    },
    "skills_activated": [
     "brandschutz"
    ],
    "retrieval_ledger": [
     {
      "index": 0,
      "key": "status.retrieval.withQuery",
      "tools": [
       "knowledge_search",
       "knowledge_search",
       "knowledge_search"
      ],
      "corpora": [
       "knowledge"
      ],
      "docs": [
       {
        "name": "oib-rl_4_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 4, Ausgabe Mai 2023",
        "detail": "Pkt. 0 p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "erlaeuterungen_oib-rl_4_ausgabe_mai_2023.pdf",
        "title": "Erläuterungen zu OIB-Richtlinie 4, Ausgabe Mai 2023",
        "detail": "p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "erlaeuterungen_oib-rl_4_ausgabe_mai_2023.pdf",
        "title": "Erläuterungen zu OIB-Richtlinie 4, Ausgabe Mai 2023",
        "detail": "p.5",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "erlaeuterungen_oib-rl_4_ausgabe_mai_2023.pdf",
        "title": "Erläuterungen zu OIB-Richtlinie 4, Ausgabe Mai 2023",
        "detail": "p.20",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_4_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 4, Ausgabe Mai 2023",
        "detail": "p.18",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 0 p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2.1_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2.1, Ausgabe Mai 2023",
        "detail": "Pkt. 0 p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2.2, Ausgabe Mai 2023",
        "detail": "Pkt. 0 p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2.3_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2.3, Ausgabe Mai 2023",
        "detail": "Pkt. 0 p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf",
        "title": "Erläuterungen zu OIB-Richtlinie 2.1, Ausgabe Mai 2023",
        "detail": "p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "Erläuterungen zu OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "p.62",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "Erläuterungen zu OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 7 p.49",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "Erläuterungen zu OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 6 p.23",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 5.3.5 p.14",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "p.27",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "p.30",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2.2, Ausgabe Mai 2023",
        "detail": "Pkt. 5.5.2 p.7",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "p.28",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2.2, Ausgabe Mai 2023",
        "detail": "Pkt. Tabelle 3 p.13",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2.3_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2.3, Ausgabe Mai 2023",
        "detail": "Pkt. 4.1.1 p.11",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2.3_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2.3, Ausgabe Mai 2023",
        "detail": "Pkt. 4.1.5 p.11",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "erlaeuterungen_oib-rl_2.3_ausgabe_mai_2023.pdf",
        "title": "Erläuterungen zu OIB-Richtlinie 2.3, Ausgabe Mai 2023",
        "detail": "p.13",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2.1_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2.1, Ausgabe Mai 2023",
        "detail": "Pkt. 3.6.1 p.6",
        "shelf": "base",
        "repeat": false
       }
      ],
      "new_docs": [
       "oib-rl_4_ausgabe_mai_2023.pdf",
       "erlaeuterungen_oib-rl_4_ausgabe_mai_2023.pdf",
       "oib-rl_2_ausgabe_mai_2023.pdf",
       "oib-rl_2.1_ausgabe_mai_2023.pdf",
       "oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
       "oib-rl_2.3_ausgabe_mai_2023.pdf",
       "erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf",
       "erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf",
       "erlaeuterungen_oib-rl_2.3_ausgabe_mai_2023.pdf"
      ],
      "hits": 23,
      "documents": 9,
      "query": "Neubau Wohngebäude in Gebäudekl…"
     },
     {
      "index": 1,
      "key": "status.retrieval.withQuery",
      "tools": [
       "read_passage",
       "read_passage",
       "read_passage",
       "read_passage",
       "read_passage",
       "ris_lookup_tool"
      ],
      "corpora": [
       "knowledge",
       "ris"
      ],
      "docs": [
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 5.3.5 p.14",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 5.3.6 p.14",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_4_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 4, Ausgabe Mai 2023",
        "detail": "Pkt. 2 p.5",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 5.1 p.13",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. Tabelle 3 p.30",
        "shelf": "base",
        "repeat": true
       }
      ],
      "new_docs": [],
      "hits": 5,
      "documents": 2,
      "query": "Welche OIB-Ausgabe und welche A…",
      "reason": "Die Tabellenhinweise zeigen, dass es um einen zweiten baulichen Fluchtweg geht; ich brauche die normativen Kriterien für Unabhängigkeit und Gehweglängen."
     },
     {
      "index": 2,
      "key": "status.retrieval.withQuery",
      "tools": [
       "read_passage",
       "read_passage",
       "read_passage",
       "read_passage",
       "ris_lookup_tool"
      ],
      "corpora": [
       "knowledge",
       "ris"
      ],
      "docs": [
       {
        "name": "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000702",
        "title": "Wiener Bautechnikverordnung 2023",
        "detail": "§ 1",
        "repeat": false
       },
       {
        "name": "Wiener Bautechnikverordnung 2023, § 1",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 5.3.2 p.14",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 5.1.2 p.13",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 5.1.1 p.13",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 5.1.4 p.13",
        "shelf": "base",
        "repeat": true
       }
      ],
      "new_docs": [
       "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000702",
       "Wiener Bautechnikverordnung 2023, § 1"
      ],
      "hits": 6,
      "documents": 3,
      "query": "Welche Ausgabe der OIB-Richtlin…",
      "reason": "Tabelle 3 liefert Anforderungen an beide baulichen Alternativen; für den Vergleich fehlt noch, wann ein zweiter Fluchtweg zählt und wie unabhängig er sein muss."
     },
     {
      "index": 3,
      "key": "status.retrieval.withQuery",
      "tools": [
       "read_passage",
       "read_passage",
       "read_passage",
       "read_passage",
       "ris_lookup_tool"
      ],
      "corpora": [
       "knowledge",
       "ris"
      ],
      "docs": [
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. Tabelle 3 p.30",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_4_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 4, Ausgabe Mai 2023",
        "detail": "Pkt. 2.1 p.5",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_4_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 4, Ausgabe Mai 2023",
        "detail": "Pkt. 2.2 p.5",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 5.1.3 p.13",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000702",
        "title": "Wiener Bautechnikverordnung 2023",
        "detail": "§ 5",
        "repeat": false
       },
       {
        "name": "Wiener Bautechnikverordnung 2023, § 5",
        "shelf": "base",
        "repeat": false
       }
      ],
      "new_docs": [
       "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000702",
       "Wiener Bautechnikverordnung 2023, § 5"
      ],
      "hits": 6,
      "documents": 4,
      "query": "Welche Fassung der OIB-Richtlin…",
      "reason": "Die Texte unterscheiden den erforderlichen zweiten Fluchtweg vom bloßen Zweitweg; ich prüfe die normative Unabhängigkeit sowie Verzweigung."
     }
    ]
   }
  ]
 },
 "oib2": {
  "question": "Was weißt du über die OIB-Richtlinie 2?",
  "frames": [
   {
    "t": 37.445,
    "status": "in_progress",
    "content": "",
    "answer_meta": {
     "v": 1,
     "kind": "walkthrough",
     "summary": "Für ein konkretes Vorhaben ist zuerst der passende Teil nach Nutzung und Gebäudeart zu bestimmen; ob die Ausgabe Mai 2023 im jeweiligen Bundesland verbindlich gilt, ist gesondert zu prüfen.",
     "topic": "OIB-Richtlinie 2 – Brandschutz",
     "context": "Ausgabe Mai 2023 · landesrechtliche Verbindlichkeit nicht geprüft"
    }
   },
   {
    "t": 37.517,
    "status": "in_progress",
    "content": "Die OIB-Richtlinie 2 behandelt den **Brandschutz von Gebäuden**"
   },
   {
    "t": 37.605,
    "status": "in_progress",
    "content": ". Sie ordnet Anforderungen zur Tragfähigkeit"
   },
   {
    "t": 37.698,
    "status": "in_progress",
    "content": " im Brandfall, zur"
   },
   {
    "t": 37.833,
    "status": "in_progress",
    "content": " Ausbreitung von"
   },
   {
    "t": 37.936,
    "status": "in_progress",
    "content": " Feuer und Rauch, zu Flucht- und"
   },
   {
    "t": 38.021,
    "status": "in_progress",
    "content": " Rettungswegen sowie"
   },
   {
    "t": 38.3,
    "status": "in_progress",
    "content": " zur Brandbekämpfung; ergänzende Richtlinien behandeln bestimmte"
   },
   {
    "t": 38.358,
    "status": "in_progress",
    "content": " Gebäudearten gesondert [1][2][3][4][5][6][7].\n"
   },
   {
    "t": 38.421,
    "status": "in_progress",
    "content": "\n| Teil | Schwerpunkt | Fundstelle |\n"
   },
   {
    "t": 38.475,
    "status": "in_progress",
    "content": "|---|---|---|\n| OIB-RL 2 | Allgemeine Brandschutzanforderungen für Gebäude | [1] |\n"
   },
   {
    "t": 38.527,
    "status": "in_progress",
    "content": "| OIB-RL 2.1 | Betriebsbauten | [8] |\n"
   },
   {
    "t": 38.626,
    "status": "in_progress",
    "content": "| OIB-RL 2.2 | Garagen, überdachte Stellplätze und Parkdecks | "
   },
   {
    "t": 38.687,
    "status": "in_progress",
    "content": "[9] |\n"
   },
   {
    "t": 38.782,
    "status": "in_progress",
    "content": "| OIB-RL 2.3 | Gebäude mit einem Fluchtniveau"
   },
   {
    "t": 38.842,
    "status": "in_progress",
    "content": " von mehr als 22 m | "
   },
   {
    "t": 38.897,
    "status": "in_progress",
    "content": "[10] |\n\n"
   },
   {
    "t": 39.048,
    "status": "in_progress",
    "content": "Die Teile sind nicht bloß Kapitel derselben Richtlinie:"
   },
   {
    "t": 39.137,
    "status": "in_progress",
    "content": " OIB-RL 2 verweist"
   },
   {
    "t": 39.208,
    "status": "in_progress",
    "content": " für Betriebsbauten,"
   },
   {
    "t": 39.261,
    "status": "in_progress",
    "content": " Garagen und Gebäude"
   },
   {
    "t": 39.323,
    "status": "in_progress",
    "content": " mit höherem Fluchtniveau auf die jeweiligen"
   },
   {
    "t": 39.42,
    "status": "in_progress",
    "content": " ergänzenden Richtlinien [7]."
   },
   {
    "t": 39.479,
    "status": "in_progress",
    "content": "\n\n```mermaid\n"
   },
   {
    "t": 39.557,
    "status": "in_progress",
    "content": "mindmap\n"
   },
   {
    "t": 39.677,
    "status": "in_progress",
    "content": "  root((\"OIB-Richtlinie 2\"))\n    \"Grundrichtlinie\"\n"
   },
   {
    "t": 39.798,
    "status": "in_progress",
    "content": "      \"Brandschutz für Gebäude\"\n"
   },
   {
    "t": 39.893,
    "status": "in_progress",
    "content": "    \"OIB-RL 2.1\"\n"
   },
   {
    "t": 39.974,
    "status": "in_progress",
    "content": "      \"Betriebsbauten\"\n"
   },
   {
    "t": 40.038,
    "status": "in_progress",
    "content": "    \"OIB-RL 2.2\"\n"
   },
   {
    "t": 40.185,
    "status": "in_progress",
    "content": "      \"Garagen und Parkdecks\"\n"
   },
   {
    "t": 40.247,
    "status": "in_progress",
    "content": "    \"OIB-RL 2.3\"\n"
   },
   {
    "t": 40.324,
    "status": "in_progress",
    "content": "      \"Fluchtniveau über 22 m\"\n```\n\n"
   },
   {
    "t": 40.511,
    "status": "in_progress",
    "content": "Die Ausgabe Mai 2023 hält fest, dass Abweichungen"
   },
   {
    "t": 40.562,
    "status": "in_progress",
    "content": " nach Maßgabe"
   },
   {
    "t": 40.652,
    "status": "in_progress",
    "content": " des jeweiligen Landesrechts möglich sind [1]. Ob"
   },
   {
    "t": 40.725,
    "status": "in_progress",
    "content": " und in welcher Fassung"
   },
   {
    "t": 40.776,
    "status": "in_progress",
    "content": " die Richtlinie für ein konkretes Vor"
   },
   {
    "t": 40.879,
    "status": "in_progress",
    "content": "haben verbindlich ist,"
   },
   {
    "t": 40.996,
    "status": "in_progress",
    "content": " lässt sich ohne Angabe des Bundes"
   },
   {
    "t": 41.096,
    "status": "in_progress",
    "content": "lands nicht feststellen.\n\n[[card:1]]\n\n"
   },
   {
    "t": 43.424,
    "status": "in_progress",
    "content": "Die OIB-Richtlinie 2 behandelt den **Brandschutz von Gebäuden**. Sie ordnet Anforderungen zur Tragfähigkeit im Brandfall, zur Ausbreitung von Feuer und Rauch, zu Flucht- und Rettungswegen sowie zur Brandbekämpfung; ergänzende Richtlinien behandeln bestimmte Gebäudearten gesondert [1][2][3][4][5][6][7].\n\n| Teil | Schwerpunkt | Fundstelle |\n|---|---|---|\n| OIB-RL 2 | Allgemeine Brandschutzanforderungen für Gebäude | [1] |\n| OIB-RL 2.1 | Betriebsbauten | |\n| OIB-RL 2.2 | Garagen, überdachte Stellplätze und Parkdecks | [8] |\n| OIB-RL 2.3 | Gebäude mit einem Fluchtniveau von mehr als 22 m | [9] |\n\nDie Teile sind nicht bloß Kapitel derselben Richtlinie: OIB-RL 2 verweist für Betriebsbauten, Garagen und Gebäude mit höherem Fluchtniveau auf die jeweiligen ergänzenden Richtlinien [7].\n\n```mermaid\nmindmap\n  root((\"OIB-Richtlinie 2\"))\n    \"Grundrichtlinie\"\n      \"Brandschutz für Gebäude\"\n    \"OIB-RL 2.1\"\n      \"Betriebsbauten\"\n    \"OIB-RL 2.2\"\n      \"Garagen und Parkdecks\"\n    \"OIB-RL 2.3\"\n      \"Fluchtniveau über 22 m\"\n```\n\nDie Ausgabe Mai 2023 hält fest, dass Abweichungen nach Maßgabe des jeweiligen Landesrechts möglich sind [1]. Ob und in welcher Fassung die Richtlinie für ein konkretes Vorhaben verbindlich ist, lässt sich ohne Angabe des Bundeslands nicht feststellen.\n\n[[card:1]]\n\n## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.4\n- [2] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.5\n- [3] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.12\n- [4] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13\n- [5] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.14\n- [6] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.15\n- [7] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.23\n- [8] [KB] oib-richtlinie_2.2_ausgabe_mai_2023.pdf, p.4\n- [9] [KB] oib-rl_2.3_ausgabe_mai_2023.pdf, p.4",
    "sources": [
     {
      "number": 1,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.4",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "knowledge_search",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 4,
      "punkt": "0",
      "score": 0.587127923965454,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n\n0 Vorbemerkungen\nDie zitierten Normen und sonstigen technischen Regelwerke gelten in der im Dokument „OIB-\nRichtlinien – Zitierte Normen und sonstige technische Regelwerke“ angeführten Fassung.\nDiese Richtlinie gilt für Gebäude. Für sonstige Bauwerke sind die Bestimmungen der Richtlinie\nsinngemäß anzuwenden.\nWerden in dieser Richtlinie Anforderungen an die Feuerwiderstandsklasse in Verbindung mit Anforderungen an Baustoffe der Klasse A2 gestellt, gilt dies auch als erfüllt, wenn\n• die für die Tragfähigkeit wesentlichen Bestandteile der Bauteile der Klasse A2 entsprechen und\n• die sonstigen Bestandteile aus Baustoffen der Klasse B bestehen.\nFür eingeschoßige Gebäude mit höchstens 15 m² Brutto-Grundfläche, die auf eigenem Grund oder\nvon Verkehrsflächen für die Brandbekämpfung zugänglich sind, werden keine Anforderungen hinsichtlich des Brandschutzes gestellt.\nFür Gebäude mit gemischter Nutzung gelten die Anforderungen hinsichtlich des Brandschutzes für\ndie einzelnen Nutzungsbereiche als erfüllt, wenn die für die jeweiligen Nutzungen anzuwendenden\nBestimmungen der Richtlinien eingehalten werden, wobei gegenseitige Wechselwirkungen zu berücksichtigen"
     },
     {
      "number": 2,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.5",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.5",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "read_passage",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 5,
      "punkt": "3",
      "score": 0.5824705362319946,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n\n3 Ausbreitung von Feuer und Rauch innerhalb des Bauwerkes"
     },
     {
      "number": 3,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.12",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.12",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "read_passage",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 12,
      "punkt": "4",
      "score": 0.5798938870429993,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n\n4 Ausbreitung von Feuer auf andere Bauwerke"
     },
     {
      "number": 4,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.13",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "read_passage",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 13,
      "punkt": "5",
      "score": 0.5835549831390381,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n\n5 Flucht- und Rettungswege"
     },
     {
      "number": 5,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.14",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.14",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "read_passage",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 14,
      "punkt": "6",
      "score": 0.5610198378562927,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n\n6 Brandbekämpfung\nGebäude müssen grundsätzlich zur Brandbekämpfung zugänglich sein. Die erforderlichen Zufahrten, Aufstell- und Bewegungsflächen für Feuerwehrfahrzeuge müssen ausreichend befestigt und\ntragfähig sein. Bei Gebäuden der Gebäudeklasse 1, 2 und 3 ist eine ausreichende Zugänglichkeit\njedenfalls dann gegeben, wenn der am weitesten entfernte Gebäudezugang, der für die Erschließung notwendig ist, in einer Entfernung von höchstens 80 m Gehweglänge von der Aufstellfläche\nfür die Feuerwehrfahrzeuge liegt. Bei Gebäuden der Gebäudeklasse 4 und 5 sind hinsichtlich der\nEntfernung der Aufstellfläche vom Gebäude die Einsatzmöglichkeiten der Feuerwehr zu berücksichtigen. Bei Gebäuden, bei denen die Zugänglichkeit für die Feuerwehr zur Brandbekämpfung\nnicht ausreichend gegeben ist, können zusätzliche brandschutztechnische Maßnahmen erforderlich werden."
     },
     {
      "number": 6,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.15",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.15",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "read_passage",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 15,
      "punkt": "7",
      "score": 0.6338073015213013,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n\n7 Besondere Bestimmungen\nDieser Punkt enthält ergänzende bzw. abweichende Bestimmungen zu den Anforderungen gemäß\nden Punkten 2 bis 6."
     },
     {
      "number": 7,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.23",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.23",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "knowledge_search",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 23,
      "punkt": "8",
      "score": 0.58231121301651,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n\n8 Betriebsbauten\nEs gelten die Bestimmungen der OIB-Richtlinie 2.1 „Brandschutz bei Betriebsbauten“.\n\nOIB-Richtlinie 2 — Brandschutz\n\n9 Garagen, überdachte Stellplätze und Parkdecks\nEs gelten die Bestimmungen der OIB-Richtlinie 2.2 „Brandschutz bei Garagen, überdachten Stellplätzen und Parkdecks“.\n\nOIB-Richtlinie 2 — Brandschutz\n\n10 Gebäude mit einem Fluchtniveau von mehr als 22 m\nEs gelten die Bestimmungen der OIB-Richtlinie 2.3 „Brandschutz bei Gebäuden mit einem Fluchtniveau von mehr als 22 m“."
     },
     {
      "number": 8,
      "document_id": "doc:oib_knowledge:oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-richtlinie_2.2_ausgabe_mai_2023.pdf, p.4",
      "title": "OIB-Richtlinie 2.2, Ausgabe Mai 2023",
      "citation_key": "oib-richtlinie_2.2_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "knowledge_search",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
      "page": 4,
      "punkt": "0",
      "score": 0.5978533029556274,
      "snippet": "OIB-Richtlinie 2.2 — Brandschutz bei Garagen, überdachten Stellplätzen und Parkdecks\n\n0 Vorbemerkungen\nDie zitierten Normen und sonstigen technischen Regelwerke gelten in der im Dokument „OIB-\nRichtlinien – Zitierte Normen und sonstige technische Regelwerke“ angeführten Fassung.\nWerden in dieser Richtlinie Anforderungen an die Feuerwiderstandsklasse in Verbindung mit Anforderungen an Baustoffe der Klasse A2 gestellt, gilt dies auch als erfüllt, wenn\n• die für die Tragfähigkeit wesentlichen Bestandteile der Bauteile der Klasse A2 und\n• die sonstigen Bestandteile aus Baustoffen der Klasse B bestehen.\nFür überdachte Stellplätze und Garagen mit jeweils höchstens 15 m² Nutzfläche, die auf eigenem\nGrund oder von Verkehrsflächen für die Brandbekämpfung zugänglich sind, werden keine Anforderungen hinsichtlich des Brandschutzes gestellt.\nBei Garagen und überdachten Stellplätzen von anerkannten Einsatzorganisationen sind Ausnahmen in Bezug auf Lagerungen (z.B. Materialien, Ausrüstungen, Treibstoffe) und untergeordneten\nNutzungen zulässig, sofern sie zur Erfüllung der gesetzlichen Aufgaben erforderlich sind und keine\nbrandschutztechnischen Bedenken bestehen.\nEs wird darauf hingewiesen, dass"
     },
     {
      "number": 9,
      "document_id": "doc:oib_knowledge:oib-rl_2.3_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2.3_ausgabe_mai_2023.pdf, p.4",
      "title": "OIB-Richtlinie 2.3, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2.3_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "knowledge_search",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2.3_ausgabe_mai_2023.pdf",
      "page": 4,
      "punkt": "0",
      "score": 0.61750328540802,
      "snippet": "OIB-Richtlinie 2.3 — Brandschutz bei Gebäuden mit einem Fluchtniveau von mehr als 22 m\n\n0 Vorbemerkungen\nDie zitierten Normen und sonstigen technischen Regelwerke gelten in der im Dokument „OIB-\nRichtlinien – Zitierte Normen und sonstige technische Regelwerke“ angeführten Fassung.\nWerden in dieser Richtlinie Anforderungen an die Feuerwiderstandsklasse in Verbindung mit Anforderungen an Baustoffe der Klasse A2 gestellt, gilt dies auch als erfüllt, wenn\n• die für die Tragfähigkeit wesentlichen Bestandteile der Bauteile der Klasse A2 entsprechen und\n• die sonstigen Bestandteile aus Baustoffen der Klasse B bestehen.\nEs wird darauf hingewiesen, dass parallel zu den Bestimmungen dieser Richtlinie gegebenenfalls\neinzelne Bestimmungen der OIB-Richtlinie 2 „Brandschutz“ zu berücksichtigen sind.\nVon den Anforderungen dieser OIB-Richtlinie kann entsprechend den jeweiligen landesrechtlichen\nBestimmungen abgewichen werden, wenn vom Bauwerber nachgewiesen wird, dass das gleiche\nSchutzniveau wie bei Anwendung der Richtlinie erreicht wird. Hierbei ist der OIB-Leitfaden „Abweichungen im Brandschutz und Brandschutzkonzepte“ anzuwenden."
     }
    ],
    "answer_meta": {
     "v": 1,
     "kind": "walkthrough",
     "summary": "Für ein konkretes Vorhaben ist zuerst der passende Teil nach Nutzung und Gebäudeart zu bestimmen; ob die Ausgabe Mai 2023 im jeweiligen Bundesland verbindlich gilt, ist gesondert zu prüfen.",
     "topic": "OIB-Richtlinie 2 – Brandschutz",
     "context": "Ausgabe Mai 2023 · landesrechtliche Verbindlichkeit nicht geprüft"
    },
    "stream_replace": true
   },
   {
    "t": 44.318,
    "status": "in_progress",
    "content": "",
    "cards": [
     {
      "type": "legal_basis",
      "law": "OIB-Richtlinie 2",
      "lane": "baurecht_oib",
      "edition": "Ausgabe Mai 2023",
      "summary": "Brandschutzanforderungen für Gebäude; ergänzende Richtlinien behandeln Betriebsbauten, Garagen und Gebäude mit höherem Fluchtniveau.",
      "original_text": "Diese Richtlinie gilt für Gebäude."
     }
    ]
   },
   {
    "t": 66.092,
    "status": "complete",
    "content": "Die OIB-Richtlinie 2 behandelt den **Brandschutz von Gebäuden**. Sie enthält Anforderungen unter anderem zur Tragfähigkeit im Brandfall, zur Begrenzung der Ausbreitung von Feuer und Rauch, zu Fluchtwegen und zur Brandbekämpfung [1][2].\n\nDie Ausgabe Mai 2023 weist auf mögliche Abweichungen nach Maßgabe des jeweiligen Landesrechts hin [1]. Ob diese Ausgabe für ein konkretes Vorhaben verbindlich ist, hängt daher auch vom Bundesland ab.\n\n## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.4\n- [2] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.5\n",
    "cards": [
     {
      "type": "legal_basis",
      "law": "OIB-Richtlinie 2",
      "lane": "baurecht_oib",
      "edition": "Ausgabe Mai 2023",
      "summary": "Brandschutzanforderungen für Gebäude; ergänzende Richtlinien behandeln Betriebsbauten, Garagen und Gebäude mit höherem Fluchtniveau.",
      "original_text": "Diese Richtlinie gilt für Gebäude."
     }
    ],
    "answer_confidence": "high",
    "sources": [
     {
      "number": 1,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.4",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "knowledge_search",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 4,
      "punkt": "0",
      "score": 0.587127923965454,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n\n0 Vorbemerkungen\nDie zitierten Normen und sonstigen technischen Regelwerke gelten in der im Dokument „OIB-\nRichtlinien – Zitierte Normen und sonstige technische Regelwerke“ angeführten Fassung.\nDiese Richtlinie gilt für Gebäude. Für sonstige Bauwerke sind die Bestimmungen der Richtlinie\nsinngemäß anzuwenden.\nWerden in dieser Richtlinie Anforderungen an die Feuerwiderstandsklasse in Verbindung mit Anforderungen an Baustoffe der Klasse A2 gestellt, gilt dies auch als erfüllt, wenn\n• die für die Tragfähigkeit wesentlichen Bestandteile der Bauteile der Klasse A2 entsprechen und\n• die sonstigen Bestandteile aus Baustoffen der Klasse B bestehen.\nFür eingeschoßige Gebäude mit höchstens 15 m² Brutto-Grundfläche, die auf eigenem Grund oder\nvon Verkehrsflächen für die Brandbekämpfung zugänglich sind, werden keine Anforderungen hinsichtlich des Brandschutzes gestellt.\nFür Gebäude mit gemischter Nutzung gelten die Anforderungen hinsichtlich des Brandschutzes für\ndie einzelnen Nutzungsbereiche als erfüllt, wenn die für die jeweiligen Nutzungen anzuwendenden\nBestimmungen der Richtlinien eingehalten werden, wobei gegenseitige Wechselwirkungen zu berücksichtigen"
     },
     {
      "number": 2,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.5",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.5",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "read_passage",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
      "page": 5,
      "punkt": "3",
      "score": 0.5824705362319946,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n\n3 Ausbreitung von Feuer und Rauch innerhalb des Bauwerkes"
     }
    ],
    "read_sources": [
     {
      "document_id": "doc:oib_knowledge:oib-rl_2.1_ausgabe_mai_2023.pdf",
      "title": "OIB-Richtlinie 2.1, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2.1_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "file_name": "oib-rl_2.1_ausgabe_mai_2023.pdf",
      "page": 4
     },
     {
      "document_id": "doc:oib_knowledge:oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
      "title": "OIB-Richtlinie 2.2, Ausgabe Mai 2023",
      "citation_key": "oib-richtlinie_2.2_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "file_name": "oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
      "page": 4
     },
     {
      "document_id": "doc:oib_knowledge:oib-rl_2.3_ausgabe_mai_2023.pdf",
      "title": "OIB-Richtlinie 2.3, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2.3_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "file_name": "oib-rl_2.3_ausgabe_mai_2023.pdf",
      "page": 4
     },
     {
      "document_id": "doc:oib_knowledge:erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf",
      "title": "Erläuterungen zu OIB-Richtlinie 2.1, Ausgabe Mai 2023",
      "citation_key": "erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib_erlaeuterung",
      "lane_label": "OIB-Erläuterung",
      "file_name": "erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf",
      "page": 4
     },
     {
      "document_id": "doc:oib_knowledge:erlaeuterungen-zu-oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
      "title": "Erläuterungen zu OIB-Richtlinie 2.2, Ausgabe Mai 2023",
      "citation_key": "erlaeuterungen-zu-oib-richtlinie_2.2_ausgabe_mai_2023.pdf, p.14",
      "collection": "oib_knowledge",
      "shelf": "base",
      "kind": "baurecht",
      "lane": "baurecht_oib_erlaeuterung",
      "lane_label": "OIB-Erläuterung",
      "file_name": "erlaeuterungen-zu-oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
      "page": 14
     }
    ],
    "routing_decision": "shallow",
    "answer_confidence_reason": "Geltungsbereiche und Themenübersicht stammen aus den abgerufenen Richtlinientexten.",
    "answer_meta": {
     "v": 1,
     "kind": "walkthrough",
     "summary": "Für ein konkretes Vorhaben ist zuerst der passende Teil nach Nutzung und Gebäudeart zu bestimmen; ob die Ausgabe Mai 2023 im jeweiligen Bundesland verbindlich gilt, ist gesondert zu prüfen.",
     "topic": "OIB-Richtlinie 2 – Brandschutz",
     "context": "Ausgabe Mai 2023 · landesrechtliche Verbindlichkeit nicht geprüft"
    },
    "retrieval_ledger": [
     {
      "index": 0,
      "key": "status.retrieval.withQuery",
      "tools": [
       "knowledge_search"
      ],
      "corpora": [
       "knowledge"
      ],
      "docs": [
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 0 p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2.1_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2.1, Ausgabe Mai 2023",
        "detail": "Pkt. 0 p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2.2, Ausgabe Mai 2023",
        "detail": "Pkt. 0 p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2.3_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2.3, Ausgabe Mai 2023",
        "detail": "Pkt. 0 p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf",
        "title": "Erläuterungen zu OIB-Richtlinie 2.1, Ausgabe Mai 2023",
        "detail": "p.4",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "erlaeuterungen-zu-oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
        "title": "Erläuterungen zu OIB-Richtlinie 2.2, Ausgabe Mai 2023",
        "detail": "p.14",
        "shelf": "base",
        "repeat": false
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 8 p.23",
        "shelf": "base",
        "repeat": false
       }
      ],
      "new_docs": [
       "oib-rl_2_ausgabe_mai_2023.pdf",
       "oib-rl_2.1_ausgabe_mai_2023.pdf",
       "oib-richtlinie_2.2_ausgabe_mai_2023.pdf",
       "oib-rl_2.3_ausgabe_mai_2023.pdf",
       "erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf",
       "erlaeuterungen-zu-oib-richtlinie_2.2_ausgabe_mai_2023.pdf"
      ],
      "hits": 7,
      "documents": 6,
      "query": "Was weißt du über die OIB-Richt…"
     },
     {
      "index": 1,
      "key": "status.retrieval.punkt",
      "tools": [
       "read_passage",
       "read_passage",
       "read_passage",
       "read_passage",
       "read_passage",
       "read_passage",
       "read_passage",
       "read_passage"
      ],
      "corpora": [
       "knowledge"
      ],
      "docs": [
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 3 p.5",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 5 p.13",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 10 p.23",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 6 p.14",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 4 p.12",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 2 p.4",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 9 p.23",
        "shelf": "base",
        "repeat": true
       },
       {
        "name": "oib-rl_2_ausgabe_mai_2023.pdf",
        "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
        "detail": "Pkt. 7 p.15",
        "shelf": "base",
        "repeat": true
       }
      ],
      "new_docs": [],
      "hits": 8,
      "documents": 1,
      "reason": "Die Gliederung zeigt die Themenbereiche; ich öffne die zentralen Punkte, damit die Übersicht auf Richtlinientext statt nur auf dem Index beruht."
     }
    ]
   }
  ]
 }
}
