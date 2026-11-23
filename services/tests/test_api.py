import json

import pytest

from incidents import audit_handler, internal_api_handler, regulator_handler
from incidents.api_handler import handle
from incidents.events import RecordingPublisher
from incidents.repository import InMemoryIncidentRepository
from incidents.service import IncidentService

VALID = {
    "title": "Client fall in kitchen",
    "description": "Client slipped on a wet floor and bruised their arm.",
    "severity": "HIGH",
    "occurredAt": "2026-11-20T09:30:00+10:00",
    "location": "Werribee day centre",
}


def event(method, resource, user, groups, body=None, incident_id=None, query=None):
    return {
        "httpMethod": method,
        "resource": resource,
        "pathParameters": {"incidentId": incident_id} if incident_id else None,
        "queryStringParameters": query,
        "body": json.dumps(body) if body is not None else None,
        "requestContext": {"requestId": "req-1",
                           "authorizer": {"claims": {"email": user, "cognito:groups": groups}}},
    }


@pytest.fixture
def svc():
    ticks = iter(f"2026-11-21T00:00:{s:02d}Z" for s in range(60))
    return IncidentService(InMemoryIncidentRepository(), RecordingPublisher(), clock=lambda: next(ticks),
                           new_id=lambda: "11111111-2222-3333-4444-555555555555")


def call(svc, *args, **kwargs):
    res = handle(event(*args, **kwargs), svc)
    return res["statusCode"], json.loads(res["body"])


def test_full_workflow(svc):
    status, inc = call(svc, "POST", "/incidents", "sam@example.org", "[staff]", VALID)
    assert status == 201 and inc["status"] == "DRAFT" and inc["allowedActions"] == ["SUBMIT"] and inc["canEdit"]
    iid = inc["id"]
    path = "/incidents/{incidentId}/transitions"

    assert call(svc, "POST", path, "sam@example.org", "staff", {"action": "SUBMIT"}, iid)[1]["status"] == "SUBMITTED"
    assert call(svc, "POST", path, "sup@example.org", "supervisor", {"action": "START_REVIEW"}, iid)[0] == 200
    status, body = call(svc, "POST", path, "sup@example.org", "supervisor", {"action": "RETURN"}, iid)
    assert status == 400 and body["code"] == "COMMENT_REQUIRED"
    _, inc = call(svc, "POST", path, "sup@example.org", "supervisor",
                  {"action": "RETURN", "comment": "Add witness names"}, iid)
    assert inc["status"] == "RETURNED"

    status, inc = call(svc, "PUT", "/incidents/{incidentId}", "sam@example.org", "staff",
                       {**VALID, "description": "Client slipped; witnessed by J. Smith and P. Lee."}, iid)
    assert status == 200 and inc["version"] == 5
    for user, groups, action in [("sam@example.org", "staff", "SUBMIT"),
                                 ("sup@example.org", "supervisor", "START_REVIEW"),
                                 ("sup@example.org", "supervisor", "APPROVE"),
                                 ("comp@example.org", "compliance", "REPORT")]:
        status, inc = call(svc, "POST", path, user, groups, {"action": action}, iid)
        assert status == 200, inc
    assert inc["status"] == "REPORTED" and inc["allowedActions"] == ["CLOSE"]
    assert [h["action"] for h in inc["history"]] == [
        "CREATE", "SUBMIT", "START_REVIEW", "RETURN", "SUBMIT", "START_REVIEW", "APPROVE", "REPORT"]
    assert [e["status"] for e in svc.events.events][-1] == "REPORTED"


def test_role_and_visibility_errors(svc):
    status, body = call(svc, "POST", "/incidents", "sup@example.org", "supervisor", VALID)
    assert status == 403 and body["code"] == "FORBIDDEN"
    _, inc = call(svc, "POST", "/incidents", "sam@example.org", "staff", VALID)
    # Supervisors can't see drafts: 404, not 403, so ids can't be probed.
    assert call(svc, "GET", "/incidents/{incidentId}", "sup@example.org", "supervisor", incident_id=inc["id"])[0] == 404
    status, body = call(svc, "POST", "/incidents/{incidentId}/transitions", "sam@example.org", "staff",
                        {"action": "APPROVE"}, inc["id"])
    assert status == 409 and body["code"] == "INVALID_TRANSITION"


def test_validation_and_auth(svc):
    status, body = call(svc, "POST", "/incidents", "sam@example.org", "staff", {"title": "x", "severity": "BAD"})
    assert status == 400 and body["code"] == "VALIDATION_FAILED" and len(body["errors"]) >= 3
    ev = event("GET", "/incidents", "x", "staff")
    ev["requestContext"]["authorizer"] = {"claims": {}}
    assert handle(ev, svc)["statusCode"] == 401


def test_list_respects_roles(svc):
    _, a = call(svc, "POST", "/incidents", "sam@example.org", "staff", VALID)
    assert len(call(svc, "GET", "/incidents", "sam@example.org", "staff")[1]["items"]) == 1
    assert call(svc, "GET", "/incidents", "sup@example.org", "supervisor")[1]["items"] == []
    call(svc, "POST", "/incidents/{incidentId}/transitions", "sam@example.org", "staff", {"action": "SUBMIT"}, a["id"])
    assert len(call(svc, "GET", "/incidents", "sup@example.org", "supervisor")[1]["items"]) == 1
    assert call(svc, "GET", "/incidents", "comp@example.org", "compliance")[1]["items"] == []


def sqs_record(detail, message_id="m1", event_id="e1"):
    return {"messageId": message_id,
            "body": json.dumps({"id": event_id, "time": "2026-11-21T00:00:00Z", "detail": detail})}


DETAIL = {"incidentId": "i1", "at": "2026-11-21T00:00:00Z", "action": "SUBMIT", "previousStatus": "DRAFT",
          "status": "SUBMITTED", "actor": "sam@example.org", "correlationId": "c1"}


def test_audit_partial_batch_failure():
    written = []
    result = audit_handler.process([sqs_record(DETAIL), {"messageId": "bad", "body": "not json"}], written.append)
    assert result == {"batchItemFailures": [{"itemIdentifier": "bad"}]}
    assert written[0]["sk"] == "2026-11-21T00:00:00Z#e1" and written[0]["to"] == "SUBMITTED"


def test_regulator_flow_and_internal_summary():
    repo = InMemoryIncidentRepository()
    item = {**VALID, "id": "i1", "status": "REPORTED", "createdBy": "sam@example.org", "createdAt": "t",
            "updatedAt": "t", "version": 9,
            "history": [{"at": "t", "by": "sup@example.org", "action": "APPROVE", "from": "UNDER_REVIEW",
                         "to": "APPROVED"}]}
    repo.put(item, None)
    summary = internal_api_handler.summary(item)
    assert summary["approvedBy"] == "sup@example.org" and "createdBy" not in summary
    regulator_handler.handle_record(
        sqs_record({**DETAIL, "status": "REPORTED"}), repo,
        fetch_summary=lambda iid: internal_api_handler.summary(repo.get(iid)),
        submit=lambda s: regulator_handler.submit_to_regulator("mock", "k", s))
    assert repo.get("i1")["regulatorReference"].startswith("REG-")
