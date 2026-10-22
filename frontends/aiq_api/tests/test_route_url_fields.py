"""A URL a caller hands this tier is an ``ObjectStoreUrl``, or this file says why not.

The SSRF gate used to be a private function a route had to remember to call,
and the mail-archive routes did not: they took a caller's URL and requested it
(``routes/mail_archive.py`` before ``aiq_api.object_store_url``). The type
cannot be forgotten once it is on the field, so this test holds every request
model to it: it walks the body of every route mounted from ``routes/``, and
every request-shaped model this package defines, into their nested models, and
fails on a field whose name says URL (``url``, ``*_url``, ``*_ref``, ``*_uri``,
``*_href``) typed as a plain ``str``.

A URL that is stored or shown and never requested by this tier is not an SSRF;
it goes in :data:`NOT_REQUESTED` with the reason, where a reviewer reads it.
"""

from __future__ import annotations

import importlib
import inspect
import pkgutil
import re
import types
import typing
from collections.abc import Iterator

from fastapi import APIRouter
from fastapi.routing import APIRoute
from pydantic import BaseModel
from pydantic.fields import FieldInfo

import aiq_api
from aiq_api import routes as routes_package
from aiq_api.object_store_url import ObjectStoreUrl

#: A field name that says "this is a URL".
_URL_NAME = re.compile(r"^(url|uri|href)$|_(url|ref|uri|href)$")

_REGISTRAR = re.compile(r"^(add|register)_\w*routes$")

#: ``Model.field``: why a URL-named plain ``str`` is not a URL this tier requests.
NOT_REQUESTED: dict[str, str] = {
    "NormEntry.citation_url": "a RIS citation link the norm registry stores and the UI shows; never requested here",
    "NormEntry.full_law_url": "a RIS full-text link the norm registry stores and the UI shows; never requested here",
    "NormEntry.source_url": "a publisher's link (wien.gv.at, oib.or.at) stored and shown; never requested here",
}

#: Fields the walk must reach, or it is walking the wrong thing.
_KNOWN_GATED = {"IngestRequest.file_ref", "ArchiveRef.url"}


def _mounted_routes() -> list[APIRoute]:
    """Every route a router-level registrar under ``routes/`` mounts."""
    router = APIRouter()
    for info in pkgutil.iter_modules(routes_package.__path__):
        module = importlib.import_module(f"aiq_api.routes.{info.name}")
        for name, function in inspect.getmembers(module, inspect.isroutine):
            if not _REGISTRAR.match(name) or function.__module__ != module.__name__:
                continue
            parameters = list(inspect.signature(function).parameters)
            if parameters[0] == "app":
                continue  # app-level (the job routes): their models are found by _request_shaped_models
            function(router) if len(parameters) == 1 else function(router, {})
    return [route for route in router.routes if isinstance(route, APIRoute)]


def _mounted_body_models() -> Iterator[type[BaseModel]]:
    for route in _mounted_routes():
        for parameter in route.dependant.body_params:
            yield from _models_in(parameter.field_info.annotation)


def _request_shaped_models() -> Iterator[type[BaseModel]]:
    """Every model named ``*Request`` that a module of this package defines, mounted or not."""
    for info in pkgutil.walk_packages(aiq_api.__path__, "aiq_api."):
        module = importlib.import_module(info.name)
        for _, member in inspect.getmembers(module, inspect.isclass):
            if (
                issubclass(member, BaseModel)
                and member.__module__ == module.__name__
                and member.__name__.endswith("Request")
            ):
                yield member


def _models_in(annotation: object) -> Iterator[type[BaseModel]]:
    if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
        yield annotation
        return
    for argument in typing.get_args(annotation):
        yield from _models_in(argument)


#: What makes a ``str`` an ``ObjectStoreUrl``: its constraints and its validator.
_GATE = typing.get_args(ObjectStoreUrl)[1:]


def _is_gated(field: FieldInfo) -> bool:
    """The field is an ``ObjectStoreUrl``, alone or inside ``| None``, a list or another wrapper.

    pydantic lifts a top-level ``Annotated`` off the annotation into the
    field's ``metadata``; one nested in a union stays where it was written.
    """
    return all(part in field.metadata for part in _GATE) or _annotates_gate(field.annotation)


def _annotates_gate(annotation: object) -> bool:
    if typing.get_origin(annotation) is typing.Annotated:
        return typing.get_args(annotation)[1:] == _GATE
    return any(_annotates_gate(argument) for argument in typing.get_args(annotation))


def _says_str(annotation: object) -> bool:
    if annotation is str:
        return True
    if isinstance(annotation, types.UnionType) or typing.get_origin(annotation) in (typing.Union, list, tuple, set):
        return any(_says_str(argument) for argument in typing.get_args(annotation))
    return False


def _url_fields() -> dict[str, FieldInfo]:
    """``Model.field`` to its field, for every URL-named field reachable from a request model."""
    found: dict[str, FieldInfo] = {}
    seen: set[type[BaseModel]] = set()
    pending = [*_mounted_body_models(), *_request_shaped_models()]
    while pending:
        model = pending.pop()
        if model in seen:
            continue
        seen.add(model)
        for name, field in model.model_fields.items():
            if _URL_NAME.search(name):
                found[f"{model.__name__}.{name}"] = field
            pending.extend(_models_in(field.annotation))
    return found


def test_every_url_a_request_names_is_an_object_store_url():
    fields = _url_fields()

    plain = sorted(
        name
        for name, field in fields.items()
        if not _is_gated(field) and _says_str(field.annotation) and name not in NOT_REQUESTED
    )

    assert plain == [], (
        f"URL-named fields typed as a plain str: {plain}. Type each as aiq_api.object_store_url.ObjectStoreUrl, "
        "or, if this tier never requests it, add it to NOT_REQUESTED with the reason."
    )


def test_no_route_takes_a_url_as_a_plain_query_path_header_or_body_parameter():
    """The same rule for a URL that arrives outside a model: ``?url=…``, a path segment, a header."""
    plain = sorted(
        f"{sorted(route.methods)[0]} {route.path}: {parameter.name}"
        for route in _mounted_routes()
        for parameter in (
            *route.dependant.query_params,
            *route.dependant.path_params,
            *route.dependant.header_params,
            *route.dependant.body_params,
        )
        if _URL_NAME.search(parameter.name)
        and not _is_gated(parameter.field_info)
        and _says_str(parameter.field_info.annotation)
    )

    assert plain == [], f"URL-named route parameters typed as a plain str: {plain}"


def test_the_walk_reaches_the_gated_fields():
    """A walk that found nothing would pass the test above; it must see the fields we know."""
    fields = _url_fields()

    assert _KNOWN_GATED <= fields.keys()
    assert all(_is_gated(fields[name]) for name in _KNOWN_GATED)


def test_every_exemption_still_names_a_field():
    """An exemption whose field was renamed or removed would excuse the next one to take its name."""
    assert set(NOT_REQUESTED) <= _url_fields().keys()
