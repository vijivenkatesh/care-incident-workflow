"""Structured JSON logging and CloudWatch Embedded Metric Format (EMF) metrics.

No third-party dependencies: every log line is one JSON object that CloudWatch
Logs Insights can query, and metrics are emitted as EMF log lines, which
CloudWatch turns into custom metrics without any PutMetricData calls.
"""
from __future__ import annotations

import json
import os
import sys
import time
from contextvars import ContextVar
from typing import Any

SERVICE = os.environ.get("SERVICE_NAME", "care-incident-workflow")
NAMESPACE = os.environ.get("METRICS_NAMESPACE", "CareIncidentWorkflow")

_correlation_id: ContextVar[str] = ContextVar("correlation_id", default="-")


def set_correlation_id(value: str | None) -> None:
    _correlation_id.set(value or "-")


def correlation_id() -> str:
    return _correlation_id.get()


def log(level: str, message: str, **fields: Any) -> None:
    record = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
        "level": level,
        "service": SERVICE,
        "message": message,
        "correlationId": correlation_id(),
        "xrayTraceId": os.environ.get("_X_AMZN_TRACE_ID"),
        **fields,
    }
    sys.stdout.write(json.dumps(record, default=str) + "\n")


def info(message: str, **fields: Any) -> None:
    log("INFO", message, **fields)


def warn(message: str, **fields: Any) -> None:
    log("WARN", message, **fields)


def error(message: str, **fields: Any) -> None:
    log("ERROR", message, **fields)


def metric(name: str, value: float = 1, unit: str = "Count", **dimensions: str) -> None:
    dims = {"Service": SERVICE, **dimensions}
    payload = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": NAMESPACE,
                    "Dimensions": [list(dims.keys())],
                    "Metrics": [{"Name": name, "Unit": unit}],
                }
            ],
        },
        **dims,
        name: value,
    }
    sys.stdout.write(json.dumps(payload) + "\n")
