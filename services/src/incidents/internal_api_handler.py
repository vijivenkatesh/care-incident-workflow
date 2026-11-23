"""Private internal API (API Gateway PRIVATE endpoint, IAM/SigV4 auth).

Reachable only from inside the VPC through the execute-api interface endpoint,
and only by principals the resource policy and IAM allow. Used for
service-to-service calls (the regulator Lambda), never by browsers.
"""
from __future__ import annotations

import json
from typing import Any

from . import observability as obs
from .repository import DynamoIncidentRepository

_repo = None


def summary(item: dict) -> dict:
    """Only the fields a regulator submission needs: least privilege on data too."""
    return {
        "incidentId": item["id"],
        "title": item["title"],
        "severity": item["severity"],
        "occurredAt": item["occurredAt"],
        "location": item.get("location"),
        "description": item["description"],
        "approvedBy": next((h["by"] for h in reversed(item["history"]) if h["action"] == "APPROVE"), None),
        "status": item["status"],
    }


def lambda_handler(event: dict, context: Any) -> dict:
    global _repo
    _repo = _repo or DynamoIncidentRepository()
    caller_arn = (event.get("requestContext", {}).get("identity") or {}).get("userArn")
    obs.set_correlation_id((event.get("headers") or {}).get("x-correlation-id"))
    incident_id = (event.get("pathParameters") or {}).get("incidentId")
    item = _repo.get(incident_id) if incident_id else None
    obs.info("internal summary requested", caller=caller_arn, incidentId=incident_id, found=bool(item))
    if not item:
        return {"statusCode": 404, "body": json.dumps({"code": "NOT_FOUND", "message": "Incident not found"})}
    return {"statusCode": 200, "headers": {"Content-Type": "application/json"}, "body": json.dumps(summary(item))}
