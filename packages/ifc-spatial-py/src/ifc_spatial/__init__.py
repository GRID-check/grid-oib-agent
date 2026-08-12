"""``ifc-spatial`` on IfcOpenShell — the engine-swap spike.

The TypeScript package at ``packages/ifc-spatial`` is the reference
implementation and stays that way until the parity table says otherwise. This
package answers one question: can IfcOpenShell serve the ENTIRE operator surface
without changing a single sentence the architect reads?

What must survive the port is not the geometry — it is
:mod:`ifc_spatial.envelope`: ``declared`` / ``computed`` / ``inferred`` /
``undecidable``, a tolerance and a method on every measurement, a German
``missing.what`` and ``remedy`` on every refusal, and an exception — never an
undecidable — for a GlobalId this file does not contain.
"""

from .envelope import (
    Answer,
    ElementRef,
    MissingFact,
    Provenance,
    computed,
    declared,
    inferred,
    triangulate,
    undecidable,
)
from .model import ElementGeometry, SpatialModel, Storey, UnknownElementError

__all__ = [
    "Answer",
    "ElementGeometry",
    "ElementRef",
    "MissingFact",
    "Provenance",
    "SpatialModel",
    "Storey",
    "UnknownElementError",
    "computed",
    "declared",
    "inferred",
    "triangulate",
    "undecidable",
]
