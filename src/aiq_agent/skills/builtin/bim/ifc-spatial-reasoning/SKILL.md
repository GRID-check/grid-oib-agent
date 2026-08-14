---
name: ifc-spatial-reasoning
description: >
  Vor dem ersten ifc_measure- oder ifc_query-Aufruf laden: welches Werkzeug
  zuständig ist, wie eine Frage über viele Bauteile in EINEN Aufruf passt, und
  woran man merkt, dass eine Zahl etwas anderes misst als das Gefragte. Auslöser
  sind die Formulierungen selbst — „wie hoch ist", „wie groß ist", „wie breit",
  „wie viele", „reicht", „ist … ausreichend", „passt", „erfüllt", „laut Modell",
  „im IFC", „stimmt das so im Plan" — und ihre Gegenstände: Raumhöhe,
  Raumfläche, Brüstung, lichte Durchgangsbreite, Abstand, Dachüberstand,
  Himmelsrichtung, Lichteinfall, Lichteintrittsfläche, Fluchtweg,
  Brandabschnitt, thermische Hülle, Raumbuch, Geschoßhöhen, was an was grenzt
  und was über was liegt. Auch wenn das Maß nur der Zwischenschritt zu einer
  OIB-Beurteilung ist: gemessen wird hier, geurteilt aus der Bestimmung. Und
  erst recht in der Mehrzahl — „die Räume", „der Keller", „alle Fenster", „jedes
  Geschoß" —, weil ein einzeln gemessener Raum über die übrigen nichts aussagt.
  Nicht für reine Rechtsfragen ohne Modellbezug.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: ifc_viewer,ifc_element,ifc_schedule
---

# Am Modell messen, nicht am Plan raten

Die Werkzeugbeschreibungen sagen, **was** `ifc_query` und `ifc_measure` können,
und sie sagen es ausführlich — jeden Operator, jeden Kennwert, jede Relation.
Hier steht nur, was dort nicht steht: **wie viele Züge zur Verfügung stehen**,
**wie eine Frage über viele Bauteile in einen davon passt**, und **woran man
merkt, dass eine Zahl etwas anderes misst als das, wonach gefragt wurde**. Der
Fehler, den dieses Paket beseitigen soll, war nie eine falsche Formel — es war
eine richtig gemessene Zahl unter einem falschen Namen.

## 1. Das Budget: gezählt wird beim Abschicken

Nach einer festen Zahl von Werkzeugaufrufen bricht dieser Agent den Werkzeugteil
ab und formuliert die Antwort aus dem, was bis dahin dasteht. Gezählt wird, wenn
der Aufruf **abgeschickt** wird, nicht wenn er etwas liefert:

- Ein Aufruf mit null Treffern kostet so viel wie einer, der antwortet. Nichts
  wird zurückerstattet, auch ein abgelehnter Aufruf nicht.
- **Mehrere Aufrufe in EINEM Zug kosten jeder einen.** Drei parallele Aufrufe
  sind drei verbrauchte Züge, nicht einer — wer parallel arbeitet, hat deutlich
  weniger Runden, als die Zahl vermuten lässt.
- Diesen Skill zu laden war einer davon.

Eine Antwort, die vor der Messung abgeschnitten wird, fällt auf die deklarierten
Werte der Datei zurück — auf genau die Zahlen, wegen deren Unzuverlässigkeit
überhaupt gemessen wird. So kam eine echte Auskunft dazu, die Geschoßhöhe von
3,00 m für Räume zu nennen, die 2,70 m messen.

Reicht es nicht bis zur Messung, dann **steht das in der Antwort**: welche
Messung fehlt und woher die Zahl stattdessen kommt. Eine deklarierte Zahl
kommentarlos an die Stelle der gemessenen zu setzen, ist die teuerste Art, das
Budget zu überziehen — von außen ist sie von einer Messung nicht zu
unterscheiden.

Deshalb weicht die Reihenfolge hier von der Werkzeugbeschreibung ab, die
„briefing zuerst" sagt: das gilt, wo Züge billig sind. Steht die Auswahl auch
ohne Briefing — ein Typ, ein Namensteil, ein ganzes Gebäude —, dann wird
gemessen. `briefing` ist der Zug, der einen ins Leere gelaufenen Aufruf rettet,
wenn ein Geschoß- oder Merkmalsname nicht traf. Als Reparatur, nicht als
Vorbereitung: kostenlos ist es an Rechenzeit, nicht am Budget.

