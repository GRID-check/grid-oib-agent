---
name: ifc-spatial-reasoning
description: >
  Vor dem ersten Aufruf von ifc_measure oder ifc_query laden: welches der beiden
  Werkzeuge für diese Frage zuständig ist, in welcher Reihenfolge gemessen wird,
  und woran man erkennt, dass eine Zahl etwas anderes misst als das, wonach
  gefragt wurde. Auslöser: lichte Raumhöhe, Raumfläche, Brüstungs- und
  Sturzhöhe, lichte Breite, Abstand zwischen zwei Bauteilen, Dachüberstand,
  Himmelsrichtung einer Fassade, freier Lichteinfall und 45-Grad-Prisma, welcher
  Raum an welchen grenzt, in welcher Wand ein Fenster sitzt, welche Bauteile
  einen Raum begrenzen, Geschoßhöhen, Raumbuch, Bauteillisten und Zählungen,
  Vergleich zweier Modellstände — und jedes „laut Modell", „im IFC", „stimmt das
  so im Plan". Auch dann, wenn die Frage aus einer OIB-Anforderung kommt und das
  Maß nur der Zwischenschritt zur Beurteilung ist. Nicht für reine Rechtsfragen
  ohne Modellbezug.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: ifc_viewer,ifc_element,ifc_schedule
---

# Am Modell messen, nicht am Plan raten

Die Werkzeugbeschreibungen sagen, **was** `ifc_query` und `ifc_measure` können.
Hier steht, **wann welches**, **in welcher Reihenfolge**, und **woran man merkt,
dass eine Zahl etwas anderes misst als das, wonach gefragt wurde**. Der Fehler,
den dieses Paket beseitigen soll, war nie eine falsche Formel — es war eine
richtig gemessene Zahl unter einem falschen Namen.

## 1. Welches der beiden Werkzeuge

| Frage | Werkzeug |
|---|---|
| Wie viele, welche, welcher Wert steht in der Datei | `ifc_query`: `types`, `elements`, `aggregate`, `properties` |
| Raumbuch, Flächenaufstellung über alle Räume | `ifc_query`: `schedule` |
| Mengen, Massen nach Material | `ifc_query`: `takeoff` |
| Wie vollständig ist dieses Modell | `ifc_query`: `health` |
| Orientierende Regelprüfung über deklarierte Werte | `ifc_query`: `compliance` |
| Was hat sich seit dem letzten Stand geändert | `ifc_query`: `compare`, `compliance-diff` |
| Ein Maß, das die Datei nicht deklariert | `ifc_measure`: `measure`, `distance`, `overhang` |
| Eine deklarierte Zahl unabhängig gegenprüfen | `ifc_measure`: `measure` |
| Was grenzt woran, was sitzt worin | `ifc_measure`: `relations` |
| Freier Lichteinfall | `ifc_measure`: `light_incidence` |

Faustregel: **eine** Fläche prüfen → `ifc_measure` mit `measure: "floorArea"`.
**Alle** Flächen auflisten → `ifc_query` mit `operation: "schedule"`. Wer dreißig
Räume einzeln misst, zahlt dreißigmal Geometrie für etwas, das der Index in
einem Aufruf hat.

## 2. Zuerst das Briefing, einmal pro Modell

`operation: "briefing"` — kostenlos, keine Geometrie. Drei Dinge daraus lassen
sich nicht raten und müssen wörtlich übernommen werden:

- **GESCHOSSE** — die Geschoßnamen dieser Datei. `storey` wird exakt gegen den
  Geschoßnamen verglichen (Groß-/Kleinschreibung egal, sonst wörtlich). „EG"
  statt „00 Erdgeschoss" trifft nichts.
- **BAUTEILE** — die Typschreibweise dieser Datei. `ifc_type` ist ein exakter
  Klassenvergleich, **kein** Vergleich über die IFC-Vererbung: eine Suche nach
  IfcWall findet keine IfcWallStandardCase. Diese Liste sagt, welche Schreibweise
  dieser Export benutzt.
