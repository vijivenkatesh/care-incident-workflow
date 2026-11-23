"""Incident workflow: states, role-based transitions and visibility rules.

Pure Python with no AWS dependencies, so the business rules are unit-testable
and the API returns `allowedActions` computed here (the UI never hard-codes
who can do what).

    DRAFT --SUBMIT(staff,owner)--> SUBMITTED --START_REVIEW(supervisor)--> UNDER_REVIEW
    UNDER_REVIEW --APPROVE(supervisor)--> APPROVED --REPORT(compliance)--> REPORTED
    UNDER_REVIEW --RETURN(supervisor)--> RETURNED --SUBMIT(staff,owner)--> SUBMITTED
    REPORTED --CLOSE(compliance)--> CLOSED
"""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

STAFF = "staff"
SUPERVISOR = "supervisor"
COMPLIANCE = "compliance"
ROLES = {STAFF, SUPERVISOR, COMPLIANCE}

EDITABLE_STATES = {"DRAFT", "RETURNED"}


@dataclass(frozen=True)
class Transition:
    action: str
    source: str
    target: str
    role: str
    owner_only: bool = False
    comment_required: bool = False


TRANSITIONS: tuple[Transition, ...] = (
    Transition("SUBMIT", "DRAFT", "SUBMITTED", STAFF, owner_only=True),
    Transition("SUBMIT", "RETURNED", "SUBMITTED", STAFF, owner_only=True),
    Transition("START_REVIEW", "SUBMITTED", "UNDER_REVIEW", SUPERVISOR),
    Transition("APPROVE", "UNDER_REVIEW", "APPROVED", SUPERVISOR),
    Transition("RETURN", "UNDER_REVIEW", "RETURNED", SUPERVISOR, comment_required=True),
    Transition("REPORT", "APPROVED", "REPORTED", COMPLIANCE),
    Transition("CLOSE", "REPORTED", "CLOSED", COMPLIANCE),
)


class WorkflowError(Exception):
    """Raised when a transition is not allowed. `code` maps to an HTTP status."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Caller:
    user_id: str
    roles: frozenset[str]

    @staticmethod
    def from_groups(user_id: str, groups: Iterable[str]) -> Caller:
        return Caller(user_id, frozenset(g for g in groups if g in ROLES))


def _permitted(t: Transition, caller: Caller, owner: str) -> bool:
    if t.role not in caller.roles:
        return False
    if t.owner_only and caller.user_id != owner:
        return False
    return True


def allowed_actions(status: str, owner: str, caller: Caller) -> list[str]:
    return sorted({t.action for t in TRANSITIONS if t.source == status and _permitted(t, caller, owner)})


def can_edit(status: str, owner: str, caller: Caller) -> bool:
    return status in EDITABLE_STATES and STAFF in caller.roles and caller.user_id == owner


def can_view(status: str, owner: str, caller: Caller) -> bool:
    """Staff see their own incidents; supervisors see everything not in draft;
    compliance sees approved and later."""
    if caller.user_id == owner:
        return True
    if SUPERVISOR in caller.roles and status != "DRAFT":
        return True
    if COMPLIANCE in caller.roles and status in {"APPROVED", "REPORTED", "CLOSED"}:
        return True
    return False


def resolve(status: str, action: str, owner: str, caller: Caller, comment: str | None) -> Transition:
    candidates = [t for t in TRANSITIONS if t.action == action and t.source == status]
    if not candidates:
        raise WorkflowError("INVALID_TRANSITION", f"Cannot {action} an incident in {status}")
    for t in candidates:
        if _permitted(t, caller, owner):
            if t.comment_required and not (comment and comment.strip()):
                raise WorkflowError("COMMENT_REQUIRED", f"A comment is required to {action}")
            return t
    raise WorkflowError("FORBIDDEN", f"Your role cannot {action} this incident")
