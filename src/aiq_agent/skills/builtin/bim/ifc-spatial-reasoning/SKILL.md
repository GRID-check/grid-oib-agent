---
name: ifc-spatial-reasoning
description: >
  Wie eine räumliche Frage am IFC-Modell beantwortet wird: erst das Briefing,
  dann messen, und jede Zahl mit ihrer Herkunft berichten. Auslöser: Fragen nach
  Abständen, lichten Maßen, Raumflächen, Brüstungs- und Sturzhöhen,
  Dachüberständen, Himmelsrichtungen, freiem Lichteinfall, welcher Raum an
  welchen grenzt, in welcher Wand ein Fenster sitzt, oder ob ein Bauteil ein
  anderes verdeckt. Auch dann, wenn die Frage aus einer OIB-Anforderung kommt
  und das Maß dafür nur ein Zwischenschritt ist.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: ifc_viewer,ifc_element,ifc_schedule
---

# Räumlich messen statt schätzen

Das Modell kann jetzt gemessen werden — Abstände, Flächen, Höhen, Überstände,
Winkel. Damit verschiebt sich der Fehler: früher war das Risiko, eine Frage
unbeantwortet zu lassen, jetzt ist es, eine gemessene Zahl wie eine deklarierte
zu berichten. Diese Anleitung handelt fast nur davon.

## 1. Immer zuerst das Briefing

`ifc_measure` mit `operation: "briefing"`, bevor irgendetwas gefiltert oder
gemessen wird. Es nennt

- die **Geschoßnamen dieser Datei** — wörtlich übernehmen, ein erfundener Name
  trifft nichts und liest sich wie „gibt es nicht";
- den **Dialekt**: welche Property-Sets dieser Export tatsächlich befüllt;
- die **blinden Flecken**: was diese Datei nicht hergibt.

Was unter `FEHLT` steht, ist nirgends in der Datei befüllt. Eine Abfrage darauf
liefert leer — das ist eine Aussage über den Export, nicht über das Gebäude.

## 2. Drei Herkünfte, drei verschiedene Sätze

Jede Antwort trägt `provenance`. Die drei sind im Deutschen **nicht
austauschbar**, und das ist der Kern dieser Anleitung:

| provenance | so formulieren | Beispiel |
|---|---|---|
| `declared` | „Das Modell **deklariert** …" | Pset_WallCommon.ThermalTransmittance = 0,236 |
| `computed` | „**Gemessen** … (± Toleranz)" | Dachüberstand 0,65 m ± 5 mm |
| `inferred` | „**Vermutlich** …, bitte bestätigen" | Raum „Wohnen" ist wohl ein Aufenthaltsraum |

Eine Messung als Modellangabe auszugeben ist der schwerste Fehler, den dieses
Werkzeug ermöglicht. Wo `caveat` gesetzt ist, gehört er in die Antwort — er sagt
meist, **wie** gemessen wurde und was dabei danebengehen kann.

Bei `inferred` immer die Begründung (`because`) mitgeben und als Vorschlag
formulieren. Ob ein Raum ein Aufenthaltsraum ist, ist eine **rechtliche**
Einstufung, keine geometrische.

## 3. `decidable: false` ist ein Befund, kein Fehler

Heißt: die Frage ist sinnvoll, und **diese Datei** kann sie nicht beantworten.
`missing.what` nennt das Fehlende, `missing.remedy` was es behebt. Beides
berichten — das ist die Arbeitsanweisung an die Architektin, und oft der
nützlichste Teil der Antwort.

Nicht verwechseln mit einem leeren Ergebnis: „keine Treffer" heißt, es wurde
gesucht und nichts gefunden.

## 4. Zahlen kommen aus dem Werkzeug

Nie nachrechnen, nie anders runden, nie hochrechnen, nie aus einer Zeichnung
ablesen. Wer eine Zahl braucht, ruft `measure` oder `distance` auf. Ein aus
einem Bild abgelesenes Maß ist geraten, auch wenn es zufällig stimmt.

Widersprechen sich ein deklarierter und ein gemessener Wert, ist **das** der
Befund: Bauteilliste und Geometrie sagen Verschiedenes. Beide Zahlen nennen,
nicht eine davon auswählen.

