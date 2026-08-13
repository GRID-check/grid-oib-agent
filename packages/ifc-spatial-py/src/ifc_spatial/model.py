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

import os
import time
from collections.abc import Iterable
from dataclasses import dataclass
from functools import cached_property
from typing import Any

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as ue
import ifcopenshell.util.shape as us
import ifcopenshell.util.unit as uu
import numpy as np

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


#: Above this, :class:`SpatialModel` refuses the file instead of reading it.
#:
#: A coarse backstop, and knowingly so: size is a poor predictor of cost. The
#: corpus has a 22 MB Revit export that costs 208 s and **3.2 GB** and a 49 MB
#: ArchiCAD export with the same number of products that costs 17 s and 941 MB —
#: Revit's swept solids with boolean subtractions are expensive to build and
#: ArchiCAD's are not. Bytes are simply the only quantity knowable before the
#: parser has run, so they are what the admission test can use.
#:
#: The line is drawn between the two files the corpus measured on either side of
#: it: the 49 MB ArchiCAD export completes in 32 s and under 1 GB, and the
#: 151 MB Revit export needs **5.3 GB and 5.8 minutes** before it can answer a
#: single question. Both are legitimate files; only one of them belongs anywhere
#: near a request. Raise ``max_bytes`` explicitly in a worker that can afford it.
MAX_FILE_BYTES = 64 * 1024 * 1024

#: Seconds :meth:`SpatialModel.space_contacts` may spend before it gives up and
#: reports the model-wide contact map as incomplete. One ``tree.select`` offset
#: per space costs 0.5–2 s, so a 99-space office model spent **212 s** here
#: before this bound existed — inside one call to ``opens_to`` on one window.
CONTACT_BUDGET_SECONDS = 30.0

#: Above this many ``IfcProduct`` entities, deriving space boundaries from the
#: solids is refused outright rather than started.
#:
#: The time budget above can only be checked BETWEEN offsets, because one
#: ``tree.select(space, extend=…)`` is a single OCCT call with no interruption
#: point — not even ``SIGALRM`` reaches it, since a Python signal handler runs
#: only when the interpreter regains control. So the budget bounds the loop and
#: nothing bounds one offset. Measured: on the 1 090-product office export an
#: offset costs ~2.1 s, and on the 3 729-product Trapelo export a **single**
#: offset ran for over 200 s without returning. The threshold sits at the low
#: end of that unmeasured gap, deliberately: the cost of being wrong here is a
#: refusal that names its reason, and the cost of being wrong the other way is a
#: request that never comes back.
DERIVED_BOUNDARY_MAX_PRODUCTS = 2000


class ModelUnreadableError(RuntimeError):
    """This file cannot be opened, and a reason a person can act on.

    Every failure mode of ``ifcopenshell.open`` reaches a caller as a different
    exception type — ``OSError`` for an empty file, ``FileNotFoundError`` for a
    missing one, ``ifcopenshell.Error`` for a header it cannot parse,
    ``SchemaError`` for a schema it does not implement — and a **segmentation
    fault** for a file truncated mid-entity, which no ``except`` clause can
    catch. A consumer that has to enumerate four exception types and still gets
    killed by the fifth cannot state a reason, and stating a reason is this
    library's entire job.

    So the constructor pre-flights the bytes and raises exactly this, with a
    German ``reason``, for everything it can see coming. It is a refusal about
    the FILE, which is why it is not an ``Answer``: an undecidable answer claims
    "the model was read and cannot say", and here there is no model.
    """

    def __init__(self, path: str, reason: str) -> None:
        self.path = path
        self.reason = reason
        super().__init__(f"{path}: {reason}")


class ModelTooLargeError(ModelUnreadableError):
    """The file is real and too big to read here — a stated limit, not a hang."""

    def __init__(self, path: str, size: int, limit: int) -> None:
        self.size = size
        self.limit = limit
        super().__init__(
            path,
            f"Diese Datei ist {size / 1e6:.1f} MB groß; hier werden höchstens "
            f"{limit / 1e6:.0f} MB gelesen. Der Geometriedurchlauf braucht ein Vielfaches der "
            "Dateigröße an Arbeitsspeicher — eine 22-MB-Datei belegt rund 1,5 GB. Ein Modell "
            "dieser Größe gehört in einen Worker-Prozess mit eigenem Speicherbudget, nicht in "
            "eine Anfrage. Das ist eine Absage, kein Fehler: die Datei ist in Ordnung.",
        )


