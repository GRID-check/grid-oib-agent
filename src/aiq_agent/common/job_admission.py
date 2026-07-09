"""Admission-control error for async job submission.

Lives in ``aiq_agent.common`` (not ``aiq_api``) so the chat agent can catch it
without importing the API plugin package.
"""

from __future__ import annotations


class JobAdmissionError(RuntimeError):
    """Raised when async job submission is refused by admission control.

    The submission was not persisted; the caller may retry after
    ``retry_after_seconds``.
    """

    def __init__(self, message: str, retry_after_seconds: int = 30):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds
