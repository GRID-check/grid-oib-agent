/**
 * Two live answers as the WebSocket delivered them (2026-09-24, ADR-0066): the
 * prose deltas, the settled snapshot, and the terminal frame with its cards
 * and anatomy, each stamped with its second since the turn began. Recorded,
 * not written: the replay at `/dev/stream-replay` is only as honest as these.
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
}

export interface RecordedTurn {
  question: string
  frames: RecordedFrame[]
}

export const STREAM_FRAMES: Record<'varianten' | 'oib2', RecordedTurn> = {
 "varianten": {
  "question": "Für den zweiten Fluchtweg in GK 4 überlegen wir eine Außentreppe oder ein zweites Treppenhaus. Was müsste ich jeweils nachweisen?",
  "frames": [
   {
    "t": 34.487,
    "status": "in_progress",
    "content": "Für den zweiten Fluchtweg müssen Sie in beiden Varianten die"
   },
   {
    "t": 34.556,
    "status": "in_progress",
    "content": " Unabhängigkeit des Weges und seine"
   },
   {
    "t": 34.656,
    "status": "in_progress",
    "content": " Führung bis zu einem sicheren Ort im Freien"
   },
   {
    "t": 34.753,
    "status": "in_progress",
    "content": " zeigen; bei Wohnungen ist zusätzlich"
   },
   {
    "t": 34.815,
    "status": "in_progress",
    "content": " die gemeinsame Weglänge zu prüfen"
   },
   {
    "t": 34.903,
    "status": "in_progress",
    "content": " [1]. Die folgende"
   },
   {
    "t": 34.974,
    "status": "in_progress",
    "content": " Gegenüberstellung folgt der OIB-Richtlinie"
   },
   {
    "t": 35.025,
    "status": "in_progress",
    "content": " 2, Ausgabe Mai 202"
   },
   {
    "t": 35.131,
    "status": "in_progress",
    "content": "3. Welche Ausgabe in Ihrem Bundesland"
   },
   {
    "t": 35.197,
    "status": "in_progress",
    "content": " verbindlich ist,"
   },
   {
    "t": 35.29,
    "status": "in_progress",
    "content": " ist hier nicht geklärt.\n\n"
   },
   {
    "t": 35.37,
    "status": "in_progress",
    "content": "\n"
   },
   {
    "t": 35.429,
    "status": "in_progress",
    "content": "\n"
   },
   {
    "t": 35.494,
    "status": "in_progress",
    "content": "Für den ersten Fluchtweg nennt Punkt 5."
   },
   {
    "t": 35.546,
    "status": "in_progress",
    "content": "1.1 c)"
   },
   {
    "t": 35.601,
    "status": "in_progress",
    "content": " höchstens 40 m Gehweglänge bis"
   },
   {
    "t": 35.668,
    "status": "in_progress",
    "content": " zu einem Treppen"
   },
   {
    "t": 35.845,
    "status": "in_progress",
    "content": "haus oder einer Außentreppe nach Tabelle 3; der zusätzliche Weg muss nach Punkt 5.1.4 unabhängig zu"
   },
   {
    "t": 35.986,
    "status": "in_progress",
    "content": " einer weiteren solchen Anlage führen [1]. Falls es Wohnungen"
   },
   {
    "t": 36.037,
    "status": "in_progress",
    "content": " sind,"
   },
   {
    "t": 36.109,
    "status": "in_progress",
    "content": " dürfen die Wege nach"
   },
   {
    "t": 36.172,
    "status": "in_progress",
    "content": " Punkt 5.1.5 höch"
   },
   {
    "t": 36.225,
    "status": "in_progress",
    "content": "stens 25 m gemeinsam verlaufen;"
   },
   {
    "t": 36.312,
    "status": "in_progress",
    "content": " bei einem Stichgang höchstens 15 m"
   },
   {
    "t": 36.402,
    "status": "in_progress",
    "content": " ab Wohnungseingangstüre [2]."
   },
   {
    "t": 36.485,
    "status": "in_progress",
    "content": "\n\n"
   },
   {
    "t": 36.562,
    "status": "in_progress",
    "content": "Für den Nachweis sollten die Grundrisse den"
   },
   {
    "t": 36.637,
    "status": "in_progress",
    "content": " Verlauf beider Wege"
   },
   {
    "t": 36.721,
    "status": "in_progress",
    "content": ", ihre Trennung"
   },
   {
    "t": 36.783,
    "status": "in_progress",
    "content": ", die Ausgänge ins Freie und die"
   },
   {
    "t": 36.85,
    "status": "in_progress",
    "content": " jeweiligen baulichen Eigenschaften"
   },
   {
    "t": 36.926,
    "status": "in_progress",
    "content": " erkennen lassen. Welche"
   },
   {
    "t": 36.986,
    "status": "in_progress",
    "content": " konkreten Plan- und Berechnungs"
   },
   {
    "t": 37.091,
    "status": "in_progress",
    "content": "unterlagen die zuständige Baubehörde"
   },
   {
    "t": 37.182,
    "status": "in_progress",
    "content": " verlangt, ist landesrechtlich zu prüfen.\n\n"
   },
   {
    "t": 37.636,
    "status": "in_progress",
    "content": "Für den zweiten Fluchtweg müssen Sie in beiden Varianten die Unabhängigkeit des Weges und seine Führung bis zu einem sicheren Ort im Freien zeigen; bei Wohnungen ist zusätzlich die gemeinsame Weglänge zu prüfen [1]. Die folgende Gegenüberstellung folgt der OIB-Richtlinie 2, Ausgabe Mai 2023. Welche Ausgabe in Ihrem Bundesland verbindlich ist, ist hier nicht geklärt.\n\n\n\nFür den ersten Fluchtweg nennt Punkt 5.1.1 c) höchstens 40 m Gehweglänge bis zu einem Treppenhaus oder einer Außentreppe nach Tabelle 3; der zusätzliche Weg muss nach Punkt 5.1.4 unabhängig zu einer weiteren solchen Anlage führen [1]. Falls es Wohnungen sind, dürfen die Wege nach Punkt 5.1.5 höchstens 25 m gemeinsam verlaufen; bei einem Stichgang höchstens 15 m ab Wohnungseingangstüre [2].\n\nFür den Nachweis sollten die Grundrisse den Verlauf beider Wege, ihre Trennung, die Ausgänge ins Freie und die jeweiligen baulichen Eigenschaften erkennen lassen. Welche konkreten Plan- und Berechnungsunterlagen die zuständige Baubehörde verlangt, ist landesrechtlich zu prüfen.\n\n## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13 und p.30\n- [2] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13",
    "sources": [
     {
      "number": 1,
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
      "score": 0.5928531885147095,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\nTabelle 3: Anforderungen an Treppenhäuser bzw. Außentreppen im Verlauf von Fluchtwegen gemäß Punkt 5.1.1 c) (Teil 3 von 3)\n\n| Gegenstand | GK 2 (1) | GK 3 | GK 4 | GK 5 |\n|---|---|---|---|---|\n| (4) Für die Türen umgebende Glasflächen mit einer Fläche von nicht mehr als dem Dreifachen der Türblattfläche genügt E 30; |  |  |  |  |\n| (5) Die Rauchabzugseinrichtung kann entfallen, wenn in jedem Geschoß unmittelbar ins Freie führende Fenster mit einem freien Querschnitt von jeweils mindestens 0,50 m² angeordnet sind, die von Stand aus ohne fremde Hilfsmittel geöffnet werden können. |  |  |  |  |\n\nOIB-Richtlinie 2 — Brandschutz\nTabelle 3: Anforderungen an Treppenhäuser bzw. Außentreppen im Verlauf von Fluchtwegen gemäß Punkt 5.1.1 c) (Teil 1 von 3)\n\n| Gegenstand | GK 2 (1) | GK 3 | GK 4 | GK 5 |\n|---|---|---|---|---|\n| 1 Wände von Treppenhäusern |  |  |  |  |\n| 1.1 in oberirdischen Geschoßen (2) | REI 30 EI 30 | REI 60 EI 60 | REI 60 EI 60 | REI 90 und A2 EI 90 und A2 |\n| 1.2 in unterirdischen Geschoßen | REI 60 EI 60 | REI 90 und A2 EI 90 und A2 | REI 90 und A2 EI 90 und A2 | REI 90 und A2 EI 90 und A2 |\n| 2 Decke über dem Treppenhaus (3) | REI 30 | REI"
     },
     {
      "number": 2,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.13",
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
      "page": 13,
      "punkt": "5.1.4",
      "score": 0.5745587348937988,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.1 Fluchtwege\n\n5.1.4 Im Falle von Punkt 5.1.1 c) muss in jedem Geschoß mit Aufenthaltsräumen zusätzlich\na) ein Rettungsweg gemäß Punkt 5.2 vorhanden sein, oder\nb) ein unabhängiger Fluchtweg zu einem weiteren Treppenhaus oder einer weiteren Außentreppe\njeweils gemäß Tabelle 3 erreichbar sein, wobei die Gehweglänge nicht begrenzt ist, oder\nc) ein unabhängiger Fluchtweg zu einem benachbarten Brandabschnitt erreichbar sein, der über\neinen direkten Ausgang zu einem sicheren Ort des angrenzenden Geländes im Freien oder ein\nTreppenhaus bzw. eine Außentreppe verfügt, wobei die Gehweglänge zum benachbarten\nBrandabschnitt nicht begrenzt ist.\n\nOIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.1 Fluchtwege\n\n5.1.1 Von jeder Stelle jedes Raumes – ausgenommen nicht ausgebaute Dachräume – muss in höchstens 40 m Gehweglänge erreichbar sein:\na) ein direkter Ausgang zu einem sicheren Ort des angrenzenden Geländes im Freien, oder\nb) ein Treppenhaus oder eine Außentreppe gemäß Tabelle 2a bzw. 2b mit jeweils einem Ausgang\nzu einem sicheren Ort des angrenzenden Geländes im Freien, oder\nc) ein Treppenhaus oder eine Außentreppe gemäß"
     }
    ],
    "stream_replace": true
   },
   {
    "t": 46.036,
    "status": "complete",
    "content": "Für den zweiten Fluchtweg müssen Sie in beiden Varianten die Unabhängigkeit des Weges und seine Führung bis zu einem sicheren Ort im Freien zeigen; bei Wohnungen ist zusätzlich die gemeinsame Weglänge zu prüfen [1]. Die folgende Gegenüberstellung folgt der OIB-Richtlinie 2, Ausgabe Mai 2023. Welche Ausgabe in Ihrem Bundesland verbindlich ist, ist hier nicht geklärt.\n\n[[card:1]]\n\nFür den ersten Fluchtweg nennt Punkt 5.1.1 c) höchstens 40 m Gehweglänge bis zu einem Treppenhaus oder einer Außentreppe nach Tabelle 3; der zusätzliche Weg muss nach Punkt 5.1.4 unabhängig zu einer weiteren solchen Anlage führen [1]. Falls es Wohnungen sind, dürfen die Wege nach Punkt 5.1.5 höchstens 25 m gemeinsam verlaufen; bei einem Stichgang höchstens 15 m ab Wohnungseingangstüre [2].\n\nFür den Nachweis sollten die Grundrisse den Verlauf beider Wege, ihre Trennung, die Ausgänge ins Freie und die jeweiligen baulichen Eigenschaften erkennen lassen. Welche konkreten Plan- und Berechnungsunterlagen die zuständige Baubehörde verlangt, ist landesrechtlich zu prüfen.\n\n## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13 und p.30\n- [2] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13\n",
    "cards": [
     {
      "type": "surface",
      "title": "Zweiter Fluchtweg in GK 4 – Varianten",
      "components": [
       {
        "id": "root",
        "component": "Column",
        "children": [
         "basis",
         "varianten"
        ]
       },
       {
        "id": "basis",
        "component": "legal_basis",
        "law": "OIB-Richtlinie 2",
        "lane": "baurecht_oib",
        "edition": "Ausgabe Mai 2023",
        "article": "5.1.4",
        "section": "Tabelle 3",
        "summary": "Der zusätzliche Fluchtweg führt unabhängig zu einem weiteren Treppenhaus oder einer weiteren Außentreppe nach Tabelle 3.",
        "original_text": "ein unabhängiger Fluchtweg zu einem weiteren Treppenhaus oder einer weiteren Außentreppe jeweils gemäß Tabelle 3 erreichbar sein"
       },
       {
        "id": "varianten",
        "component": "Tabs",
        "tabs": [
         {
          "title": "Außentreppe",
          "child": "aussen"
         },
         {
          "title": "Zweites Treppenhaus",
          "child": "innen"
         }
        ]
       },
       {
        "id": "aussen",
        "component": "Text",
        "text": "| Nachweis | Anforderung | Fundstelle |\n|---|---|---|\n| Unabhängiger Weg und Ausgang | Von jedem maßgeblichen Geschoß unabhängig zur weiteren Außentreppe; diese führt zu einem sicheren Ort im Freien | OIB-RL 2, Pkt. 5.1.4 und 5.1.1 c) [1] |\n| Baustoff und Brandbeanspruchung | Außentreppe aus A2; im Brandfall keine Beeinträchtigung durch Flammeneinwirkung oder gefahrbringende Strahlungswärme | Tabelle 3 [1] |\n| Darstellung im Einreichplan | Wegführung, Anschlüsse an die Geschoße und Ausgang ins Freie nachvollziehbar darstellen | Nachweisführung zu Pkt. 5.1.4 [1] |"
       },
       {
        "id": "innen",
        "component": "Text",
        "text": "| Nachweis | Anforderung | Fundstelle |\n|---|---|---|\n| Unabhängiger Weg und Ausgang | Von jedem maßgeblichen Geschoß unabhängig zum zweiten Treppenhaus; dieses führt zu einem sicheren Ort im Freien | OIB-RL 2, Pkt. 5.1.4 und 5.1.1 c) [1] |\n| Baulicher Brandschutz, oberirdisch | Treppenhauswände REI 60 bzw. EI 60; Decke darüber REI 60 | Tabelle 3 [1] |\n| Baulicher Brandschutz, unterirdisch | Treppenhauswände REI 90 und A2 bzw. EI 90 und A2 | Tabelle 3 [1] |\n| Türen und Treppenläufe | Türen je nach angrenzendem Bereich nach Tabelle 3; Treppenläufe und Podeste R 60 | Tabelle 3 [1] |\n| Rauchabzug | Rauchabzugseinrichtung an der obersten Stelle; geometrisch freier Querschnitt 1,00 m² | Tabelle 3 [1] |\n| Darstellung im Einreichplan | Wegführung, Treppenhausabgrenzung, Türen, Bauteilqualitäten und Ausgang ins Freie nachvollziehbar darstellen | Nachweisführung zu Pkt. 5.1.4 und Tabelle 3 [1] |"
       }
      ]
     }
    ],
    "answer_confidence": "medium",
    "sources": [
     {
      "number": 1,
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
      "score": 0.5928531885147095,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\nTabelle 3: Anforderungen an Treppenhäuser bzw. Außentreppen im Verlauf von Fluchtwegen gemäß Punkt 5.1.1 c) (Teil 3 von 3)\n\n| Gegenstand | GK 2 (1) | GK 3 | GK 4 | GK 5 |\n|---|---|---|---|---|\n| (4) Für die Türen umgebende Glasflächen mit einer Fläche von nicht mehr als dem Dreifachen der Türblattfläche genügt E 30; |  |  |  |  |\n| (5) Die Rauchabzugseinrichtung kann entfallen, wenn in jedem Geschoß unmittelbar ins Freie führende Fenster mit einem freien Querschnitt von jeweils mindestens 0,50 m² angeordnet sind, die von Stand aus ohne fremde Hilfsmittel geöffnet werden können. |  |  |  |  |\n\nOIB-Richtlinie 2 — Brandschutz\nTabelle 3: Anforderungen an Treppenhäuser bzw. Außentreppen im Verlauf von Fluchtwegen gemäß Punkt 5.1.1 c) (Teil 1 von 3)\n\n| Gegenstand | GK 2 (1) | GK 3 | GK 4 | GK 5 |\n|---|---|---|---|---|\n| 1 Wände von Treppenhäusern |  |  |  |  |\n| 1.1 in oberirdischen Geschoßen (2) | REI 30 EI 30 | REI 60 EI 60 | REI 60 EI 60 | REI 90 und A2 EI 90 und A2 |\n| 1.2 in unterirdischen Geschoßen | REI 60 EI 60 | REI 90 und A2 EI 90 und A2 | REI 90 und A2 EI 90 und A2 | REI 90 und A2 EI 90 und A2 |\n| 2 Decke über dem Treppenhaus (3) | REI 30 | REI"
     },
     {
      "number": 2,
      "document_id": "doc:oib_knowledge:oib-rl_2_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.13",
      "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2_ausgabe_mai_2023.pdf, p.13",
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
      "page": 13,
      "punkt": "5.1.4",
      "score": 0.5745587348937988,
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.1 Fluchtwege\n\n5.1.4 Im Falle von Punkt 5.1.1 c) muss in jedem Geschoß mit Aufenthaltsräumen zusätzlich\na) ein Rettungsweg gemäß Punkt 5.2 vorhanden sein, oder\nb) ein unabhängiger Fluchtweg zu einem weiteren Treppenhaus oder einer weiteren Außentreppe\njeweils gemäß Tabelle 3 erreichbar sein, wobei die Gehweglänge nicht begrenzt ist, oder\nc) ein unabhängiger Fluchtweg zu einem benachbarten Brandabschnitt erreichbar sein, der über\neinen direkten Ausgang zu einem sicheren Ort des angrenzenden Geländes im Freien oder ein\nTreppenhaus bzw. eine Außentreppe verfügt, wobei die Gehweglänge zum benachbarten\nBrandabschnitt nicht begrenzt ist.\n\nOIB-Richtlinie 2 — Brandschutz\n5 Flucht- und Rettungswege › 5.1 Fluchtwege\n\n5.1.1 Von jeder Stelle jedes Raumes – ausgenommen nicht ausgebaute Dachräume – muss in höchstens 40 m Gehweglänge erreichbar sein:\na) ein direkter Ausgang zu einem sicheren Ort des angrenzenden Geländes im Freien, oder\nb) ein Treppenhaus oder eine Außentreppe gemäß Tabelle 2a bzw. 2b mit jeweils einem Ausgang\nzu einem sicheren Ort des angrenzenden Geländes im Freien, oder\nc) ein Treppenhaus oder eine Außentreppe gemäß"
     }
    ],
    "answer_meta": {
     "v": 1,
     "kind": "walkthrough",
     "topic": "Zweiter Fluchtweg",
     "context": "OIB-Richtlinie 2, Ausgabe Mai 2023 · Bundesland nicht angegeben"
    }
   }
  ]
 },
 "oib2": {
  "question": "Was weißt du über die OIB-Richtlinie 2?",
  "frames": [
   {
    "t": 30.918,
    "status": "in_progress",
    "content": "Die OIB-Richtlinie 2 behandelt den **Brandschutz von Gebä"
   },
   {
    "t": 30.979,
    "status": "in_progress",
    "content": "uden**: von der Tragfähigkeit im Brandfall über die"
   },
   {
    "t": 31.034,
    "status": "in_progress",
    "content": " Begrenzung der"
   },
   {
    "t": 31.089,
    "status": "in_progress",
    "content": " Ausbreitung von Feuer und Rauch bis"
   },
   {
    "t": 31.169,
    "status": "in_progress",
    "content": " zu Flucht- und Rettungswegen"
   },
   {
    "t": 31.269,
    "status": "in_progress",
    "content": " sowie Brandbekämpfung [1]."
   },
   {
    "t": 31.333,
    "status": "in_progress",
    "content": " Die Ausgabe Mai 2023 glied"
   },
   {
    "t": 31.403,
    "status": "in_progress",
    "content": "ert sich in einen allgemeinen Teil und drei"
   },
   {
    "t": 31.508,
    "status": "in_progress",
    "content": " ergänzende Richtlinien für"
   },
   {
    "t": 31.643,
    "status": "in_progress",
    "content": " besondere Gebäude"
   },
   {
    "t": 31.712,
    "status": "in_progress",
    "content": "arten beziehungsweise Situationen"
   },
   {
    "t": 31.766,
    "status": "in_progress",
    "content": " [2–5].\n\n"
   },
   {
    "t": 31.884,
    "status": "in_progress",
    "content": "| Teil | Geltungsbereich | Regelungsschwerpunkt |\n"
   },
   {
    "t": 31.979,
    "status": "in_progress",
    "content": "|---|---|---|\n"
   },
   {
    "t": 32.07,
    "status": "in_progress",
    "content": "| OIB-RL 2 | Gebäude allgemein | Tragfähigkeit im Brandfall, Aus"
   },
   {
    "t": 32.141,
    "status": "in_progress",
    "content": "breitung von Feuer und Rauch, Flucht"
   },
   {
    "t": 32.216,
    "status": "in_progress",
    "content": "- und Rettungswege, Brandbekämpfung"
   },
   {
    "t": 32.268,
    "status": "in_progress",
    "content": " [1] |\n"
   },
   {
    "t": 32.511,
    "status": "in_progress",
    "content": "| OIB-RL 2.1 | Betriebsbauten | Brandschutz bei Betriebsbauten [3] |\n"
   },
   {
    "t": 32.634,
    "status": "in_progress",
    "content": "| OIB-RL 2.2 | Garagen, überdachte Stellplätze und Parkde"
   },
   {
    "t": 32.73,
    "status": "in_progress",
    "content": "cks | Brandschutz"
   },
   {
    "t": 32.831,
    "status": "in_progress",
    "content": " nach Art und Größe"
   },
   {
    "t": 32.885,
    "status": "in_progress",
    "content": " der Anlage [4] |\n"
   },
   {
    "t": 33.054,
    "status": "in_progress",
    "content": "| OIB-RL 2.3 | Gebäude mit einem"
   },
   {
    "t": 33.162,
    "status": "in_progress",
    "content": " Fluchtniveau über 22 m | Ergänzende Brandschutzbestimmungen für diese Gebäude [5]"
   },
   {
    "t": 33.228,
    "status": "in_progress",
    "content": " |\n\n```mermaid\n"
   },
   {
    "t": 33.3,
    "status": "in_progress",
    "content": "mindmap\n"
   },
   {
    "t": 33.429,
    "status": "in_progress",
    "content": "  root((\"OIB-Richtlinie 2\"))\n"
   },
   {
    "t": 33.531,
    "status": "in_progress",
    "content": "    \"Allgemeiner Teil\"\n"
   },
   {
    "t": 33.626,
    "status": "in_progress",
    "content": "      \"Bauteile und Feuerwiderstand\"\n"
   },
   {
    "t": 33.763,
    "status": "in_progress",
    "content": "      \"Feuer- und Rauchausbreitung\"\n"
   },
   {
    "t": 33.885,
    "status": "in_progress",
    "content": "      \"Fluchtwege und Brandbekämpfung\"\n"
   },
   {
    "t": 34.031,
    "status": "in_progress",
    "content": "    \"Betriebsbauten · 2.1\"\n"
   },
   {
    "t": 34.103,
    "status": "in_progress",
    "content": "      \"Eigene Bestimmungen für Betriebsbauten\"\n"
   },
   {
    "t": 34.22,
    "status": "in_progress",
    "content": "    \"Garagen · 2.2\"\n"
   },
   {
    "t": 34.597,
    "status": "in_progress",
    "content": "      \"Garagen und Parkdecks\"\n"
   },
   {
    "t": 35.075,
    "status": "in_progress",
    "content": "    \"Hohes Fluchtniveau · 2.3\"\n      \"Gebäude über 22 m Fluchtn"
   },
   {
    "t": 35.134,
    "status": "in_progress",
    "content": "iveau\"\n```\n\nWelche Anforderungen für ein konkre"
   },
   {
    "t": 35.202,
    "status": "in_progress",
    "content": "tes Vorhaben gelten, hängt unter anderem von Nutzung und Gebäudeart ab. Außerdem ist zu prüfen, welche Ausgabe das jeweilige"
   },
   {
    "t": 35.277,
    "status": "in_progress",
    "content": " Bundesland verbindlich erklärt hat und ob"
   },
   {
    "t": 35.356,
    "status": "in_progress",
    "content": " landesrechtliche Ab"
   },
   {
    "t": 35.477,
    "status": "in_progress",
    "content": "weichungen bestehen; die Richtlinie verwe"
   },
   {
    "t": 35.544,
    "status": "in_progress",
    "content": "ist ausdrücklich auf land"
   },
   {
    "t": 35.658,
    "status": "in_progress",
    "content": "esrechtlich mögliche Abweichungen bei nachgewiesenem"
   },
   {
    "t": 35.725,
    "status": "in_progress",
    "content": " gleichem Schutzniveau"
   },
   {
    "t": 35.819,
    "status": "in_progress",
    "content": " [1].\n"
   },
   {
    "t": 35.874,
    "status": "in_progress",
    "content": "\n"
   },
   {
    "t": 36.966,
    "status": "in_progress",
    "content": "Die OIB-Richtlinie 2 behandelt den **Brandschutz von Gebäuden**: von der Tragfähigkeit im Brandfall über die Begrenzung der Ausbreitung von Feuer und Rauch bis zu Flucht- und Rettungswegen sowie Brandbekämpfung [1]. Die Ausgabe Mai 2023 gliedert sich in einen allgemeinen Teil und drei ergänzende Richtlinien für besondere Gebäudearten beziehungsweise Situationen [2–5].\n\n| Teil | Geltungsbereich | Regelungsschwerpunkt |\n|---|---|---|\n| OIB-RL 2 | Gebäude allgemein | Tragfähigkeit im Brandfall, Ausbreitung von Feuer und Rauch, Flucht- und Rettungswege, Brandbekämpfung [1] |\n| OIB-RL 2.1 | Betriebsbauten | Brandschutz bei Betriebsbauten [3] |\n| OIB-RL 2.2 | Garagen, überdachte Stellplätze und Parkdecks | Brandschutz nach Art und Größe der Anlage [4] |\n| OIB-RL 2.3 | Gebäude mit einem Fluchtniveau über 22 m | Ergänzende Brandschutzbestimmungen für diese Gebäude [5] |\n\n```mermaid\nmindmap\n  root((\"OIB-Richtlinie 2\"))\n    \"Allgemeiner Teil\"\n      \"Bauteile und Feuerwiderstand\"\n      \"Feuer- und Rauchausbreitung\"\n      \"Fluchtwege und Brandbekämpfung\"\n    \"Betriebsbauten · 2.1\"\n      \"Eigene Bestimmungen für Betriebsbauten\"\n    \"Garagen · 2.2\"\n      \"Garagen und Parkdecks\"\n    \"Hohes Fluchtniveau · 2.3\"\n      \"Gebäude über 22 m Fluchtniveau\"\n```\n\nWelche Anforderungen für ein konkretes Vorhaben gelten, hängt unter anderem von Nutzung und Gebäudeart ab. Außerdem ist zu prüfen, welche Ausgabe das jeweilige Bundesland verbindlich erklärt hat und ob landesrechtliche Abweichungen bestehen; die Richtlinie verweist ausdrücklich auf landesrechtlich mögliche Abweichungen bei nachgewiesenem gleichem Schutzniveau [1].\n\n## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.4\n- [2] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.23\n- [3] [KB] oib-rl_2.1_ausgabe_mai_2023.pdf, p.4\n- [4] [KB] oib-richtlinie_2.2_ausgabe_mai_2023.pdf, p.4\n- [5] [KB] oib-rl_2.3_ausgabe_mai_2023.pdf, p.4",
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
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n\n8 Betriebsbauten\nEs gelten die Bestimmungen der OIB-Richtlinie 2.1 „Brandschutz bei Betriebsbauten“.\n\nOIB-Richtlinie 2 — Brandschutz\n\n9 Garagen, überdachte Stellplätze und Parkdecks\nEs gelten die Bestimmungen der OIB-Richtlinie 2.2 „Brandschutz bei Garagen, überdachten Stellplätzen und Parkdecks“.\n\nOIB-Richtlinie 2 — Brandschutz\n\n10 Gebäude mit einem Fluchtniveau von mehr als 22 m\nEs gelten die Bestimmungen der OIB-Richtlinie 2.3 „Brandschutz bei Gebäuden mit einem Fluchtniveau von mehr als 22 m“.\n\nOIB-Richtlinie 2 — Brandschutz\n\n11 Sondergebäude\nFür folgende Sondergebäude ist ein Brandschutzkonzept erforderlich, das dem OIB-Leitfaden „Abweichungen im Brandschutz und Brandschutzkonzepte“ zu entsprechen hat:\na) Verkaufsstätten\n− mit einer Verkaufsfläche von mehr als 3.000 m²,\n− mit mehr als drei in offener Verbindung stehenden Geschoßen,\nb) Versammlungsstätten\n− mit Großbühne,\n− mit mehr als drei in offener Verbindung stehenden Geschoßen,\n− mit einem Fluchtniveau eines Versammlungsraumes von mehr als 22 m,\n− mit einer Netto-Grundfläche in Summe von mehr als 4.800 m²,\nc) Justizanstalten,\nd) Sonstige Sondergebäude und Bauwerke, auf die die"
     },
     {
      "number": 3,
      "document_id": "doc:oib_knowledge:oib-rl_2.1_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2.1_ausgabe_mai_2023.pdf, p.4",
      "title": "OIB-Richtlinie 2.1, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2.1_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "knowledge_search",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2.1_ausgabe_mai_2023.pdf",
      "page": 4,
      "punkt": "0",
      "score": 0.588470458984375,
      "snippet": "OIB-Richtlinie 2.1 — Brandschutz bei Betriebsbauten\n\n0 Vorbemerkungen\nDie zitierten Normen und sonstigen technischen Regelwerke gelten in der im Dokument „OIB-\nRichtlinien – Zitierte Normen und sonstige technische Regelwerke“ angeführten Fassung.\nWerden in dieser Richtlinie Anforderungen an die Feuerwiderstandsklasse in Verbindung mit Anforderungen an Baustoffe der Klasse A2 gestellt, gilt dies auch als erfüllt, wenn\n• die für die Tragfähigkeit wesentlichen Bestandteile der Bauteile der Klasse A2 entsprechen und\n• die sonstigen Bestandteile aus Baustoffen der Klasse B bestehen.\nEs wird darauf hingewiesen, dass parallel zu den Bestimmungen dieser Richtlinie gegebenenfalls\neinzelne Bestimmungen der OIB-Richtlinie 2 „Brandschutz“ zu berücksichtigen sind.\nBei Betriebsbauten können in Abhängigkeit des jeweiligen Gefahrenpotenzials, wie Brandbelastung, Aktivierungsgefahr und Umgebungssituation, höhere Anforderungen notwendig werden, wie\nz.B. für Chemiebetriebe.\nFür folgende Betriebsbauten sind aufgrund eines geringeren Risikos im Brandfall Erleichterungen\nvon den Anforderungen dieser Richtlinie zulässig:\n• Betriebsbauten, die lediglich der Aufstellung technischer Anlagen dienen und von"
     },
     {
      "number": 4,
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
      "score": 0.5978373289108276,
      "snippet": "OIB-Richtlinie 2.2 — Brandschutz bei Garagen, überdachten Stellplätzen und Parkdecks\n\n0 Vorbemerkungen\nDie zitierten Normen und sonstigen technischen Regelwerke gelten in der im Dokument „OIB-\nRichtlinien – Zitierte Normen und sonstige technische Regelwerke“ angeführten Fassung.\nWerden in dieser Richtlinie Anforderungen an die Feuerwiderstandsklasse in Verbindung mit Anforderungen an Baustoffe der Klasse A2 gestellt, gilt dies auch als erfüllt, wenn\n• die für die Tragfähigkeit wesentlichen Bestandteile der Bauteile der Klasse A2 und\n• die sonstigen Bestandteile aus Baustoffen der Klasse B bestehen.\nFür überdachte Stellplätze und Garagen mit jeweils höchstens 15 m² Nutzfläche, die auf eigenem\nGrund oder von Verkehrsflächen für die Brandbekämpfung zugänglich sind, werden keine Anforderungen hinsichtlich des Brandschutzes gestellt.\nBei Garagen und überdachten Stellplätzen von anerkannten Einsatzorganisationen sind Ausnahmen in Bezug auf Lagerungen (z.B. Materialien, Ausrüstungen, Treibstoffe) und untergeordneten\nNutzungen zulässig, sofern sie zur Erfüllung der gesetzlichen Aufgaben erforderlich sind und keine\nbrandschutztechnischen Bedenken bestehen.\nEs wird darauf hingewiesen, dass"
     },
     {
      "number": 5,
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
      "score": 0.6180552244186401,
      "snippet": "OIB-Richtlinie 2.3 — Brandschutz bei Gebäuden mit einem Fluchtniveau von mehr als 22 m\n\n0 Vorbemerkungen\nDie zitierten Normen und sonstigen technischen Regelwerke gelten in der im Dokument „OIB-\nRichtlinien – Zitierte Normen und sonstige technische Regelwerke“ angeführten Fassung.\nWerden in dieser Richtlinie Anforderungen an die Feuerwiderstandsklasse in Verbindung mit Anforderungen an Baustoffe der Klasse A2 gestellt, gilt dies auch als erfüllt, wenn\n• die für die Tragfähigkeit wesentlichen Bestandteile der Bauteile der Klasse A2 entsprechen und\n• die sonstigen Bestandteile aus Baustoffen der Klasse B bestehen.\nEs wird darauf hingewiesen, dass parallel zu den Bestimmungen dieser Richtlinie gegebenenfalls\neinzelne Bestimmungen der OIB-Richtlinie 2 „Brandschutz“ zu berücksichtigen sind.\nVon den Anforderungen dieser OIB-Richtlinie kann entsprechend den jeweiligen landesrechtlichen\nBestimmungen abgewichen werden, wenn vom Bauwerber nachgewiesen wird, dass das gleiche\nSchutzniveau wie bei Anwendung der Richtlinie erreicht wird. Hierbei ist der OIB-Leitfaden „Abweichungen im Brandschutz und Brandschutzkonzepte“ anzuwenden."
     }
    ],
    "stream_replace": true
   },
   {
    "t": 39.239,
    "status": "complete",
    "content": "Die OIB-Richtlinie 2 behandelt den **Brandschutz von Gebäuden**: von der Tragfähigkeit im Brandfall über die Begrenzung der Ausbreitung von Feuer und Rauch bis zu Flucht- und Rettungswegen sowie Brandbekämpfung [1]. Die Ausgabe Mai 2023 gliedert sich in einen allgemeinen Teil und drei ergänzende Richtlinien für besondere Gebäudearten beziehungsweise Situationen [2–5].\n\n| Teil | Geltungsbereich | Regelungsschwerpunkt |\n|---|---|---|\n| OIB-RL 2 | Gebäude allgemein | Tragfähigkeit im Brandfall, Ausbreitung von Feuer und Rauch, Flucht- und Rettungswege, Brandbekämpfung [1] |\n| OIB-RL 2.1 | Betriebsbauten | Brandschutz bei Betriebsbauten [3] |\n| OIB-RL 2.2 | Garagen, überdachte Stellplätze und Parkdecks | Brandschutz nach Art und Größe der Anlage [4] |\n| OIB-RL 2.3 | Gebäude mit einem Fluchtniveau über 22 m | Ergänzende Brandschutzbestimmungen für diese Gebäude [5] |\n\n```mermaid\nmindmap\n  root((\"OIB-Richtlinie 2\"))\n    \"Allgemeiner Teil\"\n      \"Bauteile und Feuerwiderstand\"\n      \"Feuer- und Rauchausbreitung\"\n      \"Fluchtwege und Brandbekämpfung\"\n    \"Betriebsbauten · 2.1\"\n      \"Eigene Bestimmungen für Betriebsbauten\"\n    \"Garagen · 2.2\"\n      \"Garagen und Parkdecks\"\n    \"Hohes Fluchtniveau · 2.3\"\n      \"Gebäude über 22 m Fluchtniveau\"\n```\n\nWelche Anforderungen für ein konkretes Vorhaben gelten, hängt unter anderem von Nutzung und Gebäudeart ab. Außerdem ist zu prüfen, welche Ausgabe das jeweilige Bundesland verbindlich erklärt hat und ob landesrechtliche Abweichungen bestehen; die Richtlinie verweist ausdrücklich auf landesrechtlich mögliche Abweichungen bei nachgewiesenem gleichem Schutzniveau [1].\n\n## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.4\n- [2] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.23\n- [3] [KB] oib-rl_2.1_ausgabe_mai_2023.pdf, p.4\n- [4] [KB] oib-richtlinie_2.2_ausgabe_mai_2023.pdf, p.4\n- [5] [KB] oib-rl_2.3_ausgabe_mai_2023.pdf, p.4\n",
    "cards": [
     {
      "type": "legal_basis",
      "law": "OIB-Richtlinie 2",
      "lane": "baurecht_oib",
      "edition": "Ausgabe Mai 2023",
      "article": "0",
      "summary": "Brandschutzanforderungen für Gebäude; die konkrete Verbindlichkeit richtet sich nach dem Landesrecht.",
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
      "snippet": "OIB-Richtlinie 2 — Brandschutz\n\n8 Betriebsbauten\nEs gelten die Bestimmungen der OIB-Richtlinie 2.1 „Brandschutz bei Betriebsbauten“.\n\nOIB-Richtlinie 2 — Brandschutz\n\n9 Garagen, überdachte Stellplätze und Parkdecks\nEs gelten die Bestimmungen der OIB-Richtlinie 2.2 „Brandschutz bei Garagen, überdachten Stellplätzen und Parkdecks“.\n\nOIB-Richtlinie 2 — Brandschutz\n\n10 Gebäude mit einem Fluchtniveau von mehr als 22 m\nEs gelten die Bestimmungen der OIB-Richtlinie 2.3 „Brandschutz bei Gebäuden mit einem Fluchtniveau von mehr als 22 m“.\n\nOIB-Richtlinie 2 — Brandschutz\n\n11 Sondergebäude\nFür folgende Sondergebäude ist ein Brandschutzkonzept erforderlich, das dem OIB-Leitfaden „Abweichungen im Brandschutz und Brandschutzkonzepte“ zu entsprechen hat:\na) Verkaufsstätten\n− mit einer Verkaufsfläche von mehr als 3.000 m²,\n− mit mehr als drei in offener Verbindung stehenden Geschoßen,\nb) Versammlungsstätten\n− mit Großbühne,\n− mit mehr als drei in offener Verbindung stehenden Geschoßen,\n− mit einem Fluchtniveau eines Versammlungsraumes von mehr als 22 m,\n− mit einer Netto-Grundfläche in Summe von mehr als 4.800 m²,\nc) Justizanstalten,\nd) Sonstige Sondergebäude und Bauwerke, auf die die"
     },
     {
      "number": 3,
      "document_id": "doc:oib_knowledge:oib-rl_2.1_ausgabe_mai_2023.pdf",
      "content": "[KB] oib-rl_2.1_ausgabe_mai_2023.pdf, p.4",
      "title": "OIB-Richtlinie 2.1, Ausgabe Mai 2023",
      "citation_key": "oib-rl_2.1_ausgabe_mai_2023.pdf, p.4",
      "collection": "oib_knowledge",
      "shelf": "base",
      "source_type": "knowledge_layer",
      "tool": "knowledge_search",
      "origin": "kb",
      "kind": "baurecht",
      "lane": "baurecht_oib",
      "lane_label": "OIB-Richtlinie",
      "binding_status": "verbindlich_erklaert",
      "file_name": "oib-rl_2.1_ausgabe_mai_2023.pdf",
      "page": 4,
      "punkt": "0",
      "score": 0.588470458984375,
      "snippet": "OIB-Richtlinie 2.1 — Brandschutz bei Betriebsbauten\n\n0 Vorbemerkungen\nDie zitierten Normen und sonstigen technischen Regelwerke gelten in der im Dokument „OIB-\nRichtlinien – Zitierte Normen und sonstige technische Regelwerke“ angeführten Fassung.\nWerden in dieser Richtlinie Anforderungen an die Feuerwiderstandsklasse in Verbindung mit Anforderungen an Baustoffe der Klasse A2 gestellt, gilt dies auch als erfüllt, wenn\n• die für die Tragfähigkeit wesentlichen Bestandteile der Bauteile der Klasse A2 entsprechen und\n• die sonstigen Bestandteile aus Baustoffen der Klasse B bestehen.\nEs wird darauf hingewiesen, dass parallel zu den Bestimmungen dieser Richtlinie gegebenenfalls\neinzelne Bestimmungen der OIB-Richtlinie 2 „Brandschutz“ zu berücksichtigen sind.\nBei Betriebsbauten können in Abhängigkeit des jeweiligen Gefahrenpotenzials, wie Brandbelastung, Aktivierungsgefahr und Umgebungssituation, höhere Anforderungen notwendig werden, wie\nz.B. für Chemiebetriebe.\nFür folgende Betriebsbauten sind aufgrund eines geringeren Risikos im Brandfall Erleichterungen\nvon den Anforderungen dieser Richtlinie zulässig:\n• Betriebsbauten, die lediglich der Aufstellung technischer Anlagen dienen und von"
     },
     {
      "number": 4,
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
      "score": 0.5978373289108276,
      "snippet": "OIB-Richtlinie 2.2 — Brandschutz bei Garagen, überdachten Stellplätzen und Parkdecks\n\n0 Vorbemerkungen\nDie zitierten Normen und sonstigen technischen Regelwerke gelten in der im Dokument „OIB-\nRichtlinien – Zitierte Normen und sonstige technische Regelwerke“ angeführten Fassung.\nWerden in dieser Richtlinie Anforderungen an die Feuerwiderstandsklasse in Verbindung mit Anforderungen an Baustoffe der Klasse A2 gestellt, gilt dies auch als erfüllt, wenn\n• die für die Tragfähigkeit wesentlichen Bestandteile der Bauteile der Klasse A2 und\n• die sonstigen Bestandteile aus Baustoffen der Klasse B bestehen.\nFür überdachte Stellplätze und Garagen mit jeweils höchstens 15 m² Nutzfläche, die auf eigenem\nGrund oder von Verkehrsflächen für die Brandbekämpfung zugänglich sind, werden keine Anforderungen hinsichtlich des Brandschutzes gestellt.\nBei Garagen und überdachten Stellplätzen von anerkannten Einsatzorganisationen sind Ausnahmen in Bezug auf Lagerungen (z.B. Materialien, Ausrüstungen, Treibstoffe) und untergeordneten\nNutzungen zulässig, sofern sie zur Erfüllung der gesetzlichen Aufgaben erforderlich sind und keine\nbrandschutztechnischen Bedenken bestehen.\nEs wird darauf hingewiesen, dass"
     },
     {
      "number": 5,
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
      "score": 0.6180552244186401,
      "snippet": "OIB-Richtlinie 2.3 — Brandschutz bei Gebäuden mit einem Fluchtniveau von mehr als 22 m\n\n0 Vorbemerkungen\nDie zitierten Normen und sonstigen technischen Regelwerke gelten in der im Dokument „OIB-\nRichtlinien – Zitierte Normen und sonstige technische Regelwerke“ angeführten Fassung.\nWerden in dieser Richtlinie Anforderungen an die Feuerwiderstandsklasse in Verbindung mit Anforderungen an Baustoffe der Klasse A2 gestellt, gilt dies auch als erfüllt, wenn\n• die für die Tragfähigkeit wesentlichen Bestandteile der Bauteile der Klasse A2 entsprechen und\n• die sonstigen Bestandteile aus Baustoffen der Klasse B bestehen.\nEs wird darauf hingewiesen, dass parallel zu den Bestimmungen dieser Richtlinie gegebenenfalls\neinzelne Bestimmungen der OIB-Richtlinie 2 „Brandschutz“ zu berücksichtigen sind.\nVon den Anforderungen dieser OIB-Richtlinie kann entsprechend den jeweiligen landesrechtlichen\nBestimmungen abgewichen werden, wenn vom Bauwerber nachgewiesen wird, dass das gleiche\nSchutzniveau wie bei Anwendung der Richtlinie erreicht wird. Hierbei ist der OIB-Leitfaden „Abweichungen im Brandschutz und Brandschutzkonzepte“ anzuwenden."
     }
    ],
    "answer_meta": {
     "v": 1,
     "kind": "walkthrough",
     "summary": "Für ein konkretes Vorhaben sind Nutzung und Gebäudetyp sowie die im Bundesland verbindlich erklärte Ausgabe maßgeblich.",
     "topic": "Brandschutz",
     "context": "OIB-RL 2 und ergänzende Teile, Ausgabe Mai 2023 · bundeslandabhängige Verbindlichkeit"
    }
   }
  ]
 }
} as Record<'varianten' | 'oib2', RecordedTurn>
