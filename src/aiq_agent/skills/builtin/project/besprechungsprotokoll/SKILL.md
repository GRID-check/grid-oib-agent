---
name: besprechungsprotokoll
description: >
  Besprechungsprotokoll aus den Notizen einer Besprechung (Jour fixe, Baubesprechung, Planungsbesprechung): Kopf, TOPs, Beschlüsse und offene Punkte mit Wer und bis wann, jede Zeile mit ihrer Notizstelle, nichts erfunden.
metadata:
  grid-catalog: curated
  grid-agents: researcher
  grid-title: Besprechungsprotokoll
---

# Das Protokoll gibt die Notizen wieder

Ein Protokoll hält fest, was besprochen wurde. Es prüft nichts und urteilt
nicht. Was nicht in den Notizen steht, steht nicht im Protokoll.

## 1. Die Notizen lesen

Die Notizen sind die Dateien und der Text, die der Auftrag nennt. Jede Datei mit
`read_passage` öffnen und ganz lesen. Fehlen die Notizen oder sind sie nicht
lesbar: kein Protokoll entwerfen, sondern sagen, welche fehlen.

Das vorige Protokoll dieses Projekts mit `knowledge_search` suchen. Was dort
offen war und in den Notizen nicht erledigt ist, kommt unter „Aus der
Vorbesprechung übernommen“, jede Zeile mit Zitat auf das alte Protokoll. Gibt es
keines, entfällt der Abschnitt.

## 2. Aufbau

- **Kopf:** Projekt, Datum, Ort, Teilnehmende
- **TOPs:** je Punkt knapp, was besprochen wurde
- **Beschlüsse:** Tabelle `Beschluss | Quelle`
- **Offene Punkte:** Tabelle `Was | Wer | bis wann | Quelle`
- **Aus der Vorbesprechung übernommen:** dieselbe Tabelle
- **Unklar in den Notizen:** was fehlt oder sich widerspricht

## 3. Jede Zeile hat ihre Notizstelle

Jeder Beschluss und jeder offene Punkt nennt in „Quelle“ die Stelle, aus der er
stammt: `[N]` auf die gelesene Passage, bei eingefügtem Text ein kurzes
wörtliches Zitat „…“. Keine Stelle, keine Zeile.

Nichts ergänzen: keine Teilnehmenden, kein Datum, keinen Ort, keine
Zuständigen, keine Fristen, die die Notizen nicht nennen. Die Lücke ist „—“ und
steht zusätzlich unter „Unklar in den Notizen“. „Nächste Woche“ bleibt „nächste
Woche“ und wird kein Datum.

Eine Bemerkung zu einer Norm (OIB, Bauordnung) nur mit Zitat aus dem Korpus;
ohne Zitat weglassen.

## Done

Jede Zeile unter Beschlüsse und Offene Punkte hat eine Quelle. Jede Lücke steht
unter „Unklar in den Notizen“. Nichts steht im Protokoll, was nicht in den
Notizen oder im vorigen Protokoll steht.
