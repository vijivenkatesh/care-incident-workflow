"""Request validation (defence in depth: API Gateway also validates bodies
against the OpenAPI schema before the Lambda is invoked)."""
from __future__ import annotations

from datetime import datetime
from typing import Any

SEVERITIES = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}
ACTIONS = {"SUBMIT", "START_REVIEW", "APPROVE", "RETURN", "REPORT", "CLOSE"}
INCIDENT_FIELDS = {"title", "description", "severity", "occurredAt", "location"}


class ValidationError(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def _str(body: dict, key: str, lo: int, hi: int, errors: list[str], required: bool = True) -> None:
    value = body.get(key)
    if value is None:
        if required:
            errors.append(f"{key} is required")
        return
    if not isinstance(value, str) or not (lo <= len(value.strip()) <= hi):
        errors.append(f"{key} must be a string of {lo}-{hi} characters")


def validate_incident(body: Any) -> dict:
    if not isinstance(body, dict):
        raise ValidationError(["body must be a JSON object"])
    errors: list[str] = []
    unknown = set(body) - INCIDENT_FIELDS
    if unknown:
        errors.append(f"unknown fields: {', '.join(sorted(unknown))}")
    _str(body, "title", 3, 120, errors)
    _str(body, "description", 10, 4000, errors)
    _str(body, "location", 0, 200, errors, required=False)
    if body.get("severity") not in SEVERITIES:
        errors.append(f"severity must be one of {sorted(SEVERITIES)}")
    occurred = body.get("occurredAt")
    try:
        parsed = datetime.fromisoformat(str(occurred).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            errors.append("occurredAt must include a timezone")
    except ValueError:
        errors.append("occurredAt must be an ISO-8601 date-time")
    if errors:
        raise ValidationError(errors)
    return {k: body[k].strip() if isinstance(body[k], str) else body[k] for k in INCIDENT_FIELDS if k in body}


def validate_transition(body: Any) -> tuple[str, str | None]:
    if not isinstance(body, dict):
        raise ValidationError(["body must be a JSON object"])
    action = body.get("action")
    comment = body.get("comment")
    errors = []
    if action not in ACTIONS:
        errors.append(f"action must be one of {sorted(ACTIONS)}")
    if comment is not None and (not isinstance(comment, str) or len(comment) > 1000):
        errors.append("comment must be a string of at most 1000 characters")
    if errors:
        raise ValidationError(errors)
    return action, comment