## 2. Eine Frage in der Mehrzahl ist eine Frage über viele Bauteile

„Wie hoch ist der Keller" nennt einen Raum und meint siebzehn. `survey` misst
EINEN Kennwert an ALLEN Bauteilen einer Auswahl — ausgewählt wie bei
`find_elements` über `storey`, `ifc_type`, `name_contains`, `kind` — und liefert
je Bauteil Name, Geschoß und eigene Antwort, dazu die Spanne über alles.

Am Modell AC20-Institute-Var-2 bringt ein einziger Aufruf mit
`operation: "survey"`, `measure: "clearHeight"`, `ifc_type: "IfcSpace"` und
`storey: "Keller"` siebzehn Räume: sechzehn mit 2,700 m und „Flur Keller Treppe"
mit 0,250 m, Spanne 2,450 m. Wer stattdessen einen Raum misst und
verallgemeinert, berichtet 2,70 m — richtig gemessen, und der Raum, um den es
geht, kommt in der Antwort nicht vor.

**Die Spanne ist der Befund**, kein Zusatz dazu. In die Antwort gehören: wie
viele Bauteile gemessen wurden und von wie vielen, Minimum, Maximum und jeder
Ausreißer beim Namen. „Alle 17 Kellerräume 2,70 m" und „16 davon 2,70 m, einer
0,25 m" sind verschiedene Antworten auf dieselbe Frage, und aus einem einzeln
gemessenen Raum folgt keine von beiden. Was `decidable: false` liefert, wird
einzeln genannt und nie als „wie die übrigen" mitgezählt.

Steht die Menge schon fest — die Türen aus einem Fluchtweg, die Fenster einer
Fassade —, nimmt `operation: "measure"` in `global_id` die ganze Id-Liste auf
einmal, jedes Bauteil mit eigener Antwort und eigener Toleranz.

Und ist umgekehrt ein einzelnes Bauteil interessant geworden — der Ausreißer,
den ein `survey` benannt hat —, dann nimmt `operation: "element_profile"` in
EINEM Zug alle Maße, die für dieses Bauteil überhaupt gelten, statt sie einzeln
zu erraten. Welche gelten, folgt aus dem IFC-Typ; die teuren (Fluchtweg,
Erreichbarkeit, Wendekreis, Türanlauf) kommen nur mit `kind: "expensive"` dazu.

Nichts davon ersetzt die Einzelmessung: ein Bauteil mit bekanntem Maß misst
`measure`, eine bloße Liste ohne Maß liefert `find_elements`. Und eine reine
Flächenaufstellung über alle Räume steht ohne jede Geometrie im Index — dafür
`ifc_query` mit `operation: "schedule"`.

## 3. Welches der beiden Werkzeuge

`ifc_query` liest, was die Datei **deklariert**: schnell, über das ganze Modell,
und leer, wo der Export nichts geschrieben hat. `ifc_measure` misst an der
**Geometrie** — auch dort, wo nichts deklariert ist, und immer mit Toleranz.

| Die Frage lautet | Werkzeug |
|---|---|
| Wie viele, welche, welcher Wert steht in der Datei | `ifc_query`: `types`, `elements`, `aggregate`, `properties` |
| Raumbuch, Flächenaufstellung, Mengen nach Material | `ifc_query`: `schedule`, `takeoff` |
| Wie vollständig ist das Modell, was hat sich geändert | `ifc_query`: `health`, `compare`, `compliance-diff` |
| Ein Maß an EINEM Bauteil oder an einer bekannten Id-Liste | `ifc_measure`: `measure` |
| Dasselbe Maß über ein Geschoß, eine Raumgruppe, einen Typ | `ifc_measure`: `survey` |
| Alle Maße, die für EIN Bauteil überhaupt gelten | `ifc_measure`: `element_profile` |
| Ein Maß, das aus ZWEI Bauteilen entsteht | `ifc_measure`: `distance`, `clearance`, `overhang` |
| Was grenzt woran, was sitzt worin, was liegt darüber | `ifc_measure`: `relations` |
| Eine ganze OIB-2- oder OIB-6-Fragestellung auf einmal | `ifc_measure`: `fire`, `envelope`, je mit `kind` |

