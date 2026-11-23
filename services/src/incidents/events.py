"""Domain events published to a custom EventBridge bus.

Consumers (wired in CDK):
  - all status changes      -> SQS audit queue -> audit Lambda -> DynamoDB audit table
  - status REPORTED         -> SQS regulator queue -> regulator Lambda
  - HIGH/CRITICAL submitted, or RETURNED -> SNS notifications topic
"""
from __future__ import annotations

import json
import os
from typing import Any, Protocol

SOURCE = "care.incidents"
DETAIL_TYPE = "IncidentStatusChanged"


class EventPublisher(Protocol):
    def status_changed(self, incident: dict, previous: str | None, action: str, actor: str, comment: str | None,
                       correlation_id: str) -> None: ...


def build_detail(incident: dict, previous: str | None, action: str, actor: str, comment: str | None,
                 correlation_id: str) -> dict[str, Any]:
    return {
        "incidentId": incident["id"],
        "title": incident["title"],
        "severity": incident["severity"],
        "owner": incident["createdBy"],
        "previousStatus": previous,
        "status": incident["status"],
        "action": action,
        "actor": actor,
        "comment": comment,
        "version": incident["version"],
        "at": incident["updatedAt"],
        "correlationId": correlation_id,
    }


class EventBridgePublisher:
    def __init__(self, bus_name: str | None = None, client: Any = None):
        import boto3

        self._bus = bus_name or os.environ["EVENT_BUS_NAME"]
        self._client = client or boto3.client("events")

    def status_changed(self, incident, previous, action, actor, comment, correlation_id) -> None:
        detail = build_detail(incident, previous, action, actor, comment, correlation_id)
        result = self._client.put_events(
            Entries=[{"EventBusName": self._bus, "Source": SOURCE, "DetailType": DETAIL_TYPE,
                      "Detail": json.dumps(detail)}]
        )
        if result.get("FailedEntryCount"):
            raise RuntimeError(f"EventBridge rejected event: {result['Entries']}")


class RecordingPublisher:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def status_changed(self, incident, previous, action, actor, comment, correlation_id) -> None:
        self.events.append(build_detail(incident, previous, action, actor, comment, correlation_id))