def _preflight(path: str, max_bytes: int) -> None:
    """Everything about the bytes that can be checked before the parser sees them.

    The truncation check is the one that matters. ``ifcopenshell.open`` **crashes
    the process** on a file cut mid-entity — measured on this corpus: a Duplex
    export truncated to 100 000 and to 300 000 bytes both segfault, while the
    same file cut at a line boundary parses fine. A crash cannot be caught, cannot
    be reported and takes the request with it, so the only defence is to refuse
    before handing the bytes over. A complete SPF file ends with
    ``END-ISO-10303-21;``; a truncated download essentially never does.

    This is a guard, not a validator. A file can still be malformed in ways only
    the parser discovers, which is why the design doc's "extraction becomes a
    worker" (§11) remains the real answer and this is the cheap half of it.
    """
    if not isinstance(path, (str, os.PathLike)):
        raise ModelUnreadableError(str(path), "Kein Dateipfad übergeben.")
    path = os.fspath(path)
    if not os.path.exists(path):
        raise ModelUnreadableError(path, "Diese Datei existiert nicht.")
    if os.path.isdir(path):
        raise ModelUnreadableError(path, "Das ist ein Verzeichnis, keine IFC-Datei.")
    size = os.path.getsize(path)
    if size == 0:
        raise ModelUnreadableError(path, "Diese Datei ist leer (0 Bytes) — der Upload ist fehlgeschlagen.")
    if size > max_bytes:
        raise ModelTooLargeError(path, size, max_bytes)

    try:
        with open(path, "rb") as handle:
            head = handle.read(64)
            handle.seek(max(0, size - 4096))
            tail = handle.read(4096)
    except OSError as error:
        raise ModelUnreadableError(path, f"Diese Datei ist nicht lesbar ({error}).") from None

    if not head.lstrip()[:12].upper().startswith(b"ISO-10303-21"):
        raise ModelUnreadableError(
            path,
            "Das ist keine IFC-SPF-Datei — sie beginnt nicht mit ISO-10303-21. Eine .ifcXML- oder "
            ".ifcZIP-Datei muss vorher konvertiert bzw. entpackt werden.",
        )
    if b"END-ISO-10303-21" not in tail:
        raise ModelUnreadableError(
            path,
            "Diese Datei ist unvollständig: der Abschluss END-ISO-10303-21; fehlt. Sie wurde "
            "abgeschnitten — der Upload oder der Export ist abgebrochen. Eine abgeschnittene IFC-Datei "
            "bringt den Parser zum Absturz und wird deshalb gar nicht erst geöffnet; die Datei bitte "
            "vollständig neu hochladen.",
        )


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
        super().__init__(f'Unbekannte GlobalId "{global_id}" — dieses Modell enthält dieses Bauteil nicht ({method}).')

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
    name: str | None
    #: Declared ``IfcBuildingStorey.Elevation``, converted to metres.
    elevation: float | None


@dataclass(frozen=True)
class DeclaredQuantity:
    """A quantity the file states, in SI, with the arithmetic that got it there.

    ``raw`` and ``unit_label`` are kept beside ``value`` on purpose: an architect
    reading a disagreement needs to see the number the way their own software
    prints it (``68.10 SQUARE FOOT``) as well as the number this library
    compares against (``6.327 m²``). Reporting only the converted value would
    make a correct conversion indistinguishable from a wrong one.
    """

    path: str
    #: In SI — m for a length, m² for an area, m³ for a volume.
    value: float
    #: Exactly as written in the file.
    raw: float
    #: ``value == raw * scale``.
    scale: float
    #: The declared unit's own name, when the file names one.
    unit_label: str | None


