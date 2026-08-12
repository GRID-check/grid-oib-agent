"""The model handle: one IFC file, its geometry, and its spatial tree.

This is the Python counterpart of `buildGraph` + `runGeometryPass` in the
TypeScript package, and it is deliberately much smaller. The reason is the whole
point of the spike: **the graph does not have to be built.** IfcOpenShell holds
the file with every inverse attribute already resolved, so the relation edges the
TS parser materialises into a CSR index (`voids`, `fills`, `interfaceOf`,
`containsElement`, `connects`) are attribute reads here, and the geometry index
is one multi-threaded iterator pass over the same file.

## The setting that decides whether the numbers are true

``settings.set("use-world-coords", True)``. Without it,
``ifcopenshell.geom.create_shape`` returns coordinates in the element's OWN
placement frame, and every one of them looks perfectly plausible: the sample
house's north window measures 1.81 × 1.21 m either way, sits at a sill of 0.0 m
instead of 0.90 m, and the roof overhang comes out as a number that is simply
wrong. It is set once, here, and never left to a caller.

## Two trees, and why the geometry index is not one of them

- ``SpatialModel.tree`` is ``ifcopenshell.geom.tree`` — the OCCT UB-tree used
  for ray casting and volume selection. It is built from a NATIVE (BRep)
  iterator, which is both faster (0.9 s against 6.8 s for ``add_file`` on the
  sample house) and exact: ``select_ray`` reports the intersection with the real
  surface, not with a triangle that approximates it.
- ``SpatialModel.geometry(global_id)`` is a per-element triangulation, kept
  because areas, bounding boxes, facade planes and prism clipping are all
  measurements over faces, and because ``ifcopenshell.util.shape`` reads them
  straight off that triangulation.

Both are lazy and both are cached. A caller that only asks topological questions
pays for neither, which is the disclosure ladder §8.2 asks for.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from functools import cached_property
from typing import Any, Iterable, Optional

import numpy as np

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as ue
import ifcopenshell.util.shape as us
import ifcopenshell.util.unit as uu

from .envelope import ElementRef

# ── kinds ───────────────────────────────────────────────────────────────────
#
# The TS graph types every node so that an operator aimed at the wrong kind can
# say which kind it wanted. The same classification, from the IFC type alone.

_SPATIAL_KINDS = {
    "IfcProject": "project",
    "IfcSite": "site",
    "IfcBuilding": "building",
    "IfcBuildingStorey": "storey",
    "IfcSpace": "space",
    "IfcSpatialZone": "space",
}

#: Entities that occupy volume without being solid. A space is air and an opening
#: is a subtraction; neither blocks a ray and neither obstructs a light prism.
AIR_TYPES = {
    "IfcSpace",
    "IfcSpatialZone",
    "IfcOpeningElement",
    "IfcVirtualElement",
    "IfcAnnotation",
    "IfcGrid",
}


class UnknownElementError(KeyError):
    """The caller could not look — as opposed to having looked and found nothing.

    ``envelope.py`` reserves the exception for exactly this: ``decidable=False``
    means the question was well-formed and this file cannot answer it, which is a
    claim about the EXPORT. An id that is not in the model supports no claim
    about the export whatsoever; the id is wrong, or it belongs to a different
    file, or it was invented. Handing that back as an undecidable would let a
    hallucinated GlobalId be reported as "das Modell sagt dazu nichts" — the one
    failure mode this library exists to prevent.
    """

    def __init__(self, global_id: str, method: str) -> None:
        self.global_id = global_id
        self.method = method
        super().__init__(
            f'Unbekannte GlobalId "{global_id}" — dieses Modell enthält dieses Bauteil nicht ({method}).'
        )

    def __str__(self) -> str:  # KeyError repr()s its argument otherwise
        return self.args[0]


@dataclass
class ElementGeometry:
    """One element's triangulated body, in world coordinates and metres."""

    global_id: str
    #: (V, 3) vertices.
    verts: np.ndarray
    #: (F, 3) vertex indices.
    faces: np.ndarray
    #: ((minx, miny, minz), (maxx, maxy, maxz)).
    box: tuple[np.ndarray, np.ndarray]
    #: Area-weighted centroid. NOT the vertex mean: a duplicated-vertex mesh
    #: pulls that toward whichever faces were densely tessellated, which cost the
    #: TS package 33 cm on the living-room/bedroom distance before it was fixed.
    centroid: np.ndarray


    @property
    def triangles(self) -> np.ndarray:
        """(F, 3, 3) — the faces expanded into coordinates."""
        return self.verts[self.faces]