- **DIALEKT / FEHLT / BLIND** — welche Merkmale befüllt sind, welche nirgends,
  und was diese Datei grundsätzlich nicht hergibt. Was unter `FEHLT` steht,
  liefert leer; das ist eine Aussage über den Export, nicht über das Gebäude.

Das Gegenstück auf der Metadatenseite ist `ifc_query` mit
`operation: "overview"` (Geschoßnamen, Gesamtzahlen) und
`operation: "properties"` (das Merkmalsvokabular).

## 3. Der Reihenfolge nach, wie ein Mensch einen Plan liest

Gebäude → Geschoß → Raum → Bauteil. Jeder Schritt liefert die GlobalId für den
nächsten; eine erfundene GlobalId wird namentlich abgelehnt.

„Passt dieses Fenster mit dem Dach für den Lichteinfall?"

1. `operation: "find_elements"` mit `ifc_type: "IfcWindow"` → GlobalId des Fensters
2. `operation: "relations"` mit `relation: "hostedIn"` → die Wand, in der es sitzt
3. `operation: "relations"` mit `relation: "opensTo"` → der belichtete Raum
4. `operation: "measure"` mit `measure: "floorArea"` → dessen Bodenfläche
5. `operation: "measure"` mit `measure: "sillAndHead"` → Brüstung und Sturz
6. `operation: "overhang"` — `global_id` ist das Dach (aus `find_elements` mit
   `ifc_type: "IfcRoof"`), `other_global_id` die Wand aus Schritt 2, deren
   Außenfläche die Bezugsebene ist
7. `operation: "light_incidence"` — `global_id` ist das Fenster, `angle_deg` und
   `swivel_deg` kommen aus der **Bestimmung** (für OIB 3: 45 und 30)

„Ist die Raumhöhe im Wohnzimmer ausreichend?"

1. `operation: "briefing"` → der Geschoßname, wörtlich
2. `operation: "find_elements"` mit `kind: "space"` und `name_contains: "Wohn"`
3. `operation: "measure"` mit `measure: "clearHeight"`
4. Die Mindesthöhe kommt aus der Bestimmung, nicht aus dem Modell.

Nicht mit dem Prisma anfangen und nicht drei Operatoren ausprobieren, um zu
sehen, welcher etwas liefert: die vier geometrischen Relationen (`bounds`,
`enclosedBy`, `opensTo`, `adjacentSpaces`) bauen beim ersten Aufruf einen
Kontaktplan über mehrere Sekunden, danach kostet er nichts mehr. Erst die Frage
klären, dann gezielt eine davon aufrufen.

## 4. Fallstricke

Jeder Punkt hier hat schon einmal eine falsche Zahl in eine Antwort gebracht.

**Die eigene Wand blockiert das eigene Fenster.** `light_incidence` nimmt die
Hostwand **nicht** automatisch aus, weil ein tief in einer dicken Wand sitzendes
Fenster tatsächlich von seiner eigenen Leibung verschattet wird. Kommt die Wand
aus Schritt 2 als einziges Hindernis zurück: Aufruf wiederholen mit
`other_global_id` = diese Wand, und in der Antwort sagen, dass und warum sie
ausgenommen wurde. `other_global_id` nimmt hier **genau ein** Bauteil aus.

**Geschoßhöhe ist nicht lichte Raumhöhe.** `storey_heights` und die Höhen im
Briefing sind Rohbaumaße von Oberkante zu Oberkante, ohne Deckenaufbau. Für
einen Raumhöhennachweis nur `measure` mit `clearHeight`. Der Unterschied liegt
in der Größenordnung von 30 cm — in der Richtung, die aus einem Nichterfüllen
ein Erfüllen macht.

**`clearHeight` misst bis zum tiefsten Hindernis, nicht bis zur Raumdecke.**
Gemessen wird mit einem 5×5-Raster senkrecht nach oben, Möblierung ausgenommen,
alles andere zählt (abgehängte Decke, Unterzug, Lüftungsleitung). Ein schmaler
Unterzug zwischen zwei Rasterpunkten kann verfehlt werden — der Hinweis sagt es,
und für einen Nachweis gehört das in die Antwort. Liegt kein Rasterpunkt im
Raumkörper (schmaler oder zerklüfteter Raum), kommt `decidable: false`; ein
feineres Raster lässt sich über dieses Werkzeug **nicht** anfordern. Dann
`measure: "extent"` nehmen und die Zahl ausdrücklich als Höhe des modellierten
Raumkörpers benennen, nie als lichte Höhe.