Welchen Kennwert `measure` und `survey` kennen und was er bedeutet, steht
vollständig in der Werkzeugbeschreibung. Sie hier zu wiederholen hieße, Platz
für Urteil gegen Platz für Katalog zu tauschen.

**Mehrere Modelle im Projekt:** `model_name` mit einem Stück des Dateinamens
setzen. Ohne das antwortet das Werkzeug mit der Liste der Modelle — diese
Antwort weitergeben, nicht ein Modell erraten.

## 4. Der Reihenfolge nach, wie ein Mensch einen Plan liest

Gebäude → Geschoß → Raum → Bauteil. Jeder Schritt liefert die GlobalId für den
nächsten; eine erfundene GlobalId wird namentlich abgelehnt.

Das Verfahren ist für **jede** OIB-Richtlinie dasselbe, und nur die Maße
wechseln:

1. **Welche Bestimmung** — aus der Wissensbasis, nicht aus dem Modell. Sie nennt
   das verlangte Maß und den Grenzwert.
2. **Welche Bauteile** — über `find_elements` oder gleich über die Auswahl eines
   `survey`, nie geraten.
3. **Das Maß nehmen.**
4. **Berichten**: Zahl, Toleranz, Herkunft, beteiligte Bauteile, bei mehreren die
   Spanne. Die Bewertung gegen den Grenzwert ist ein eigener, ausgesprochener
   Schritt.

Drei Ketten als Beispiel dieses Verfahrens — nicht als Verfahren. Für eine
Richtlinie, die hier nicht steht, gilt 1 bis 4 genauso, und jede Kette wird
kürzer, sobald ein Schritt über eine Menge statt über ein Bauteil geht.

**„Reicht die Raumhöhe?" (OIB 3)** — ein `survey` mit `measure: "clearHeight"`
über die Räume des Geschosses. Ein Zug, alle Räume, Spanne inklusive. Die
Mindesthöhe kommt aus der Bestimmung, nicht aus dem Modell.

**„Passt dieses Fenster mit dem Dach für den Lichteinfall?" (OIB 3)** — die
längste Kette hier, und sie beginnt nicht am Modell: `find_elements` mit
`ifc_type: "IfcWindow"` → `relations` mit `relation: "hostedIn"` für die Wand →
`overhang` mit dem Dach als `global_id` und dieser Wand als `other_global_id` →
`light_incidence` auf dem Fenster, mit `angle_deg` und `swivel_deg` aus der
**Bestimmung** (für OIB 3: 45 und 30) — die also vorher aus der Wissensbasis
geholt sein muss und selbst einen Zug kostet. Für Fläche und Prozentsatz liefert
`lightEntryArea` beides in einem Maß statt in zweien. Das ist die Kette, bei der
das Budget zuerst knapp wird; wenn eine Auswahl daneben greift, gehört das
Fehlende nach Abschnitt 1 in die Antwort, statt am Ende geraten zu werden.

**„Wie lang ist der Fluchtweg, und wie breit sind die Türen darin?" (OIB 2)** —
`measure: "egressPath"` am Raum nennt Räume, Türen und Länge in einem Zug; die
Türen daraus gehen als Id-Liste in einen einzigen `measure: "clearWidth"`. Bevor
eine Aussage über *alle* Wege fällt, sagt `fire` mit `kind: "doorGraph"`, wie
tragfähig die Grundlage überhaupt ist. Und zur
Länge gehört zwingend der Hinweis, dass sie ein Streckenzug über Mittelpunkte
und damit eine **Untergrenze** ist, keine Fluchtweglänge im Sinne der OIB 2 —
ohne diesen Satz sieht ein zu langer Weg unauffällig aus.

Nicht drei Operatoren ausprobieren, um zu sehen, welcher etwas liefert: die vier
geometrischen Relationen (`bounds`, `enclosedBy`, `opensTo`, `adjacentSpaces`)
bauen beim ersten Aufruf einen Kontaktplan über mehrere Sekunden, danach kostet
er nichts mehr. Erst die Frage klären, dann gezielt eine davon aufrufen.

