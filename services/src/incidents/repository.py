"""DynamoDB persistence with optimistic locking.

Table design (single table, partition key `id`):
  - GSI `byOwner`  : createdBy + updatedAt  (staff list their own incidents)
  - GSI `byStatus` : status + updatedAt     (supervisor / compliance work queues)
"""
from __future__ import annotations

import os
from decimal import Decimal
from typing import Any, Protocol


class ConflictError(Exception):
    """The item changed since it was read (version mismatch)."""


class IncidentRepository(Protocol):
    def get(self, incident_id: str) -> dict | None: ...
    def put(self, item: dict, expected_version: int | None) -> None: ...
    def list_by_owner(self, owner: str) -> list[dict]: ...
    def list_by_status(self, status: str) -> list[dict]: ...
    def set_regulator_reference(self, incident_id: str, reference: str) -> None: ...


def _plain(value: Any) -> Any:
    """Convert DynamoDB Decimals back to ints/floats for JSON."""
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


class DynamoIncidentRepository:
    def __init__(self, table_name: str | None = None, resource: Any = None):
        import boto3  # available in the Lambda runtime
        from boto3.dynamodb.conditions import Key

        self._key = Key
        self._table = (resource or boto3.resource("dynamodb")).Table(table_name or os.environ["TABLE_NAME"])

    def get(self, incident_id: str) -> dict | None:
        item = self._table.get_item(Key={"id": incident_id}, ConsistentRead=True).get("Item")
        return _plain(item) if item else None

    def put(self, item: dict, expected_version: int | None) -> None:
        from botocore.exceptions import ClientError

        kwargs: dict[str, Any] = {"Item": item}
        if expected_version is None:
            kwargs["ConditionExpression"] = "attribute_not_exists(id)"
        else:
            kwargs["ConditionExpression"] = "#v = :v"
            kwargs["ExpressionAttributeNames"] = {"#v": "version"}
            kwargs["ExpressionAttributeValues"] = {":v": expected_version}
        try:
            self._table.put_item(**kwargs)
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise ConflictError(item["id"]) from exc
            raise

    def _query(self, index: str, key: str, value: str) -> list[dict]:
        items: list[dict] = []
        kwargs: dict[str, Any] = {
            "IndexName": index,
            "KeyConditionExpression": self._key(key).eq(value),
            "ScanIndexForward": False,
        }
        while True:
            page = self._table.query(**kwargs)
            items.extend(page.get("Items", []))
            if "LastEvaluatedKey" not in page or len(items) >= 200:
                return [_plain(i) for i in items]
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def list_by_owner(self, owner: str) -> list[dict]:
        return self._query("byOwner", "createdBy", owner)

    def list_by_status(self, status: str) -> list[dict]:
        return self._query("byStatus", "status", status)

    def set_regulator_reference(self, incident_id: str, reference: str) -> None:
        self._table.update_item(
            Key={"id": incident_id},
            UpdateExpression="SET regulatorReference = :r",
            ConditionExpression="attribute_exists(id)",
            ExpressionAttributeValues={":r": reference},
        )


class InMemoryIncidentRepository:
    """Test double with the same semantics as the DynamoDB repository."""

    def __init__(self) -> None:
        self.items: dict[str, dict] = {}

    def get(self, incident_id: str) -> dict | None:
        item = self.items.get(incident_id)
        return dict(item) if item else None

    def put(self, item: dict, expected_version: int | None) -> None:
        current = self.items.get(item["id"])
        if expected_version is None and current is not None:
            raise ConflictError(item["id"])
        if expected_version is not None and (current is None or current["version"] != expected_version):
            raise ConflictError(item["id"])
        self.items[item["id"]] = dict(item)

    def _newest_first(self, items) -> list[dict]:
        return sorted(items, key=lambda i: i["updatedAt"], reverse=True)

    def list_by_owner(self, owner: str) -> list[dict]:
        return self._newest_first(i for i in self.items.values() if i["createdBy"] == owner)

    def list_by_status(self, status: str) -> list[dict]:
        return self._newest_first(i for i in self.items.values() if i["status"] == status)

    def set_regulator_reference(self, incident_id: str, reference: str) -> None:
        self.items[incident_id]["regulatorReference"] = reference