def _unit_scale_to_si(unit: Any) -> float:
    """The factor from an ``IfcNamedUnit`` to its SI base — the same walk
    ``ifcopenshell.util.unit.calculate_unit_scale`` does for a whole project,
    applied to one unit that may override it.

    ``convert_unit`` cannot serve here: it matches on unit NAMES, and the name of
    a conversion-based unit (``'SQUARE FOOT'``) is not in its SI table. The
    conversion factor is on the entity, so it is read off the entity.
    """
    scale = 1.0
    guard = 0
    while unit is not None and unit.is_a("IfcConversionBasedUnit") and guard < 8:
        guard += 1
        factor = unit.ConversionFactor
        try:
            scale *= float(factor.ValueComponent.wrappedValue)
        except Exception:
            return scale
        unit = factor.UnitComponent
    if unit is not None and unit.is_a("IfcSIUnit"):
        # An SI prefix on an AREA or VOLUME unit is raised to the dimension of
        # that unit. `CENTI` on `SQUARE_METRE` is 1e-4, not 1e-2 — a centimetre
        # is a hundredth of a metre, so a square centimetre is a ten-thousandth
        # of a square metre. Applied linearly it made a correct declared area
        # come out 100x wrong, which `triangulate` then published as a 99 %
        # „WIDERSPRUCH zwischen zwei Wegen zu dieser Zahl" — a fabricated
        # finding against a file that was right.
        dimension = _UNIT_DIMENSION.get(getattr(unit, "UnitType", None), 1)
        scale *= uu.get_prefix_multiplier(unit.Prefix) ** dimension
    return scale


#: How many times a length appears in each unit type, which is the power its
#: SI prefix has to be raised to.
_UNIT_DIMENSION = {"AREAUNIT": 2, "VOLUMEUNIT": 3}


def _unit_label(unit: Any) -> str | None:
    try:
        if unit.is_a("IfcConversionBasedUnit"):
            return str(unit.Name)
        if unit.is_a("IfcSIUnit"):
            return f"{unit.Prefix or ''}{unit.Name}".strip()
    except Exception:
        return None
    return None


