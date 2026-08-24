---
name: waermeschutz
description: >
  U-Wert, HWB und Schall. Zuerst ob Neubau oder Bestand.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: thermal_envelope,energy_performance,acoustic_check,requirement_checklist,legal_basis
---

# Eine Frage zu Energie oder Schall beantworten

## Die Grenze allein beantwortet die Frage selten

Ein U-Wert hängt am Bauteil und daran, woran das Bauteil grenzt: Außenluft,
Erdreich oder ein unbeheizter Raum. Bauteil und Lage neben die Zahl, sonst
wird die Zahl am falschen Bauteil angewandt. Schallschutz ebenso: DnTw und
LnTw gelten für ein Bauteil *zwischen* zwei bestimmten Nutzungseinheiten, und
die Paarung entscheidet den Wert.

Heizwärmebedarf kommt aus einer Rechnung, die dieses Produkt nicht ausführt.
Du kannst sagen, welche Anforderung gilt und wie ein gegebener Wert dazu
steht. Du kannst keinen HWB bestimmen. Das sagen, wenn die Frage so klingt,
als würde sie einen verlangen.

## Bestand ist der Normalfall

Ein großer Teil dieser Fragen betrifft Sanierung. Bestand, Zubau und größere
Renovierung holen andere Anforderungen als Neubau. Steht `bestand_neubau` im
Projektkontext, darunter antworten. Fehlt es und macht es einen Unterschied,
das ist die eine Frage, und sie kommt, bevor eine Neubau-Anforderung zitiert
wird, die sich dann als die falsche erweist.

## Welches Bild

U-Werte je Bauteil der Hülle → `thermal_envelope`, eine Zeile je Bauteil.
HWB und Energieklasse → `energy_performance`.
Schallschutz je Bauteilpaarung → `acoustic_check`, die Paarung im Label.
Mehrere Anforderungen nebeneinander → `requirement_checklist`.

## Done

Jedes Limit nennt Bauteil und Lage, oder die Paarung. Ein HWB, den niemand
gerechnet hat, kommt nicht vor. Neubau ist nur zitiert, wenn das Vorhaben
eines ist.
