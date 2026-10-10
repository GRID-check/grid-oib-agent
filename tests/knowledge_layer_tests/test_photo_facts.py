"""The capture facts a camera wrote into a site photo, read from the ORIGINAL file.

Fixtures are real JPEGs with EXIF written by Pillow, so the tests read the same
tag layout a camera produces. The privacy rules are the contract: a position
never reaches a model, and the owner's name and body serial never leave the file.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from knowledge_layer.llamaindex.photo_facts import PhotoFacts
from knowledge_layer.llamaindex.photo_facts import read_photo_facts
from PIL import ExifTags
from PIL import Image
from PIL.TiffImagePlugin import IFDRational

# A site north-east of Vienna: digits that cannot be mistaken for the date below.
SITE_GPS = ("N", (48, 12, 34), "E", (16, 22, 11))
SITE_LATITUDE = 48.209444
SITE_LONGITUDE = 16.369722


def _dms(degrees: float, minutes: float, seconds: float) -> tuple[IFDRational, ...]:
    return (IFDRational(degrees, 1), IFDRational(minutes, 1), IFDRational(seconds, 1))


def _write_photo(
    path: Path,
    *,
    when: str | None = None,
    offset: str | None = None,
    digitized: str | None = None,
    make: str | None = None,
    model: str | None = None,
    gps: tuple | None = None,
    owner: str | None = None,
    serial: str | None = None,
) -> str:
    """A small JPEG carrying exactly the EXIF given; returns its path."""
    exif = Image.Exif()
    capture = exif.get_ifd(ExifTags.IFD.Exif)
    if when is not None:
        capture[ExifTags.Base.DateTimeOriginal] = when
    if offset is not None:
        capture[ExifTags.Base.OffsetTimeOriginal] = offset
    if digitized is not None:
        capture[ExifTags.Base.DateTimeDigitized] = digitized
    if owner is not None:
        capture[ExifTags.Base.CameraOwnerName] = owner
    if serial is not None:
        capture[ExifTags.Base.BodySerialNumber] = serial
    if make is not None:
        exif[ExifTags.Base.Make] = make
    if model is not None:
        exif[ExifTags.Base.Model] = model
    if gps is not None:
        lat_ref, lat, lon_ref, lon = gps
        position = exif.get_ifd(ExifTags.IFD.GPSInfo)
        position[ExifTags.GPS.GPSLatitudeRef] = lat_ref
        position[ExifTags.GPS.GPSLatitude] = _dms(*lat)
        position[ExifTags.GPS.GPSLongitudeRef] = lon_ref
        position[ExifTags.GPS.GPSLongitude] = _dms(*lon)
    Image.new("RGB", (8, 8), "white").save(path, "JPEG", exif=exif)
    return str(path)


def _photo(tmp_path: Path, name: str = "site.jpg", **exif) -> str:
    return _write_photo(tmp_path / name, **exif)


class TestCaptureTime:
    def test_the_date_and_clock_are_read_as_iso_8601(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, when="2026:09:14 10:32:05"))
        assert facts.captured_at == "2026-09-14T10:32:05"

    def test_the_camera_offset_is_kept_when_the_camera_wrote_one(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, when="2026:09:14 10:32:05", offset="+02:00"))
        assert facts.captured_at == "2026-09-14T10:32:05+02:00"

    def test_an_offset_that_is_not_an_offset_is_dropped(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, when="2026:09:14 10:32:05", offset="CEST"))
        assert facts.captured_at == "2026-09-14T10:32:05"

    def test_the_digitized_time_stands_in_when_the_original_is_missing(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, digitized="2026:09:14 10:32:05"))
        assert facts.captured_at == "2026-09-14T10:32:05"

    def test_a_nul_terminated_timestamp_is_still_parsed(self, tmp_path):
        # The TIFF spec counts the terminating NUL in an ASCII value; Pillow returns it.
        facts = read_photo_facts(_photo(tmp_path, when="2026:09:14 10:32:05\x00"))
        assert facts.captured_at == "2026-09-14T10:32:05"

    @pytest.mark.parametrize("when", ["1970:01:01 00:00:00", "1999:12:31 23:59:59"])
    def test_a_clock_before_2000_is_no_capture_time(self, tmp_path, when):
        facts = read_photo_facts(_photo(tmp_path, when=when))
        assert facts.captured_at is None

    @pytest.mark.parametrize("when", ["0000:00:00 00:00:00", "not a date", "2026-09-14 10:32:05"])
    def test_an_unparseable_timestamp_is_no_capture_time(self, tmp_path, when):
        facts = read_photo_facts(_photo(tmp_path, when=when))
        assert facts.captured_at is None

    def test_a_nul_terminated_offset_is_kept(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, when="2026:09:14 10:32:05", offset="+02:00\x00"))
        assert facts.captured_at == "2026-09-14T10:32:05+02:00"

    def test_the_unset_clock_of_2000_is_no_capture_time(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, when="2000:01:01 00:00:00"))
        assert facts.captured_at is None


class TestPosition:
    def test_south_and_west_are_negative_decimal_degrees(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, gps=("S", (47, 30, 15), "W", (7, 0, 0))))
        assert facts.latitude == pytest.approx(-47.504167, abs=1e-6)
        assert facts.longitude == pytest.approx(-7.0, abs=1e-6)

    def test_north_and_east_are_positive_decimal_degrees(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, gps=SITE_GPS))
        assert facts.latitude == pytest.approx(SITE_LATITUDE, abs=1e-6)
        assert facts.longitude == pytest.approx(SITE_LONGITUDE, abs=1e-6)

    def test_the_null_island_fix_of_a_phone_with_no_fix_is_rejected(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, when="2026:09:14 10:32:05", gps=("N", (0, 0, 0), "E", (0, 0, 0))))
        assert facts.latitude is None
        assert facts.longitude is None
        # The rest of the file is still read: a rejected position is not a rejected photo.
        assert facts.captured_at == "2026-09-14T10:32:05"

    def test_a_latitude_beyond_the_poles_is_rejected(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, gps=("N", (91, 0, 0), "E", (16, 22, 11))))
        assert facts.latitude is None
        assert facts.longitude is None


class TestCamera:
    def test_make_and_model_read_as_one_name(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, make="Apple", model="iPhone 15 Pro"))
        assert facts.camera == "Apple iPhone 15 Pro"

    def test_a_model_that_already_names_its_make_is_not_doubled(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, make="DJI", model="DJI Mavic 3"))
        assert facts.camera == "DJI Mavic 3"

    def test_a_model_alone_is_the_camera(self, tmp_path):
        assert read_photo_facts(_photo(tmp_path, model="X100V")).camera == "X100V"

    def test_a_make_alone_is_the_camera(self, tmp_path):
        assert read_photo_facts(_photo(tmp_path, make="Apple")).camera == "Apple"

    def test_a_long_model_is_bounded(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, make="Acme", model="X" * 200))
        assert facts.camera is not None
        assert len(facts.camera) == 80


class TestEmpty:
    def test_a_file_without_exif_is_empty(self, tmp_path):
        path = tmp_path / "plain.jpg"
        Image.new("RGB", (8, 8), "white").save(path, "JPEG")
        facts = read_photo_facts(str(path))
        assert facts == PhotoFacts()
        assert facts.empty is True

    def test_a_file_with_only_a_capture_time_is_not_empty(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, when="2026:09:14 10:32:05"))
        assert facts.empty is False

    def test_a_file_with_only_a_position_is_not_empty(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, gps=SITE_GPS))
        assert facts.empty is False

    def test_a_default_photo_facts_is_empty(self):
        assert PhotoFacts().empty is True


class TestRobustness:
    def test_a_file_that_is_not_an_image_is_empty_and_does_not_raise(self, tmp_path):
        path = tmp_path / "broken.jpg"
        path.write_bytes(b"this is not a jpeg at all")
        assert read_photo_facts(str(path)).empty is True

    def test_a_missing_file_is_empty_and_does_not_raise(self, tmp_path):
        assert read_photo_facts(str(tmp_path / "missing.jpg")).empty is True


class TestAsMetadata:
    def test_every_present_fact_is_stored_under_its_key(self, tmp_path):
        facts = read_photo_facts(
            _photo(tmp_path, when="2026:09:14 10:32:05", offset="+02:00", make="DJI", model="DJI Mavic 3", gps=SITE_GPS)
        )
        metadata = facts.as_metadata()
        assert set(metadata) == {"captured_at", "latitude", "longitude", "camera"}
        assert metadata["captured_at"] == "2026-09-14T10:32:05+02:00"
        assert metadata["latitude"] == pytest.approx(SITE_LATITUDE, abs=1e-6)
        assert metadata["longitude"] == pytest.approx(SITE_LONGITUDE, abs=1e-6)
        assert metadata["camera"] == "DJI Mavic 3"

    def test_absent_facts_have_no_key(self):
        assert PhotoFacts().as_metadata() == {}
        assert set(PhotoFacts(captured_at="2026-09-14T10:32:05").as_metadata()) == {"captured_at"}

    def test_a_latitude_without_a_longitude_is_not_stored(self):
        assert "latitude" not in PhotoFacts(latitude=SITE_LATITUDE).as_metadata()


class TestModelContext:
    def test_the_date_is_written_day_month_year_with_the_clock(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, when="2026:09:14 10:32:05", offset="+02:00"))
        assert facts.model_context() == "Aufgenommen am 14.09.2026 um 10:32 Uhr."

    def test_a_date_without_a_clock_is_written_without_one(self):
        assert PhotoFacts(captured_at="2026-09-14").model_context() == "Aufgenommen am 14.09.2026."

    def test_no_capture_time_means_no_context_even_with_a_position(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, gps=SITE_GPS, make="DJI", model="DJI Mavic 3"))
        assert facts.model_context() is None

    def test_the_context_never_carries_the_position(self, tmp_path):
        facts = read_photo_facts(_photo(tmp_path, when="2026:09:14 10:32:05", gps=SITE_GPS))
        assert facts.latitude is not None and facts.longitude is not None
        context = facts.model_context()
        assert context is not None
        assert str(facts.latitude) not in context
        assert str(facts.longitude) not in context
        assert "48.2094" not in context
        assert "16.3697" not in context
        # The date has two-digit fractions only; a coordinate has five or more.
        assert re.search(r"\d+\.\d{5,}", context) is None


class TestOwnerAndSerialStayInTheFile:
    def test_the_owner_name_and_body_serial_are_never_extracted(self, tmp_path):
        path = _photo(
            tmp_path,
            when="2026:09:14 10:32:05",
            make="DJI",
            model="DJI Mavic 3",
            owner="Max Mustermann",
            serial="SN-998877",
        )
        # The fixture really carries them, so the assertions below are not vacuous.
        written = Image.open(path).getexif().get_ifd(ExifTags.IFD.Exif)
        assert written[ExifTags.Base.CameraOwnerName] == "Max Mustermann"
        assert written[ExifTags.Base.BodySerialNumber] == "SN-998877"

        facts = read_photo_facts(path)
        surfaces = [repr(facts), str(facts.as_metadata()), str(facts.model_context())]
        for leaked in ("Max Mustermann", "Mustermann", "SN-998877", "998877"):
            assert not any(leaked in surface for surface in surfaces)
        assert facts.camera == "DJI Mavic 3"
