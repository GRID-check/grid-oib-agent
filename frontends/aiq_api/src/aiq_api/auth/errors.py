"""Auth-related exception types."""


class AuthError(Exception):
    """Raised when a request fails due to authentication or authorization issues.

    Agent nodes catch this before the generic Exception handler and return
    str(e) directly to the user. Subclass this for specific auth failure modes
    (e.g. missing token, expired token, insufficient permissions) to ensure
    actionable error messages reach the caller rather than a generic fallback.
    """

    error_code: str = "auth_error"


class TokenExpiredError(AuthError):
    """Token signature is valid but the ``exp`` claim has passed."""

    error_code = "token_expired"


class TokenInvalidError(AuthError):
    """Token is malformed, has an invalid signature, or fails claim checks."""

    error_code = "token_invalid"
