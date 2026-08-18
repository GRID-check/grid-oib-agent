---
name: bebauung
description: >
  Bei Fragen zu Bebauung und Städtebau laden: Abstand, Bauwich,
  Abstandsfläche, Grundgrenze, Fluchtlinie, Baulinie, Baufluchtlinie,
  Bebauungsplan, Flächenwidmung, Widmung, Bebauungsgrad, Bebauungsdichte,
  Geschoßflächenzahl, GFZ, Grundflächenzahl, Bruttogeschoßfläche,
  Gebäudehöhe, Traufenhöhe, Stellplatzverpflichtung, Stellplatzregulativ.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: setback_plan,density_check,building_section,parking_requirement,legal_basis
---

# Bebauung beantworten

## Das steht nicht in der OIB-Richtlinie

Das ist die wichtigste Eigenschaft dieses Genres und der häufigste Fehlgriff.
Abstände, Höhen, Dichte, Widmung und Stellplätze sind **Landes- und
Gemeinderecht**: Bauordnung des Landes, Bebauungsplan, Flächenwidmungsplan,
Stellplatzregulativ. Die OIB-Richtlinien regeln sie nicht.

Zwei Konsequenzen. Erstens: Die Antwort hängt am Bundesland, immer. Ist es im
Projektkontext gesetzt, antworten Sie dafür und sagen es dazu. Ist es nicht
gesetzt, ist das die Frage, die Sie stellen — eine allgemein-österreichische
Antwort gibt es hier nicht. Zweitens: Was im Bebauungsplan des konkreten
Grundstücks steht, kennen Sie nicht. Sie können sagen, welche Regel greift und
was sie üblicherweise bestimmt; Sie können nicht sagen, was für dieses
Grundstück festgesetzt ist. Sagen Sie, wo es nachzusehen ist, statt eine
plausible Zahl zu nennen.

## Welche Card wozu

- Grundstück, Baukörper und Abstände je Seite → `setback_plan`.
- Bebauungsgrad, GFZ, Flächen gegen Grenzwerte → `density_check`.
- Höhenprüfung über die Geschoße, Fluchtniveau → `building_section`.
- Stellplätze erforderlich gegen vorhanden → `parking_requirement`, mit der
  Bemessungsgrundlage im `basis`-Feld: ohne sie ist die Zahl nicht prüfbar.

## Die Normenkette gehört in die Antwort

Wo eine Frage sowohl Landesrecht als auch eine OIB-Richtlinie berührt, sagen
Sie, welche Ebene welchen Teil regelt. Der Leser muss unterscheiden können, was
bindend ist und was auslegt — in diesem Genre ist genau das die Information.
