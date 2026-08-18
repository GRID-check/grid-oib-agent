---
name: waermeschutz
description: >
  Bei Fragen zu Energie, Wärmeschutz und Schallschutz laden: U-Wert,
  Wärmedurchgangskoeffizient, thermische Hülle, Wärmebrücke, Heizwärmebedarf,
  HWB, Energieausweis, Energieeffizienzklasse, fGEE, Kompaktheit,
  Referenzklima, sommerliche Überwärmung, Schallschutz, DnTw, LnTw,
  Trittschall, Luftschall, Anforderungen der OIB-Richtlinien 5 und 6.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: thermal_envelope,energy_performance,acoustic_check,requirement_checklist,legal_basis
---

# Energie und Schallschutz beantworten

## Der Grenzwert allein beantwortet die Frage selten

Ein U-Wert-Grenzwert ist an das Bauteil gebunden und daran, ob es an Außenluft,
an Erdreich oder an einen unbeheizten Raum grenzt. Nennen Sie das Bauteil und
seine Lage mit, sonst ist die Zahl auf das falsche Bauteil anwendbar. Dasselbe
bei Schallschutz: DnTw und LnTw gelten für ein Bauteil ZWISCHEN zwei bestimmten
Nutzungseinheiten, und die Paarung entscheidet den Wert.

Beim Heizwärmebedarf kommt dazu, dass der Wert aus einer Berechnung stammt, die
dieses Produkt nicht führt. Sie können sagen, welche Anforderung gilt und wie
ein Wert einzuordnen ist; Sie können keinen HWB ermitteln. Sagen Sie das, wenn
die Frage danach klingt.

## Welche Card wozu

- U-Werte je Bauteil der Hülle → `thermal_envelope`, eine Zeile je Bauteil.
- HWB und Energieklasse → `energy_performance`.
- Schallschutz je Bauteilpaarung → `acoustic_check`, die Paarung im Label.
- Mehrere Anforderungen nebeneinander → `requirement_checklist`.

## Bestand ist der Regelfall, nicht die Ausnahme

Ein großer Teil dieser Fragen betrifft Sanierung, und die Anforderungen an
Bestand, Zubau und größere Renovierung unterscheiden sich vom Neubau. Wenn im
Projektkontext `bestand_neubau` gesetzt ist, antworten Sie für diesen Fall. Ist
es nicht gesetzt und macht es einen Unterschied, ist das die eine Frage, die
Sie stellen — und zwar bevor Sie eine Neubauanforderung nennen, die dann
falsch ist.