@dataclass
class Storey:
    global_id: str
    name: Optional[str]
    #: Declared ``IfcBuildingStorey.Elevation``, converted to metres.
    elevation: Optional[float]


class SpatialModel:
    """An opened IFC file plus everything the operators need to measure it."""

    def __init__(self, path: str) -> None:
        self.path = path
        t0 = time.perf_counter()
        self.file = ifcopenshell.open(path)
        self.open_seconds = time.perf_counter() - t0
        self.unit_scale = uu.calculate_unit_scale(self.file)

        self._settings = ifcopenshell.geom.settings()
        self._settings.set("use-world-coords", True)

        self._geometry: dict[str, Optional[ElementGeometry]] = {}
        # The shapes we own, kept alive on purpose: ``util.shape``'s vertex and
        # face readers hand back NumPy views over the C++ buffer, so letting the
        # shape be collected turns a later `get_footprint_area` into an
        # IndexError over recycled memory. Measured, not theorised.
        self._shapes: dict[str, Any] = {}
        self._space_contacts: dict[float, dict[str, set[str]]] = {}
        self._pass_done = False
        self.geometry_seconds = 0.0
        self.contact_seconds = 0.0
        self.tree_seconds = 0.0

    # ── identity ────────────────────────────────────────────────────────────

    def by_id(self, global_id: str, method: str) -> Any:
        """The entity, or :class:`UnknownElementError`. Never a silent ``None``."""
        try:
            return self.file.by_guid(global_id)
        except (RuntimeError, KeyError):
            raise UnknownElementError(global_id, method) from None

    def kind_of(self, element: Any) -> str:
        ifc_type = element.is_a()
        for base, kind in _SPATIAL_KINDS.items():
            if element.is_a(base):
                return kind
        if ifc_type == "IfcOpeningElement":
            return "opening"
        if element.is_a("IfcGroup"):
            return "group"
        return "element"

    def label(self, element: Any) -> Optional[str]:
        long_name = getattr(element, "LongName", None)
        return long_name or getattr(element, "Name", None)

    def ref(self, element: Any, via: Optional[str] = None) -> ElementRef:
        return ElementRef(
            global_id=element.GlobalId,
            ifc_type=element.is_a(),
            name=self.label(element),
            kind=self.kind_of(element),
            via=via,
        )

    def refs(self, elements: Iterable[Any], via: Optional[str] = None) -> list[ElementRef]:
        return [self.ref(e, via) for e in elements if getattr(e, "GlobalId", None)]

    # ── relations the file states outright ──────────────────────────────────

    def storey_of(self, element: Any) -> Optional[Any]:
        """The storey this element belongs to, through containment OR aggregation.

        Both routes are needed and the TS parser walks both: a wall is
        *contained* in a storey (``IfcRelContainedInSpatialStructure``) while an
        ``IfcSpace`` is *aggregated* into it (``IfcRelAggregates``). Reading only
        containment returns ``None`` for every room in this file — and a sill
        height measured against a missing datum is the defect ``sill_and_head``
        refuses to produce.
        """
        if element.is_a("IfcBuildingStorey"):
            return element
        seen = set()
        current = element
        while current is not None and current.id() not in seen:
            seen.add(current.id())
            container = ue.get_container(current)
            if container is not None:
                if container.is_a("IfcBuildingStorey"):
                    return container
                current = container
                continue
            aggregate = ue.get_aggregate(current)
            if aggregate is None:
                return None
            if aggregate.is_a("IfcBuildingStorey"):
                return aggregate
            current = aggregate
        return None

    @cached_property
    def storeys(self) -> list[Storey]:
        out: list[Storey] = []
        for s in self.file.by_type("IfcBuildingStorey"):
            elevation = s.Elevation
            out.append(
                Storey(
                    global_id=s.GlobalId,
                    name=s.Name,
                    # Elevations are in the file's own length unit — 2500.0 in a
                    # millimetre model. Everything else in this package is
                    # metres, so the datum is converted once, here.
                    elevation=None if elevation is None else float(elevation) * self.unit_scale,
                )
            )
        return out

    def storey_datum(self, element: Any) -> Optional[Storey]:
        storey = self.storey_of(element)
        if storey is None:
            return None
        for s in self.storeys:
            if s.global_id == storey.GlobalId and s.elevation is not None:
                return s
        return None

    @cached_property
    def true_north(self) -> Optional[float]:
        """Angle from model +Y to true north, radians, or ``None``.

        ``None`` is the honest answer and is what makes :func:`azimuth` refuse:
        the model's +Y axis is north only if somebody said so.
        """
        for ctx in self.file.by_type("IfcGeometricRepresentationContext"):
            if ctx.is_a("IfcGeometricRepresentationSubContext"):
                continue
            direction = ctx.TrueNorth
            if direction is None:
                continue
            ratios = list(direction.DirectionRatios)
            if len(ratios) >= 2:
                return float(np.arctan2(ratios[0], ratios[1]))
        return None

    @cached_property
    def georeferenced(self) -> bool:
        site = self.file.by_type("IfcSite")
        if any(s.RefLatitude and s.RefLongitude for s in site):
            return True
        return bool(self.file.by_type("IfcMapConversion"))

    # ── geometry ────────────────────────────────────────────────────────────

    def geometry(self, global_id: str) -> Optional[ElementGeometry]:
        """This element's triangulated body, or ``None`` when it never had one.

        A miss is emphatically not an error. Half the nodes in a real IFC never
        had a body (``IfcWindowLiningProperties``, curtain-wall shells whose
        panels carry the geometry instead), and a wall that lost its body in
        export is a finding worth reporting in the same words.
        """
        if global_id in self._geometry:
            return self._geometry[global_id]
        element = self.file.by_guid(global_id)
        geo = self._shape_of(element)
        self._geometry[global_id] = geo
        return geo

    def _shape_of(self, element: Any) -> Optional[ElementGeometry]:
        if not getattr(element, "Representation", None) and not element.is_a("IfcSpace"):
            return None
        try:
            shape = ifcopenshell.geom.create_shape(self._settings, element)
        except Exception:
            return None
        self._shapes[element.GlobalId] = shape
        return self._from_shape(element.GlobalId, shape.geometry)

    @staticmethod
    def _from_shape(global_id: str, geometry: Any) -> Optional[ElementGeometry]:
        # Copied, not viewed: ``get_vertices`` returns a view over the shape's
        # own buffer, and the iterator recycles that buffer on the next step.
        verts = np.array(us.get_vertices(geometry), dtype=float)
        faces = np.array(us.get_faces(geometry), dtype=np.int64)
        if len(verts) == 0 or len(faces) == 0:
            return None
        tris = verts[faces]
        # Area-weighted centroid: cross-product areas of every triangle, each
        # triangle's own centroid weighted by it.
        cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
        areas = np.linalg.norm(cross, axis=1) / 2.0
        total = float(areas.sum())
        if total > 0:
            centroid = (tris.mean(axis=1) * areas[:, None]).sum(axis=0) / total
        else:
            centroid = verts.mean(axis=0)
        return ElementGeometry(
            global_id=global_id,
            verts=verts,
            faces=faces,
            box=(verts.min(axis=0), verts.max(axis=0)),
            centroid=centroid,
        )

    def triangulation(self, global_id: str) -> Optional[Any]:
        """The live IfcOpenShell triangulation, for ``util.shape``'s own readers.

        ``get_footprint_area`` / ``get_area`` / ``get_volume`` take the
        triangulation object rather than arrays, so this hands back a shape this
        object owns and holds a reference to. Cached: shaping the sample house's
        living room costs ~3 ms and gets asked for repeatedly.
        """
        shape = self._shapes.get(global_id)
        if shape is None:
            element = self.file.by_guid(global_id)
            try:
                shape = ifcopenshell.geom.create_shape(self._settings, element)
            except Exception:
                return None
            self._shapes[global_id] = shape
        return shape.geometry

    def geometry_pass(self) -> dict[str, ElementGeometry]:
        """Shape every product in one multi-threaded iterator pass.

        The TS package's `runGeometryPass` equivalent, and the only place a
        model-wide number (the plan centre, the model diagonal) can come from.
        """
        if self._pass_done:
            return {k: v for k, v in self._geometry.items() if v is not None}
        t0 = time.perf_counter()
        iterator = ifcopenshell.geom.iterator(self._settings, self.file, 8)
        if iterator.initialize():
            while True:
                shape = iterator.get()
                geo = self._from_shape(shape.guid, shape.geometry)
                self._geometry.setdefault(shape.guid, geo)
                if not iterator.next():
                    break
        self.geometry_seconds = time.perf_counter() - t0
        self._pass_done = True
        return {k: v for k, v in self._geometry.items() if v is not None}

    @cached_property
    def bounds(self) -> Optional[tuple[np.ndarray, np.ndarray]]:
        index = self.geometry_pass()
        if not index:
            return None
        lows = np.array([g.box[0] for g in index.values()])
        highs = np.array([g.box[1] for g in index.values()])
        return lows.min(axis=0), highs.max(axis=0)

    @cached_property
    def plan_centre(self) -> Optional[np.ndarray]:
        """The middle of the model in plan — which side of a facade is "out".

        A plane has two normals and the winding of an exported mesh does not
        reliably say which one faces the weather. Outward is therefore decided
        geometrically: of the two normals, the one pointing AWAY from this point.
        Right for every facade of a convex-ish building, wrong for the inner face
        of a courtyard wing — which is stated in a caveat, never hidden.
        """
        if self.bounds is None:
            return None
        low, high = self.bounds
        return np.array([(low[0] + high[0]) / 2.0, (low[1] + high[1]) / 2.0, (low[2] + high[2]) / 2.0])

    @cached_property
    def diagonal(self) -> float:
        if self.bounds is None:
            return 100.0
        low, high = self.bounds
        return float(np.linalg.norm(high - low))

    def space_contacts(self, contact: float = 0.05) -> dict[str, set[str]]:
        """For every IfcSpace, the elements whose solids touch it. Computed once.

        This is the model-wide primitive behind :func:`bounds`, :func:`opens_to`,
        :func:`enclosed_by` and :func:`adjacent_spaces`, and it exists in this
        shape for a measured reason. ``geom.tree.select(element, extend=d)``
        performs a real OCCT offset of the subject solid, and the cost is a
        property of the SUBJECT, not of the tolerance: offsetting one window of
        this file (a frame with mullions) takes **2.9 s** at any extend, while
        offsetting one space (a prism) takes **0.55 s**. Asking the question from
        the window's side would cost 2.9 s per window; asking it from the space's
        side costs 0.55 s per room, once, and answers it for every window in that
        room at dictionary speed.

        ``extend=0`` is not an option: without an offset the query is a strict
        intersection test and two solids that merely touch — a window in its
        reveal, a wall against a room — do not register. Measured: the window
        returns nothing at all at ``extend=0``.
        """
        key = round(contact, 6)
        cached = self._space_contacts.get(key)
        if cached is not None:
            return cached
        t0 = time.perf_counter()
        contacts: dict[str, set[str]] = {}
        for space in self.file.by_type("IfcSpace"):
            try:
                touching = self.tree.select(space, extend=contact)
            except Exception:
                touching = []
            contacts[space.GlobalId] = {
                e.GlobalId for e in touching if e.GlobalId != space.GlobalId
            }
        self.contact_seconds = time.perf_counter() - t0
        self._space_contacts[key] = contacts
        return contacts

    @cached_property
    def tree(self) -> Any:
        """The OCCT spatial tree — ``select``, ``select_box``, ``select_ray``.

        Built from a NATIVE (BRep) iterator rather than ``tree.add_file``: same
        results, 0.9 s instead of 6.8 s on the sample house, because it skips the
        triangulation the tree does not need.
        """
        import ifcopenshell.ifcopenshell_wrapper as wrapper

        t0 = time.perf_counter()
        settings = ifcopenshell.geom.settings()
        settings.set("use-world-coords", True)
        settings.set("iterator-output", wrapper.NATIVE)
        tree = ifcopenshell.geom.tree()
        iterator = ifcopenshell.geom.iterator(settings, self.file, 8)
        if iterator.initialize():
            tree.add_iterator(iterator)
        self.tree_seconds = time.perf_counter() - t0
        return tree

    # ── quantities the file declares ────────────────────────────────────────

    def declared_quantity(self, element: Any, names: Iterable[str]) -> Optional[tuple[str, float]]:
        """The first declared quantity matching ``names``, with the path it came from.

        Deliberately not restricted to ``Qto_SpaceBaseQuantities``: this file
        publishes its room areas in a Revit-flavoured pset called
        ``BaseQuantities``, and a triangulation that only looked at the canonical
        name would report "die Datei deklariert keine Fläche" about a file that
        declares it 15.41678125 m². The pset the value was found in travels back
        with it so the reader can see which dialect this export speaks.
        """
        psets: dict[str, dict[str, Any]] = {}
        psets.update(ue.get_psets(element, qtos_only=False) or {})
        for pset_name, values in psets.items():
            for key in names:
                if key in values and isinstance(values[key], (int, float)):
                    return f"{pset_name}.{key}", float(values[key])
        return None


__all__ = [
    "AIR_TYPES",
    "ElementGeometry",
    "SpatialModel",
    "Storey",
    "UnknownElementError",
]
