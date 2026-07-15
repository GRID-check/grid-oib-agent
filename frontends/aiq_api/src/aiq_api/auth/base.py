"""Abstract base for token validators.

Each identity provider implements TokenValidator and is registered
in plugin.py via AuthMiddleware(validators=[...]).  The middleware
itself has no knowledge of any specific provider.

Return contract
---------------
``validate()`` returns ``(user_dict, error_code)``:

- On success: ``(user_dict, None)`` where *user_dict* contains at least::

      {
          "type":            str,        # provider label
          "sub":             str | None, # subject identifier (username / user-id)
          "email":           str | None, # best-effort email, None if unavailable
          "name":            str | None, # display name, None if unavailable
          "token":           str,        # original raw token (forwarded to ECI etc.)
          "skip_clarifier":  bool,       # True for headless/service callers
      }

- On failure: ``(None, error_code)`` where *error_code* is one of
  ``"token_expired"``, ``"token_invalid"``, or a provider-specific string.
  The middleware surfaces this in the 401 JSON response.
"""

from abc import ABC
from abc import abstractmethod
from typing import Any


class TokenValidator(ABC):
    """Abstract token validator.  One implementation per identity provider."""

    @abstractmethod
    async def validate(self, token: str) -> tuple[dict[str, Any] | None, str | None]:
        """Validate *token* and return ``(user_dict, error_code)``.

        Returns ``(user_dict, None)`` on success.  On failure returns
        ``(None, error_code)`` where *error_code* is a machine-readable
        string (e.g. ``"token_expired"``, ``"token_invalid"``).
        """
        ...

    @abstractmethod
    def can_handle(self, token: str) -> bool:
        """Return ``True`` if this validator should attempt to validate *token*.

        Used as a fast pre-filter before the (potentially async) ``validate``
        call.  Implementations should check only token format / prefix — no
        network calls here.
        """
        ...
