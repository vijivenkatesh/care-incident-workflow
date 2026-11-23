"""Audit consumer: EventBridge -> SQS -> this Lambda -> DynamoDB audit table.

Uses SQS partial batch responses so one bad message is retried (and finally
sent to the DLQ) without re-processing the rest of the batch. Writes are
idempotent (conditional on the event id), so redelivery is safe.
"""
from __future__ import annotations

import json
import os
from typing import Any

from . import observability as obs

_table = None


def _audit_table():
    global _table
    if _table is None:
        import boto3

        _table = boto3.resource("dynamodb").Table(os.environ["AUDIT_TABLE_NAME"])
    return _table


def to_audit_record(message_body: str) -> dict:
    envelope = json.loads(message_body)  # the EventBridge event, delivered as the SQS body
    detail = envelope["detail"]
    return {
        "incidentId": detail["incidentId"],
        "sk": f"{detail['at']}#{envelope['id']}",
        "eventId": envelope["id"],
        "action": detail["action"],
        "from": detail.get("previousStatus") or "-",
        "to": detail["status"],
        "actor": detail["actor"],
        "comment": detail.get("comment"),
        "correlationId": detail.get("correlationId"),
        "recordedAt": envelope["time"],
    }


def process(records: list[dict], write) -> dict:
    failures = []
    for record in records:
        try:
            audit = to_audit_record(record["body"])
            obs.set_correlation_id(audit["correlationId"])
            write(audit)
            obs.info("audit recorded", incidentId=audit["incidentId"], action=audit["action"])
        except Exception as exc:  # noqa: BLE001
            obs.error("audit failed", messageId=record.get("messageId"), error=str(exc))
            failures.append({"itemIdentifier": record["messageId"]})
    obs.metric("AuditRecordsFailed", len(failures))
    return {"batchItemFailures": failures}


def _write(audit: dict) -> None:
    from botocore.exceptions import ClientError

    try:
        _audit_table().put_item(Item={k: v for k, v in audit.items() if v is not None},
                                ConditionExpression="attribute_not_exists(sk)")
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise  # duplicate delivery is fine; anything else is retried


def lambda_handler(event: dict, context: Any) -> dict:
    return process(event.get("Records", []), _write)