## 5. Fallstricke

Jeder Punkt hier hat schon einmal eine falsche Zahl in eine Antwort gebracht.
Die ersten beiden sind dieselbe Falle in zwei Gestalten: die Zahl ist richtig,
der Name darüber ist falsch, und der Fehler zeigt in die Richtung, in der zu
wenig als genug durchgeht.

**`clearWidth` liefert die Rohbaulichte, nicht die fertige Durchgangsbreite.**
Gemessen wird die lichte Öffnung im Rohbau, auf die Öffnungsebene projiziert.
Die lichte Durchgangsbreite einer Tür wird zwischen den fertigen Zargenfalzen
gemessen und ist 15–25 % kleiner — die Richtung, in der eine zu schmale
Fluchttür breit genug aussieht. Der `caveat` des Operators gehört in die
Antwort, und die Zahl wird dort nie „lichte Durchgangsbreite" genannt; welches
der beiden Maße gefordert ist, entscheidet die Bestimmung. Ohne Öffnung mit
Geometrie ist der gemessene Bauteilkörper zudem eine **Obergrenze** und als
Nachweis einer Mindestbreite unbrauchbar, und bei nicht rechteckiger Öffnung ist
die gemeldete Breite das größte, nicht das durchgehend lichte Maß.

**Die Geschoßhöhe liegt rund 30 cm über der lichten Raumhöhe** — der Abstand
zwischen Nichterfüllen und Erfüllen. `storey_heights` und die Höhen im Briefing
sind Rohbaumaße von Oberkante zu Oberkante; ein Raumhöhennachweis kennt nur
`clearHeight`.

**`clearHeight` misst bis zum tiefsten Hindernis, nicht bis zur Raumdecke.**
Gemessen wird mit einem 5×5-Raster senkrecht nach oben, Möblierung ausgenommen,
alles andere zählt. Ein schmaler Unterzug zwischen zwei Rasterpunkten kann
verfehlt werden; für einen Nachweis gehört das in die Antwort. Liegt kein
Rasterpunkt im Raumkörper, kommt `decidable: false`, und ein feineres Raster
lässt sich nicht anfordern — dann `extent` nehmen und die Zahl ausdrücklich als
Höhe des modellierten Raumkörpers benennen, nie als lichte Höhe.

**`sillAndHead` misst an der Rohbauöffnung**, über der Geschoßebene und nicht
über dem Projektnull. Ein Fußbodenaufbau verringert die tatsächliche
Brüstungshöhe um seine Dicke — bei der 1,00-m-Grenze der Absturzsicherung
entscheidet das.

**Flächeneinheit und Längeneinheit sind unabhängig.** Eine Datei kann in
Millimetern messen und Flächen in Quadratmetern deklarieren. Meldet `floorArea`
einen WIDERSPRUCH zwischen deklarierter und gemessener Fläche, dann beide Zahlen
berichten und keine auswählen. Und 0 m² an einer Wand ist ein Messergebnis,
keine fehlende Angabe.

**`azimuth` kann um 180° gedreht sein.** „Außen" ist die Normale, die von der
Grundrissmitte wegzeigt; an einem Innenhof oder in einem einspringenden
Baukörper ist das die falsche Seite.

### Leere Ergebnisse sind Aussagen über den Export

Keines davon ist eine Aussage über das Gebäude, und hinter jedem wartet ein
„…also gibt es das nicht", das falsch wäre.

- **„0 Treffer"** — vor einem „gibt es nicht" die Typschreibweise und den
  Geschoßnamen prüfen. `ifc_type` ist ein exakter Klassenvergleich **ohne**
  IFC-Vererbung: eine Suche nach IfcWall findet keine IfcWallStandardCase.
  `storey` wird wörtlich verglichen; „EG" statt „00 Erdgeschoss" trifft nichts.
  Beide Schreibweisen nennt `briefing`.
- **`hostedIn` leer für einen ganzen Export** — manche Exporte schreiben die
  Rohbauöffnung nicht mit, die Wand trägt den Ausschnitt im Körper. Das heißt
  nicht, dass das Fenster in keiner Wand sitzt; die Bezugswand dann über
  `relation: "bounds"` am Raum oder über `find_elements` holen.
