"""The one gate for a URL this tier requests on a caller's behalf: the object store's, and no other.

Every URL a caller hands this tier to fetch or upload to is a presigned URL
into the object store (SeaweedFS): an ingest's ``file_ref`` and its
rendition, the thumbnail slot, a staged mail archive. A route that requests a
URL it did not check is a server-side request forgery: the request leaves
from inside the network with this tier's trust, so a URL aimed at a cloud
metadata endpoint, the database or the store's own admin ports
(SeaweedFS's master and filer listen on the same host as its S3 gateway) is
answered as if this tier had asked.

So a URL passes only when its origin (RFC 6454: scheme, host, port) is one
of the store's configured endpoints, ``SEAWEED_ENDPOINT`` (the in-network
one the BFF presigns backend URLs against, ``presignForBackend``) and
``SEAWEED_PUBLIC_ENDPOINT`` (the browser-facing one). Host strictly, never
by substring: ``evil-seaweedfs.test`` is not ``seaweedfs.test``. Port too: the
store's host with another port is another service. Unset, nothing passes.

The URL is also refused when its text could be read two ways: credentials
before the host (``http://store@elsewhere/``), a backslash, whitespace or
any character outside printable ASCII. A presigned URL has none of them, and
each is a place where the parser here and the HTTP client's could disagree
on which host is meant.

Two ways in, one check:

- :data:`ObjectStoreUrl`, the type a request model's field carries. A request
  naming any other URL is refused at validation with 422, before the
  handler runs, so no route can forget the call.
  ``tests/test_route_url_fields.py`` fails a route model whose URL-named
  field is a plain ``str``.
- :func:`assert_fetchable_object_store_url`, for a URL that arrives by another
  path than a request body: a row read back from the durable ingest queue,
  which anyone who can write the table could have forged.

The error never repeats the URL: a presigned URL is a bearer credential.
"""

from __future__ import annotations

import os
from typing import Annotated
from urllib.parse import urlsplit
from urllib.parse import urlunsplit

from pydantic import AfterValidator
from pydantic import StringConstraints

#: The longest URL accepted. A SigV4 presigned GET is a few hundred
#: characters; the bound keeps a hostile value from being parsed at length.
MAX_URL_LENGTH = 8192

#: The variables naming the store's endpoints, in-network and browser-facing.
ENDPOINT_VARIABLES = ("SEAWEED_ENDPOINT", "SEAWEED_PUBLIC_ENDPOINT")

_DEFAULT_PORTS = {"http": 80, "https": 443}

#: Printable ASCII without the space and the backslash: everything a presigned URL is made of.
_URL_CHARACTERS = frozenset(chr(code) for code in range(0x21, 0x7F)) - {"\\"}

#: An origin as RFC 6454 defines it: scheme, host, port.
Origin = tuple[str, str, int]


class ObjectStoreUrlError(ValueError):
    """The URL is not one this tier may request: it does not name the object store."""


def object_store_origins() -> frozenset[Origin]:
    """The origins of the configured object-store endpoints; read on every call, so a test can set them."""
    origins: set[Origin] = set()
    for variable in ENDPOINT_VARIABLES:
        endpoint = os.environ.get(variable, "").strip()
        if not endpoint:
            continue
        try:
            origins.add(_origin(endpoint))
        except ObjectStoreUrlError:
            # An endpoint without a scheme or host trusts nothing; the store's
            # own client reports the misconfiguration where it is used.
            continue
    return frozenset(origins)


def assert_fetchable_object_store_url(url: str, field: str = "url") -> None:
    """Raise :class:`ObjectStoreUrlError` unless ``url`` names the object store.

    ``field`` names the value in the message, which never repeats the URL.
    """
    if len(url) > MAX_URL_LENGTH:
        raise ObjectStoreUrlError(f"{field} is longer than {MAX_URL_LENGTH} characters")
    if not set(url) <= _URL_CHARACTERS:
        raise ObjectStoreUrlError(f"{field} must be printable ASCII without spaces or backslashes")
    if _origin(url, field) not in object_store_origins():
        raise ObjectStoreUrlError(f"{field} must point at the configured object store")


def object_store_request_url(url: str, field: str = "url") -> str:
    """``url`` rebuilt on the configured endpoint it names: the endpoint's origin, the URL's path and query.

    The gate above proves that the URL's origin equals a configured one; this
    makes the request go there by construction, so the host a fetch reaches
    comes from configuration and only the object's path and its presigned
    query come from the caller. Fetch with this, never with the raw string.
    """
    assert_fetchable_object_store_url(url, field)
    wanted = _origin(url, field)
    for variable in ENDPOINT_VARIABLES:
        endpoint = os.environ.get(variable, "").strip()
        if not endpoint:
            continue
        try:
            origin = _origin(endpoint)
        except ObjectStoreUrlError:
            continue
        if origin != wanted:
            continue
        configured = urlsplit(endpoint)
        requested = urlsplit(url)
        return urlunsplit((configured.scheme, configured.netloc, requested.path, requested.query, ""))
    raise ObjectStoreUrlError(f"{field} must point at the configured object store")


def _origin(url: str, field: str = "url") -> Origin:
    """The URL's origin, or :class:`ObjectStoreUrlError` when it has none this gate can trust."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme not in _DEFAULT_PORTS:
        raise ObjectStoreUrlError(f"{field} must be an http(s) URL")
    if "@" in parts.netloc:
        raise ObjectStoreUrlError(f"{field} must not carry credentials")
    if not parts.hostname:
        raise ObjectStoreUrlError(f"{field} must name a host")
    try:
        port = parts.port or _DEFAULT_PORTS[scheme]
    except ValueError as error:
        raise ObjectStoreUrlError(f"{field} has an invalid port") from error
    return scheme, parts.hostname.casefold(), port


def _validated(url: str) -> str:
    # The field's name is in the validation error's location already.
    assert_fetchable_object_store_url(url, field="the URL")
    return url


#: A presigned URL into the object store, as a request model's field type.
ObjectStoreUrl = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_URL_LENGTH),
    AfterValidator(_validated),
]
