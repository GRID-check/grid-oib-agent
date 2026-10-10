"""What a camera wrote into a photo: when it was taken, where, and with what.

A site photo is evidence of a moment — the state of the Rohbau on 14 September,
the fire door before it was closed in — and the moment is written in the file:
the EXIF ``DateTimeOriginal`` the camera set when the shutter fired. Piloti
re-encodes every image to JPEG before the vision model reads it, which drops
EXIF, so unless it is read from the ORIGINAL bytes first it is gone, and
"die Baustellenfotos von letzter Woche" has nothing to be answered from but
the upload date, which is when someone got round to uploading them.

Only the facts that answer a planner's question are kept:

- ``captured_at`` — ``DateTimeOriginal`` with ``OffsetTimeOriginal`` when the
  camera wrote one (ISO 8601; local time without an offset when it did not).
- ``latitude`` / ``longitude`` — the GPS position in decimal degrees. Stored
  and shown to the people who may open the file, NEVER sent to a model: a
  client's site location is not something to hand a provider to caption a
  photo, and nothing a caption says needs it.
- ``camera`` — make and model, so a drone shot reads as one.

Everything else EXIF can carry is ignored on purpose, above all the owner's
name and the body serial number some cameras write.

Pure and model-free; never raises. A file without EXIF, or with EXIF Pillow
cannot parse, answers an empty :class:`PhotoFacts`.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

#: EXIF writes ``YYYY:MM:DD HH:MM:SS``; some phones pad unknown parts with spaces or zeros.
_EXIF_DATETIME = "%Y:%m:%d %H:%M:%S"
_OFFSET = re.compile(r"^[+-]\d{2}:\d{2}$")


@dataclass(frozen=True)
class PhotoFacts:
    captured_at: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    camera: str | None = None

    @property
    def empty(self) -> bool:
        return self.captured_at is None and self.latitude is None and self.camera is None

    def as_metadata(self) -> dict[str, Any]:
        """The facts as the metadata row stores them: present keys only."""
        out: dict[str, Any] = {}
        if self.captured_at:
            out["captured_at"] = self.captured_at
        if self.latitude is not None and self.longitude is not None:
            out["latitude"] = self.latitude
            out["longitude"] = self.longitude
        if self.camera:
            out["camera"] = self.camera
        return out

    def model_context(self) -> str | None:
        """What a model may be told about the photo: when it was taken. Never where."""
        if not self.captured_at:
            return None
        day, _, time = self.captured_at.partition("T")
        try:
            year, month, date = day.split("-")
        except ValueError:
            return None
        clock = time[:5] if len(time) >= 5 else ""
        return f"Aufgenommen am {date}.{month}.{year}" + (f" um {clock} Uhr" if clock else "") + "."


def _captured_at(exif_ifd: Any) -> str | None:
    from PIL import ExifTags

    raw = exif_ifd.get(ExifTags.Base.DateTimeOriginal) or exif_ifd.get(ExifTags.Base.DateTimeDigitized)
    if not isinstance(raw, str):
        return None
    try:
        moment = datetime.strptime(raw.strip().rstrip("\x00"), _EXIF_DATETIME)
    except ValueError:
        return None
    # A camera with an unset clock writes 1970 or 2000-01-01; neither is a site visit.
    if moment.year < 2000 or moment.date() == date(2000, 1, 1):
        return None
    offset = exif_ifd.get(ExifTags.Base.OffsetTimeOriginal)
    # EXIF ASCII is NUL-terminated, and Pillow keeps the NUL.
    offset = offset.strip().rstrip("\x00").strip() if isinstance(offset, str) else ""
    stamp = moment.isoformat(timespec="seconds")
    return stamp + offset if _OFFSET.match(offset) else stamp


def _degrees(value: Any, ref: Any) -> float | None:
    """A GPS coordinate from EXIF's (degrees, minutes, seconds) rationals and its N/S/E/W ref."""
    try:
        degrees, minutes, seconds = (float(part) for part in value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    decimal = degrees + minutes / 60 + seconds / 3600
    if isinstance(ref, bytes):
        ref = ref.decode("ascii", "ignore")
    if isinstance(ref, str) and ref.strip().upper() in {"S", "W"}:
        decimal = -decimal
    return round(decimal, 6)


def _position(gps_ifd: Any) -> tuple[float | None, float | None]:
    from PIL import ExifTags

    latitude = _degrees(gps_ifd.get(ExifTags.GPS.GPSLatitude), gps_ifd.get(ExifTags.GPS.GPSLatitudeRef))
    longitude = _degrees(gps_ifd.get(ExifTags.GPS.GPSLongitude), gps_ifd.get(ExifTags.GPS.GPSLongitudeRef))
    if latitude is None or longitude is None:
        return None, None
    # (0, 0) is what a phone writes with no fix; it is the Gulf of Guinea, not a site.
    if latitude == 0 and longitude == 0:
        return None, None
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None, None
    return latitude, longitude


def _camera(exif: Any) -> str | None:
    from PIL import ExifTags

    def text(tag: int) -> str:
        value = exif.get(tag)
        return value.strip().strip("\x00").strip() if isinstance(value, str) else ""

    make, model = text(ExifTags.Base.Make), text(ExifTags.Base.Model)
    if model and make and model.lower().startswith(make.lower()):
        return model[:80]
    return " ".join(part for part in (make, model) if part)[:80] or None


def read_photo_facts(file_path: str) -> PhotoFacts:
    """The capture facts of the image at ``file_path`` — the ORIGINAL file, before any re-encode."""
    try:
        from PIL import ExifTags
        from PIL import Image

        with Image.open(file_path) as image:
            exif = image.getexif()
        if not exif:
            return PhotoFacts()
        latitude, longitude = _position(exif.get_ifd(ExifTags.IFD.GPSInfo))
        return PhotoFacts(
            captured_at=_captured_at(exif.get_ifd(ExifTags.IFD.Exif)),
            latitude=latitude,
            longitude=longitude,
            camera=_camera(exif),
        )
    except Exception:  # noqa: BLE001 — a fact about a photo is never worth its ingestion
        logger.debug("Could not read EXIF of %s", file_path, exc_info=True)
        return PhotoFacts()
