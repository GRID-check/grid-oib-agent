"""Reading Outlook archives (.pst, .ost) for the BFF's mail import (ADR-0085).

The BFF owns the import: who may run it, where the mails land, and the job that
walks the archive. This package owns the one thing the BFF cannot do in Node,
reading the archive's MAPI structure, through libpff (``libpff-python``). The
archive never leaves object storage: :mod:`.remote_file` reads it by range, so a
twenty-gigabyte file costs the bytes a slice touches, not a download.
"""