class SpatialModel:
    """An opened IFC file plus everything the operators need to measure it."""

    def __init__(self, path: str, *, max_bytes: int = MAX_FILE_BYTES) -> None:
        _preflight(path, max_bytes)
        self.path = path
        t0 = time.perf_counter()
        try:
            self.file = ifcopenshell.open(path)
        except ModelUnreadableError:
            raise
        except BaseException as error:  # noqa: BLE001 — every parser failure, one refusal
            raise ModelUnreadableError(
                str(path),
                f"IfcOpenShell konnte diese Datei nicht lesen ({type(error).__name__}: {error}). "
                "Entweder ist das Schema nicht unterstützt oder die Datei ist beschädigt.",
            ) from None
        self.open_seconds = time.perf_counter() - t0
        self.unit_scale = uu.calculate_unit_scale(self.file)

        self._settings = ifcopenshell.geom.settings()
        self._settings.set("use-world-coords", True)

        self._geometry: dict[str, ElementGeometry | None] = {}
        #: Why a body could not be built, per GlobalId. See
        #: :meth:`geometry_failure`.
        self._geometry_failure: dict[str, str] = {}
        #: False once :meth:`space_contacts` has run out of budget — the
        #: model-wide map is then a SUBSET and every operator reading it must say
        #: so rather than report a short list as a complete one.
        self.contacts_complete = True
        self.contacts_covered = 0
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
        """The entity, or :class:`UnknownElementError`. Never a silent ``None``.

        ``file.by_guid`` is not strict enough to build this on directly, and both
        of its lenient paths are dangerous here:

        - ``by_guid(None)`` returns ``None`` rather than raising, and the caller
          then dies of ``AttributeError: 'NoneType' object has no attribute
          'GlobalId'`` several frames away from the mistake;
        - ``by_guid(123)`` falls through to lookup **by entity id** and hands
          back ``#123=IfcArbitraryOpenProfileDef`` — a real entity, of the wrong
          kind, for an id nobody asked about. An operator would then measure a
          profile definition and report it as the answer.

        So the type is checked, and the entity that comes back must actually
        carry the GlobalId that was asked for.
        """
        if not isinstance(global_id, str) or not global_id.strip():
            raise UnknownElementError(str(global_id), method)
        try:
            element = self.file.by_guid(global_id)
        except (RuntimeError, KeyError):
            raise UnknownElementError(global_id, method) from None
        if element is None or getattr(element, "GlobalId", None) != global_id:
            raise UnknownElementError(global_id, method)
        return element

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

    def label(self, element: Any) -> str | None:
        long_name = getattr(element, "LongName", None)
        return long_name or getattr(element, "Name", None)

    def ref(self, element: Any, via: str | None = None) -> ElementRef:
        return ElementRef(
            global_id=element.GlobalId,
            ifc_type=element.is_a(),
            name=self.label(element),
            kind=self.kind_of(element),
            via=via,
        )

    def refs(self, elements: Iterable[Any], via: str | None = None) -> list[ElementRef]:
        return [self.ref(e, via) for e in elements if getattr(e, "GlobalId", None)]

    # ── relations the file states outright ──────────────────────────────────

    def storey_of(self, element: Any) -> Any | None:
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

    def storey_datum(self, element: Any) -> Storey | None:
        storey = self.storey_of(element)
        if storey is None:
            return None
        for s in self.storeys:
            if s.global_id == storey.GlobalId and s.elevation is not None:
                return s
        return None

    @cached_property
    def true_north(self) -> float | None:
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
        # `by_type` RAISES for a class the file's schema does not define, and
        # `IfcMapConversion` is IFC4+. So on every IFC2X3 export this property
        # threw `RuntimeError: Entity with name 'IfcMapConversion' not found in
        # schema 'IFC2X3'` instead of returning False — and being a
        # `cached_property`, it took its caller with it rather than degrading.
        # An older schema is not a georeferencing failure; it is a schema that
        # cannot express one.
        try:
            return bool(self.file.by_type("IfcMapConversion"))
        except RuntimeError:
            return False

    # ── geometry ────────────────────────────────────────────────────────────

    def geometry(self, global_id: str) -> ElementGeometry | None:
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

    def geometry_failure(self, global_id: str) -> str | None:
        """*Why* this element has no body — ``None`` when it has one.

        Two failures wear the same missing geometry and want different sentences.
        The ArchiCAD 18 export in the corpus makes the case: **94 of its 100
        ``IfcSpace`` entities carry a full ``Body`` representation and OCCT
        cannot build a single one of them** (``Failed to process shape``). Telling
        that architect "dieses Bauteil trägt keinen Körper" sends them to check an
        export setting that is already correct; the actual problem is a room
        boundary the kernel rejects.

        Returns ``"no-representation"``, ``"empty-mesh"``, or
        ``"shape-failed: …"`` with the kernel's own message.
        """
        return self._geometry_failure.get(global_id)

    def _shape_of(self, element: Any) -> ElementGeometry | None:
        global_id = element.GlobalId
        if not getattr(element, "Representation", None) and not element.is_a("IfcSpace"):
            self._geometry_failure[global_id] = "no-representation"
            return None
        try:
            shape = ifcopenshell.geom.create_shape(self._settings, element)
        except Exception as error:
            self._geometry_failure[global_id] = f"shape-failed: {error}"
            return None
        self._shapes[global_id] = shape
        geometry = self._from_shape(global_id, shape.geometry)
        if geometry is None:
            self._geometry_failure[global_id] = "empty-mesh"
        return geometry

    @staticmethod
    def _from_shape(global_id: str, geometry: Any) -> ElementGeometry | None:
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

    def triangulation(self, global_id: str) -> Any | None:
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
    def bounds(self) -> tuple[np.ndarray, np.ndarray] | None:
        index = self.geometry_pass()
        if not index:
            return None
        lows = np.array([g.box[0] for g in index.values()])
        highs = np.array([g.box[1] for g in index.values()])
        return lows.min(axis=0), highs.max(axis=0)

    @cached_property
    def plan_centre(self) -> np.ndarray | None:
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

        ## The budget, and why the map can come back short

        One offset costs 0.5–2 s and the loop is over every space in the file, so
        the cost is unbounded in the model: a 4 MB office export with 99 rooms
        spent **212 seconds** here, all of it inside a single ``opens_to()`` call
        about a single window. That is a hang in a request process, so the loop
        now stops at :data:`CONTACT_BUDGET_SECONDS` and sets
        :attr:`contacts_complete` to ``False``. Callers must read that flag: a
        truncated map looks exactly like a building with fewer neighbours.

        Most callers do not need the map at all — :meth:`contacts_of` answers
        "what touches THIS room" with one offset. The model-wide map is only
        needed for the inverse question ("which rooms touch this wall"), and that
        is the only place that pays for it.
        """
        key = round(contact, 6)
        contacts = self._space_contacts.setdefault(key, {})
        if not self.derivable_boundaries:
            # Checked here as well as in the operators, because this is a public
            # method and the admission test has to hold for whoever calls it.
            self.contacts_complete = False
            return contacts
        spaces = self.file.by_type("IfcSpace")
        outstanding = [s for s in spaces if s.GlobalId not in contacts]
        self.contacts_covered = len(contacts)
        if not outstanding:
            self.contacts_complete = True
            return contacts
        if not self.contacts_complete:
            # A previous attempt already ran out of budget on this file. Trying
            # again would spend the budget a second time to reach the same
            # incomplete answer, so the incomplete map is returned as it stands
            # and the flag keeps saying so.
            return contacts

        t0 = time.perf_counter()
        for space in outstanding:
            # Checked between offsets, which is the only place it can be
            # checked: an OCCT offset is a single C++ call with no interruption
            # point, so one pathological solid can still overrun the budget. The
            # bound is on the loop, not on the kernel.
            if time.perf_counter() - t0 > CONTACT_BUDGET_SECONDS:
                self.contacts_complete = False
                break
            contacts[space.GlobalId] = self._contacts_for(space, contact)
        self.contacts_covered = len(contacts)
        self.contact_seconds = time.perf_counter() - t0
        return contacts

    @cached_property
    def product_count(self) -> int:
        """How many ``IfcProduct`` entities this file holds — one cheap read.

        Known straight after opening, before any geometry, which is what makes
        it usable as an admission test.
        """
        try:
            return len(self.file.by_type("IfcProduct"))
        except RuntimeError:
            return 0

    @cached_property
    def derivable_boundaries(self) -> bool:
        """Whether deriving space boundaries from the solids may be attempted.

        See :data:`DERIVED_BOUNDARY_MAX_PRODUCTS`. ``False`` is a refusal, and
        the operators turn it into an undecidable answer that names the count.
        """
        return self.product_count <= DERIVED_BOUNDARY_MAX_PRODUCTS

    def contacts_of(self, space: Any, contact: float = 0.05) -> set[str]:
        """What touches ONE space — one OCCT offset, cached, no model-wide loop.

        The question ``bounds(space)`` actually asks. Splitting it out of
        :meth:`space_contacts` is what turns a 212 s answer on a 99-room model
        into a 2 s one, because 98 of those offsets were computed for a question
        nobody had asked.
        """
        key = round(contact, 6)
        cached = self._space_contacts.setdefault(key, {})
        if not self.derivable_boundaries:
            return set()
        found = cached.get(space.GlobalId)
        if found is None:
            t0 = time.perf_counter()
            found = self._contacts_for(space, contact)
            cached[space.GlobalId] = found
            self.contact_seconds += time.perf_counter() - t0
        return found

    def _contacts_for(self, space: Any, contact: float) -> set[str]:
        try:
            touching = self.tree.select(space, extend=contact)
        except Exception:
            touching = []
        return {e.GlobalId for e in touching if getattr(e, "GlobalId", None) and e.GlobalId != space.GlobalId}

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

    def declared_property(self, element: Any, names: Iterable[str]) -> Any:
        """The first non-null property value matching ``names``, across every pset.

        The sibling of :meth:`declared_quantity` for values that carry no unit —
        ``IsExternal``, ``LoadBearing``, ``FireRating``. No conversion is
        possible or wanted here; a boolean in ``Pset_WallCommon`` and the same
        boolean in a vendor pset mean the same thing.

        Searched across all psets for the same reason quantities are: the name
        is standardised (``IsExternal``) but the SET it lands in is not —
        ``Pset_WallCommon``, ``Pset_MemberCommon``, ``Pset_PlateCommon`` and a
        dozen vendor variants all carry it, and a lookup pinned to one of them
        reports „nicht deklariert" about a file that declares it.

        ``None`` means no pset carries any of these names, which is a fact about
        the EXPORT and has to stay distinguishable from a declared ``False``.
        """
        psets = ue.get_psets(element, qtos_only=False) or {}
        for key in names:
            for values in psets.values():
                if not isinstance(values, dict):
                    continue
                value = values.get(key)
                if value is not None:
                    return value
        return None

    def declared_quantity(self, element: Any, names: Iterable[str]) -> DeclaredQuantity | None:
        """The declared quantity best matching ``names``, converted to SI.

        Deliberately not restricted to ``Qto_SpaceBaseQuantities``: exports
        publish room areas in ``BaseQuantities`` (Revit, Trapelo), in
        ``SpaceQuantities`` (Allplan), in ``GSA Space Areas`` (the GSA Duplex),
        and a triangulation that only looked at the canonical name would report
        "die Datei deklariert keine Fläche" about a file that declares it. The
        pset the value was found in travels back so the reader can see which
        dialect this export speaks.

        Three things this has to get right, each of which it got wrong on the
        corpus before:

        **The unit.** A quantity is stated in the file's own unit, and the file's
        area unit is INDEPENDENT of its length unit — the sample house measures
        in millimetres and declares areas in square metres, while the Trapelo
        export measures in feet and declares them in square feet. Scaling by
        ``unit_scale ** 2`` would be wrong in both directions. The right tool is
        ``ifcopenshell.util.unit.get_property_unit``, which returns the
        quantity's OWN unit when it overrides the project, and the project unit
        for that measure otherwise; the conversion chain is then walked to SI.
        Before this, ``floor_area`` compared 6.33 m² of measured geometry against
        68.10 declared **square feet** and reported the export as 91 % wrong.

        **Quantity sets outrank property sets.** ``get_psets`` merges
        ``IfcElementQuantity`` and ``IfcPropertySet`` into one dictionary, and
        iterating it in insertion order let ``PSet_Revit_Dimensions.Area`` — a
        Revit dimension echo — beat the real ``Qto_SpaceBaseQuantities``. Real
        quantity sets are searched first.

        **Name order is priority order.** ``names`` is ranked by the caller;
        looping psets on the outside made the answer depend on export order
        instead, so ``Area`` in the first pset beat ``NetFloorArea`` in the
        second.
        """
        wanted = list(names)
        verbose = ue.get_psets(element, qtos_only=False, verbose=True) or {}
        quantity_sets = set(ue.get_psets(element, qtos_only=True) or {})

        for qtos_first in (True, False):
            for key in wanted:
                for pset_name, values in verbose.items():
                    if (pset_name in quantity_sets) != qtos_first:
                        continue
                    entry = values.get(key)
                    if not isinstance(entry, dict):
                        continue
                    raw = entry.get("value")
                    if not isinstance(raw, (int, float)) or isinstance(raw, bool):
                        continue
                    scale, unit_label = self._quantity_scale(entry.get("id"))
                    return DeclaredQuantity(
                        path=f"{pset_name}.{key}",
                        value=float(raw) * scale,
                        raw=float(raw),
                        scale=scale,
                        unit_label=unit_label,
                    )
        return None

    def _quantity_scale(self, entity_id: int | None) -> tuple[float, str | None]:
        """The factor from a quantity's declared unit to SI, and that unit's name."""
        if entity_id is None:
            return 1.0, None
        try:
            quantity = self.file.by_id(entity_id)
            unit = uu.get_property_unit(quantity, self.file)
        except Exception:
            return 1.0, None
        if unit is None:
            return 1.0, None
        return _unit_scale_to_si(unit), _unit_label(unit)


__all__ = [
    "AIR_TYPES",
    "CONTACT_BUDGET_SECONDS",
    "DERIVED_BOUNDARY_MAX_PRODUCTS",
    "MAX_FILE_BYTES",
    "DeclaredQuantity",
    "ElementGeometry",
    "ModelTooLargeError",
    "ModelUnreadableError",
    "SpatialModel",
    "Storey",
    "UnknownElementError",
]