**`distance` misst keine lichte Breite.** `centroid`, `horizontal` und
`vertical` sind Schwerpunktabstände (flächengewichtet über das Netz, bei grober
Vernetzung um Zentimeter wandernd). `min` ist der Spalt zwischen den
**achsparallelen Hüllboxen**; 0 m heißt nur, dass sich die Boxen überschneiden,
nicht dass sich die Körper berühren, und bei schrägen Bauteilen ist der wahre
Abstand größer als der gemeldete. Für eine lichte Durchgangsbreite
`measure: "extent"` am Bauteil selbst.

**`extent` ist eine Hüllbox, achsparallel zum Modell.** Bei einem schräg
stehenden Bauteil sind `width` und `depth` systematisch zu groß und sind nicht
Länge und Dicke des Bauteils. Der Hinweis sagt es, wenn es zutrifft.

**Flächeneinheit und Längeneinheit sind unabhängig.** Eine Datei kann in
Millimetern messen und Flächen in Quadratmetern deklarieren. `floorArea` sucht
die deklarierte Fläche über alle Dialekte, rechnet sie um und meldet einen
WIDERSPRUCH, wenn sie von der gemessenen abweicht: dann beide Zahlen berichten,
keine auswählen. Und 0 m² an einer Wand ist ein Messergebnis (kein horizontales
Flächenstück), keine fehlende Angabe.

**`sillAndHead` misst an der Rohbauöffnung**, über der Geschoßebene und nicht
über dem Projektnull. Ein Fußbodenaufbau verringert die tatsächliche
Brüstungshöhe um seine Dicke — bei der 1,00-m-Grenze der Absturzsicherung
entscheidet das. Ohne Geschoßzuordnung, oder wenn die deklarierten Geschoßhöhen
neben der Geometrie liegen (Vermessungsnull statt Projektnull), kommt
`decidable: false` statt einer Zahl.

**`azimuth` kann um 180° gedreht sein.** „Außen" ist die Normale, die von der
Grundrissmitte wegzeigt; an einem Innenhof oder in einem einspringenden
Baukörper ist das die falsche Seite. Ohne TrueNorth in der Datei kommt
`decidable: false` — dann keine Himmelsrichtung nennen, auch keine plausible.

**`hostedIn` kann für einen ganzen Export leer sein.** Manche Exporte schreiben
die Rohbauöffnung nicht mit, die Wand trägt den Ausschnitt bereits im Körper.
Der Hinweis sagt das ausdrücklich; es heißt **nicht**, dass das Fenster in
keiner Wand sitzt. Die Bezugswand für `overhang` dann anders holen: über
`relation: "bounds"` am Raum oder über `find_elements`.

**Die Relationsliste von `element` ist unvollständig, mit Absicht.** Die vier
geometrischen Relationen stehen nie unter „Vorhandene Relationen", weil sie zu
prüfen Sekunden kostet. Ihr Fehlen dort ist kein Befund — über `relations` sind
sie normal abrufbar.

**`adjacentSpaces` heißt nicht „begehbar".** Zwei Räume mit gemeinsamer Wand
ohne Tür sind Nachbarn. Für die Verbindung `opensTo` an der Tür.

**`contains` an einem Raum ist oft leer**, weil viele Exporte Bauteile dem
Geschoß statt dem Raum zuordnen. Auch das ist ein Befund über den Export.

**Aufgelistet ist nicht gefunden.** `find_elements` zeigt höchstens `limit`
Treffer (Vorgabe 50, Höchstwert 500) und nennt die Gesamtzahl daneben. In eine
Antwort gehört die Gesamtzahl — oder besser gleich `ifc_query` mit
`operation: "aggregate"`.

**„0 Treffer" ist keine Aussage über das Gebäude.** Das Werkzeug sagt es selbst
und verweist aufs Briefing. Vor einem „gibt es nicht" die Typschreibweise und
den Geschoßnamen prüfen.

