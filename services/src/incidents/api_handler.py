"""Public REST API Lambda (API Gateway REST API, Lambda proxy integration).

Authentication is done by the API Gateway Cognito authorizer before this runs;
the verified JWT claims arrive in requestContext.authorizer.claims.
"""
from __future__ import annotations

import json
import os
from collections.abc import Callable
from typing import Any

from . import observability as obs
from .events import EventBridgePublisher
from .repository import ConflictError, DynamoIncidentRepository
from .service import IncidentService, NotFound
from .validation import ValidationError, validate_incident, validate_transition
from .workflow import Caller, WorkflowError

ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

_service: IncidentService | None = None


def _get_service() -> IncidentService:
    global _service
    if _service is None:  # created once per execution environment, reused across invocations
        _service = IncidentService(DynamoIncidentRepository(), EventBridgePublisher())
    return _service


def _response(status: int, body: Any) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "X-Correlation-Id": obs.correlation_id(),
        },
        "body": json.dumps(body),
    }


def _error(status: int, code: str, message: str, **extra: Any) -> dict:
    return _response(status, {"code": code, "message": message, "correlationId": obs.correlation_id(), **extra})


def caller_from_event(event: dict) -> Caller:
    claims = (event.get("requestContext", {}).get("authorizer") or {}).get("claims") or {}
    groups = claims.get("cognito:groups") or ""
    # API Gateway passes list claims as a string like "[staff, supervisor]" or "staff,supervisor".
    if isinstance(groups, str):
        groups = [g.strip(" []") for g in groups.replace(",", " ").split()]
    user = claims.get("email") or claims.get("cognito:username") or claims.get("sub")
    if not user:
        raise PermissionError("missing identity claims")
    return Caller.from_groups(user, groups)


WORKFLOW_STATUS = {"FORBIDDEN": 403, "INVALID_TRANSITION": 409, "COMMENT_REQUIRED": 400}


def handle(event: dict, service: IncidentService) -> dict:
    method = event.get("httpMethod")
    resource = event.get("resource")
    params = event.get("pathParameters") or {}
    query = event.get("queryStringParameters") or {}
    cid = obs.correlation_id()

    try:
        caller = caller_from_event(event)
        body = json.loads(event["body"]) if event.get("body") else None

        route: dict[tuple[str, str], Callable[[], dict]] = {
            ("GET", "/incidents"): lambda: _response(200, {"items": service.list(caller, query.get("status"))}),
            ("POST", "/incidents"): lambda: _response(201, service.create(validate_incident(body), caller, cid)),
            ("GET", "/incidents/{incidentId}"): lambda: _response(200, service.get(params["incidentId"], caller)),
            ("PUT", "/incidents/{incidentId}"): lambda: _response(
                200, service.update(params["incidentId"], validate_incident(body), caller)),
            ("POST", "/incidents/{incidentId}/transitions"): lambda: _response(
                200, service.transition(params["incidentId"], *validate_transition(body), caller, cid)),
        }
        handler = route.get((method, resource))
        if handler is None:
            return _error(404, "NOT_FOUND", f"No route for {method} {resource}")
        result = handler()
        obs.info("request handled", method=method, resource=resource, status=result["statusCode"],
                 user=caller.user_id, roles=sorted(caller.roles))
        return result
    except json.JSONDecodeError:
        return _error(400, "INVALID_JSON", "Request body is not valid JSON")
    except ValidationError as exc:
        return _error(400, "VALIDATION_FAILED", "Request is invalid", errors=exc.errors)
    except PermissionError as exc:
        return _error(401, "UNAUTHENTICATED", str(exc))
    except NotFound:
        return _error(404, "NOT_FOUND", "Incident not found")
    except ConflictError:
        return _error(409, "CONFLICT", "Incident was changed by someone else; reload and try again")
    except WorkflowError as exc:
        obs.warn("workflow rejected", code=exc.code, detail=exc.message)
        obs.metric("WorkflowRejected", Code=exc.code)
        return _error(WORKFLOW_STATUS.get(exc.code, 400), exc.code, exc.message)
    except Exception:  # noqa: BLE001 - last-resort handler; details go to logs only
        import traceback

        obs.error("unhandled error", method=method, resource=resource, trace=traceback.format_exc())
        obs.metric("UnhandledError")
        return _error(500, "INTERNAL", "Something went wrong")


def lambda_handler(event: dict, context: Any) -> dict:
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    obs.set_correlation_id(headers.get("x-correlation-id") or event.get("requestContext", {}).get("requestId"))
    return handle(event, _get_service())
