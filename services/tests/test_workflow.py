import pytest

from incidents.workflow import Caller, WorkflowError, allowed_actions, can_edit, can_view, resolve

STAFF = Caller.from_groups("sam@example.org", ["staff"])
OTHER_STAFF = Caller.from_groups("alex@example.org", ["staff"])
SUPERVISOR = Caller.from_groups("sup@example.org", ["supervisor"])
COMPLIANCE = Caller.from_groups("comp@example.org", ["compliance"])
OWNER = "sam@example.org"


def test_unknown_groups_are_ignored():
    assert Caller.from_groups("x", ["staff", "admin"]).roles == {"staff"}


@pytest.mark.parametrize("status,caller,expected", [
    ("DRAFT", STAFF, ["SUBMIT"]),
    ("DRAFT", OTHER_STAFF, []),
    ("SUBMITTED", SUPERVISOR, ["START_REVIEW"]),
    ("UNDER_REVIEW", SUPERVISOR, ["APPROVE", "RETURN"]),
    ("UNDER_REVIEW", STAFF, []),
    ("RETURNED", STAFF, ["SUBMIT"]),
    ("APPROVED", COMPLIANCE, ["REPORT"]),
    ("APPROVED", SUPERVISOR, []),
    ("REPORTED", COMPLIANCE, ["CLOSE"]),
    ("CLOSED", COMPLIANCE, []),
])
def test_allowed_actions(status, caller, expected):
    assert allowed_actions(status, OWNER, caller) == expected


def test_return_requires_comment():
    with pytest.raises(WorkflowError) as exc:
        resolve("UNDER_REVIEW", "RETURN", OWNER, SUPERVISOR, "  ")
    assert exc.value.code == "COMMENT_REQUIRED"
    assert resolve("UNDER_REVIEW", "RETURN", OWNER, SUPERVISOR, "Add witness details").target == "RETURNED"


def test_invalid_and_forbidden_transitions():
    with pytest.raises(WorkflowError) as exc:
        resolve("DRAFT", "APPROVE", OWNER, SUPERVISOR, None)
    assert exc.value.code == "INVALID_TRANSITION"
    with pytest.raises(WorkflowError) as exc:
        resolve("DRAFT", "SUBMIT", OWNER, OTHER_STAFF, None)
    assert exc.value.code == "FORBIDDEN"


def test_visibility_and_editing():
    assert can_view("DRAFT", OWNER, STAFF)
    assert not can_view("DRAFT", OWNER, SUPERVISOR)
    assert can_view("SUBMITTED", OWNER, SUPERVISOR)
    assert not can_view("SUBMITTED", OWNER, COMPLIANCE)
    assert can_view("APPROVED", OWNER, COMPLIANCE)
    assert can_edit("RETURNED", OWNER, STAFF)
    assert not can_edit("SUBMITTED", OWNER, STAFF)
    assert not can_edit("DRAFT", OWNER, OTHER_STAFF)