**`decidable: false` ist ein Befund, kein Fehler.** Die Frage war sinnvoll,
diese Datei kann sie nicht beantworten. `missing.what` und `missing.remedy`
gehören beide in die Antwort — die Abhilfe ist die Arbeitsanweisung an die
Architektin und oft der nützlichste Teil. Davon zu unterscheiden ist eine
Antwort, die mit „Error:" beginnt: die trägt gar keine Aussage, weder über das
Gebäude noch über den Export, und wird korrigiert statt berichtet.

**`draw` und `view` sind nicht dasselbe, und die Verwechslung kostet einen
Zug.** `draw` schreibt eine SVG-Datei **für den Nutzer** und liefert einen Pfad
zurück — davon ist nichts zu sehen. `view` rendert dasselbe Geschoß als **Bild,
das tatsächlich betrachtet werden kann**: zum Klären, welches Bauteil gemeint
ist, oder zur Plausibilitätsprüfung einer gemessenen Anordnung. Also `view`,
wenn man selbst hinsehen will; `draw` nur, wenn die Datei verlangt wurde.

Bei `view` nimmt `global_id` eine oder mehrere GlobalIds (durch Komma getrennt),
`mode: "highlight"` markiert sie rot im ganzen Grundriss („wo ist das"),
`mode: "only"` blendet alles andere aus („wie sieht das aus"). Geschnitten wird
auf 1,20 m — auf dieser Höhe erscheinen Tür- und Fensteröffnungen als Lücken.

Gezeichnet wird in beiden Fällen **ein Grundriss**; Schnitt und Ansicht gibt es
**nicht**. Ein Überstand wird gemessen (`operation: "overhang"`), nicht
gezeichnet — also keinen Schnitt anbieten und keinen ankündigen. Und aus keinem
Bild wird je ein Maß abgelesen: das ist geraten, auch wenn es zufällig stimmt.

**Mehrere Modelle im Projekt:** `model_name` mit einem Stück des Dateinamens
setzen. Ohne das antwortet das Werkzeug mit der Liste der Modelle — diese
Antwort weitergeben, nicht ein Modell erraten.

## 5. Wie die Zahl in die Antwort kommt

Die gerenderte Zeile trägt bereits das richtige Verb. Sie zu zitieren ist
sicherer, als den Satz neu zu bauen:

- `declared` → „Das Modell **deklariert** …" — die Angabe der Datei.
- `computed` → „**Gemessen** … (± Toleranz)" — unsere Zahl. Die Toleranz gehört
  dazu; ohne sie ist es eine andere Behauptung.
- `inferred` → „**Vermutlich** …" mit der Begründung aus `because`, als
  Vorschlag zur Bestätigung. `room_inventory` ist immer das: ob ein Raum ein
  Aufenthaltsraum ist, ist eine rechtliche Einstufung, keine geometrische.

Ein `caveat` sagt meist, **wie** gemessen wurde und was dabei danebengehen kann.
Er gehört in die Antwort, nicht in eine Fußnote.

## 6. Geometrie ist kein Urteil

Die Werkzeuge liefern Maße. Ob ein Maß eine Anforderung erfüllt, entscheidet die
**Bestimmung** aus der Wissensbasis. Winkel und Prozentsätze sind Parameter, die
aus der Klausel gebunden werden — deshalb verweigert `light_incidence` ohne
`angle_deg` die Auskunft, statt 45 anzunehmen: den Winkel zu liefern hieße, die
Klausel anzuwenden.

Konkret für den Lichteinfall: ein geschnittenes 45-Grad-Prisma vergrößert die
erforderliche Lichteintrittsfläche, es verbietet das Fenster nicht. Wer aus
„Prisma geschnitten" ein „nicht erfüllt" macht, hat die Bestimmung nicht
angewandt, sondern übersprungen.

Eine gute Antwort auf eine Maßfrage nennt die Zahl mit Einheit und Toleranz,
ihre Herkunft, die beteiligten Bauteile — und was offen bleibt, mit dem, was es
beheben würde.