- **`contains` an einem Raum leer** — viele Exporte ordnen Bauteile dem Geschoß
  statt dem Raum zu.
- **Die Relationsliste von `element` unvollständig** — die vier geometrischen
  Relationen stehen dort nie, weil sie zu prüfen Sekunden kostet. Ihr Fehlen ist
  kein Befund; über `relations` sind sie normal abrufbar.
- **`adjacentSpaces` heißt nicht „begehbar"** — zwei Räume mit gemeinsamer Wand
  ohne Tür sind Nachbarn. Für die Verbindung `opensTo` an der Tür.
- **Aufgelistet ist nicht gefunden** — `find_elements` zeigt höchstens `limit`
  Treffer und nennt die Gesamtzahl daneben; in die Antwort gehört die
  Gesamtzahl. `survey` misst höchstens 50 Bauteile und sagt daneben, wie viele
  es insgesamt waren.
- **`decidable: false` ist ein Befund, kein Fehler** — die Frage war sinnvoll,
  diese Datei kann sie nicht beantworten. `missing` nennt, was fehlt und was es
  behebt; die Abhilfe ist die Arbeitsanweisung an die Architektin und oft der
  nützlichste Teil. Eine Antwort dagegen, die mit „Error:" beginnt, trägt gar
  keine Aussage und wird korrigiert statt berichtet.

### Hinsehen

Gezeichnet wird immer **ein Grundriss**; Schnitt und Ansicht gibt es **nicht**.
Ein Überstand wird gemessen (`overhang`), nicht gezeichnet — also keinen Schnitt
anbieten und keinen ankündigen. Und aus keinem Bild wird je ein Maß abgelesen:
das ist geraten, auch wenn es zufällig stimmt. Ein Blick auf den Plan kostet
einen vollen Zug; er lohnt sich, wenn unklar ist, welches Bauteil gemeint ist,
und nicht als Illustration einer schon feststehenden Zahl.

## 6. Wie die Zahl in die Antwort kommt

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

## 7. Geometrie ist kein Urteil

Die Werkzeuge liefern Maße. Ob ein Maß eine Anforderung erfüllt, entscheidet die
**Bestimmung** aus der Wissensbasis. Winkel und Prozentsätze sind Parameter, die
aus der Klausel gebunden werden — deshalb verweigert `light_incidence` ohne
`angle_deg` die Auskunft, statt 45 anzunehmen: den Winkel zu liefern hieße, die
Klausel anzuwenden.

Konkret für den Lichteinfall: ein geschnittenes 45-Grad-Prisma vergrößert die
erforderliche Lichteintrittsfläche, es verbietet das Fenster nicht. Wer aus
„Prisma geschnitten" ein „nicht erfüllt" macht, hat die Bestimmung nicht
angewandt, sondern übersprungen. Dasselbe gilt für jede Zahl aus diesem Paket:
keine Gebäudeklasse, kein „erfüllt", kein Grenzwert, der nicht aus einer Klausel
zitiert ist.

Eine gute Antwort auf eine Maßfrage nennt die Zahl mit Einheit und Toleranz,
ihre Herkunft, die beteiligten Bauteile, bei mehreren die Spanne — und was offen
bleibt, mit dem, was es beheben würde.

## 8. Gemessenes sichtbar machen

Jede Antwort endet mit einer `Bezug:`-Zeile — genau die GlobalIds, aus denen die
Zahl gebildet wurde. Das ist die Vorlage für die Karte: eine `ifc_viewer`-Karte
mit **diesen** Ids unter `global_ids` zeigt der Architektin das gemessene
Bauteil im Modell, statt es zu beschreiben. Ein `survey` wird so zur markierten
Raumgruppe mit dem Ausreißer darin.

Zwei Regeln dazu:

- Ids **nie erfinden** und nie aus dem Gedächtnis ergänzen — nur die aus
  `Bezug:` oder aus einer Werkzeugantwort. Eine falsche Id markiert das falsche
  Bauteil und sieht dabei genauso richtig aus wie eine echte.
- `status` folgt der **Bestimmung**, nicht der Messung. Solange kein Grenzwert
  angewandt wurde, ist er `info`. Ein rotes `fail` an einem Bauteil ist ein
  Befund, und ein Befund braucht eine Klausel dahinter.