## 5. Geometrie kostet Zeit — nicht auf Verdacht messen

`briefing`, `find_elements`, `element`, `storey_heights` antworten sofort.
Alles, was Raumbegrenzungen braucht — `relations` mit `opensTo`, `adjacentSpaces`
oder `bounds` — kostet beim ersten Mal mehrere Sekunden, danach nichts mehr.
`draw`, `overhang` und `light_incidence` brauchen jeweils rund fünf Sekunden.

Also: erst die Frage klären, dann gezielt messen. Nicht drei Operatoren
ausprobieren, um zu sehen, welcher etwas liefert.

## 6. Der Reihe nach, wie ein Mensch einen Plan liest

Gebäude → Geschoß → Raum → Bauteil. Für „passt dieses Fenster mit dem Dach":

1. `find_elements` (`ifc_type: "IfcWindow"`) → die GlobalId des Fensters
2. `relations` + `relation: "hostedIn"` → in welcher Wand es sitzt
3. `relations` + `relation: "opensTo"` → welchen Raum es belichtet
4. `measure` + `measure: "floorArea"` → dessen Bodenfläche
5. `measure` + `measure: "sillAndHead"` → Brüstung und Sturz
6. `overhang` — `global_id` = das auskragende Bauteil (das Dach aus
   `find_elements` mit `ifc_type: "IfcRoof"`), `other_global_id` = die Wand aus
   Schritt 2, deren Außenfläche die Bezugsebene ist
7. `light_incidence` — `global_id` = das Fenster, `angle_deg` und `swivel_deg`
   aus der **Bestimmung** (für OIB 3: 45 und 30). Ohne Winkel verweigert das
   Werkzeug, und das ist Absicht: es kennt kein Regelwerk und soll keines kennen.

Jeder Schritt liefert die Eingabe des nächsten. Nicht mit dem Prisma anfangen.

Ein Sonderfall, der sonst jedes Fenster als verbaut meldet: die **eigene Wand**
wird beim Prisma nicht automatisch ausgenommen, denn ein tief in einer dicken
Wand sitzendes Fenster wird tatsächlich von seiner eigenen Leibung verschattet.
Kommt die Wand aus Schritt 2 als einziges Hindernis zurück, den Aufruf mit
`other_global_id` = diese Wand wiederholen — und in der Antwort sagen, dass und
warum sie ausgenommen wurde.

## 7. Geometrie ist kein Urteil

Die Werkzeuge liefern Maße. Ob ein Maß eine Anforderung erfüllt, entscheidet die
**Bestimmung**, und die kommt aus der Wissensbasis, nicht aus dem Modell.
Winkel und Prozentsätze sind Parameter, die aus der Klausel gebunden werden —
das Modell kennt sie nicht.

Konkret für den Lichteinfall: ein geschnittenes 45°-Prisma **vergrößert die
erforderliche Lichteintrittsfläche**, es verbietet das Fenster nicht. Wer aus
„Prisma geschnitten" ein „nicht erfüllt" macht, hat die Bestimmung nicht
angewandt, sondern übersprungen.

## 8. Zeichnen, wenn Hinsehen hilft

`operation: "draw"` liefert **einen Grundriss** als SVG — Wandschnitt, Raumzellen
mit Namen, Öffnungen als Lücken. `storey` schränkt auf ein Geschoß ein (Name
wörtlich aus dem Briefing), `ifc_type` auf einen Bauteiltyp.

Schnitt und Ansicht gibt es **nicht**. Ein Überstand wird gemessen
(`operation: "overhang"`), nicht gezeichnet — also keinen Schnitt anbieten und
keinen ankündigen.

Die Zeichnung ist eine Darstellung, keine Quelle. Maße stehen daneben, nie
darin.

## 9. Am Ende: was geprüft wurde, was nicht

Eine gute Antwort auf eine Maßfrage nennt

- die Zahl mit Einheit und Toleranz,
- woher sie kommt (deklariert / gemessen / vermutet),
- welche Bauteile beteiligt waren,
- und was offen bleibt — mit dem, was es beheben würde.

Ein Modell, das eine Frage nicht hergibt, ist ein Befund über den Export. Eine
Zahl ohne Herkunft ist keine Antwort, sondern eine Behauptung.
