"""Regulator submission: EventBridge (status REPORTED) -> SQS -> this Lambda.

1. Reads config from SSM Parameter Store and the regulator API key from
   Secrets Manager (both cached per execution environment).
2. Calls the PRIVATE internal API with a SigV4-signed request
   (service-to-service, IAM auth, never leaves the VPC).
3. Submits to the regulator endpoint. When the endpoint parameter is `mock`
   (the default) it generates a reference instead of calling out.
4. Stores the regulator reference on the incident.
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from typing import Any

from . import observability as obs
from .repository import DynamoIncidentRepository

_cache: dict[str, Any] = {}


def _config() -> dict:
    if "config" not in _cache:
        import boto3

        ssm = boto3.client("ssm")
        endpoint = ssm.get_parameter(Name=os.environ["REGULATOR_ENDPOINT_PARAM"])["Parameter"]["Value"]
        secret = boto3.client("secretsmanager").get_secret_value(SecretId=os.environ["REGULATOR_SECRET_ARN"])
        _cache["config"] = {"endpoint": endpoint, "apiKey": json.loads(secret["SecretString"])["apiKey"]}
    return _cache["config"]


def signed_get(url: str, correlation_id: str) -> dict:
    """GET with AWS SigV4 using the Lambda's own role credentials (botocore ships in the runtime)."""
    import boto3
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    session = boto3.Session()
    request = AWSRequest(method="GET", url=url, headers={"x-correlation-id": correlation_id})
    SigV4Auth(session.get_credentials(), "execute-api", session.region_name).add_auth(request)
    with urllib.request.urlopen(urllib.request.Request(url, headers=dict(request.headers)), timeout=5) as resp:
        return json.loads(resp.read())


def submit_to_regulator(endpoint: str, api_key: str, summary: dict) -> str:
    if endpoint == "mock":
        return "REG-" + hashlib.sha256(summary["incidentId"].encode()).hexdigest()[:10].upper()
    req = urllib.request.Request(
        endpoint, data=json.dumps(summary).encode(), method="POST",
        headers={"Content-Type": "application/json", "x-api-key": api_key},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())["reference"]


def handle_record(record: dict, repo, fetch_summary, submit) -> None:
    detail = json.loads(record["body"])["detail"]
    obs.set_correlation_id(detail.get("correlationId"))
    summary = fetch_summary(detail["incidentId"])
    reference = submit(summary)
    repo.set_regulator_reference(detail["incidentId"], reference)
    obs.info("submitted to regulator", incidentId=detail["incidentId"], reference=reference)
    obs.metric("RegulatorSubmissions")


def lambda_handler(event: dict, context: Any) -> dict:
    repo = DynamoIncidentRepository()
    base = os.environ["INTERNAL_API_URL"].rstrip("/")
    failures = []

    def fetch_summary(incident_id: str) -> dict:
        return signed_get(f"{base}/internal/incidents/{incident_id}/summary", obs.correlation_id())

    def submit(summary: dict) -> str:
        cfg = _config()
        return submit_to_regulator(cfg["endpoint"], cfg["apiKey"], summary)

    for record in event.get("Records", []):
        try:
            handle_record(record, repo, fetch_summary=fetch_summary, submit=submit)
        except Exception as exc:  # noqa: BLE001
            obs.error("regulator submission failed", messageId=record.get("messageId"), error=str(exc))
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}
