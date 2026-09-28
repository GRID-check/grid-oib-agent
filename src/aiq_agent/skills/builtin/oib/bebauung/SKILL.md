---
name: bebauung
description: >
  Was aufs Grundstück darf: Bauklasse und Gebäudehöhe, Bauwich, Widmung, GFZ,
  Stellplätze. Land und Gemeinde, nicht OIB.
metadata:
  grid-agents: researcher,deep_researcher
  grid-cards: setback_plan,building_section,calculation
---

# Eine Frage zum Grundstück beantworten

## Das steht nicht in den OIB-Richtlinien

Abstände, Höhen, Dichte, Widmung und Stellplätze sind Landes- und Gemeinderecht:
Bauordnung, Bebauungsplan, Flächenwidmungsplan, Stellplatzregulativ. Die
OIB-Richtlinien regeln sie nicht.

Zwei Folgen. Erstens hängt die Antwort immer am Bundesland. Steht es im
Projektkontext, darunter antworten und es nennen. Fehlt es, das ist die Frage.
Es gibt hier keine österreichweite Zahl. Zweitens weißt du nicht, was der
Bebauungsplan *dieses* Grundstücks festsetzt. Du kannst sagen, welche Regel
greift und was sie üblicherweise festlegt. Du kannst nicht sagen, was hier
festgelegt wurde. Sag, wo nachzusehen ist, statt eine plausible Zahl zu
erfinden.

Hol die Bestimmung über RIS. Eine erinnerte Wiener Formel auf ein anderes Land
gelegt ist falsch und sieht richtig aus.

## Die Normenkette gehört in die Antwort

Wo eine Frage Landesrecht und eine OIB-Richtlinie zugleich berührt, sag,
welche Ebene welchen Teil trägt. Was bindet und was nur auslegt, *ist* in
diesem Genre die Information.

## Welches Bild

Grundstück, Fußabdruck, Abstände je Seite → `setback_plan`.
Bebauungsgrad, GFZ, Flächen gegen die Grenze → `setback_plan` mit `coverage`
und `density`; die Karte rechnet die Quote aus den Flächen.
Eine Höhenprüfung über die Geschoße, Fluchtniveau → `building_section`.
Stellplätze gefordert gegen vorhanden → als `:::kennzahlen`, mit der
Bemessungsgrundlage in der Prosa: ohne sie ist die Zahl nicht prüfbar. Eine
errechnete Stellplatzzahl → `calculation`.

## Done

Land und Instrument sind genannt. Jede Zahl hat eine Fundstelle oder steht
ausdrücklich als unbekannt, weil der Plan dieses Grundstücks fehlt.
