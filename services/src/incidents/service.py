"""Application service: workflow rules + persistence + events."""
from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import UTC, datetime

from . import workflow
from .events import EventPublisher
from .repository import ConflictError, IncidentRepository
from .workflow import Caller, WorkflowError

VISIBLE_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "RETURNED", "APPROVED", "REPORTED", "CLOSED"]


class NotFound(Exception):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


class IncidentService:
    def __init__(self, repo: IncidentRepository, events: EventPublisher,
                 clock: Callable[[], str] = _now, new_id: Callable[[], str] = lambda: str(uuid.uuid4())):
        self.repo = repo
        self.events = events
        self.clock = clock
        self.new_id = new_id

    # --- views -----------------------------------------------------------
    def view(self, item: dict, caller: Caller) -> dict:
        return {
            **item,
            "allowedActions": workflow.allowed_actions(item["status"], item["createdBy"], caller),
            "canEdit": workflow.can_edit(item["status"], item["createdBy"], caller),
        }

    def _load_visible(self, incident_id: str, caller: Caller) -> dict:
        item = self.repo.get(incident_id)
        # Return 404 rather than 403 for incidents the caller may not see, so ids can't be probed.
        if not item or not workflow.can_view(item["status"], item["createdBy"], caller):
            raise NotFound(incident_id)
        return item

    # --- queries ---------------------------------------------------------
    def get(self, incident_id: str, caller: Caller) -> dict:
        return self.view(self._load_visible(incident_id, caller), caller)

    def list(self, caller: Caller, status: str | None = None) -> list[dict]:
        found: dict[str, dict] = {}
        if workflow.STAFF in caller.roles:
            for i in self.repo.list_by_owner(caller.user_id):
                found[i["id"]] = i
        if caller.roles & {workflow.SUPERVISOR, workflow.COMPLIANCE}:
            for s in ([status] if status else VISIBLE_STATUSES):
                for i in self.repo.list_by_status(s):
                    found[i["id"]] = i
        items = [i for i in found.values()
                 if workflow.can_view(i["status"], i["createdBy"], caller) and (not status or i["status"] == status)]
        items.sort(key=lambda i: i["updatedAt"], reverse=True)
        return [self.view(i, caller) for i in items]

    # --- commands --------------------------------------------------------
    def create(self, data: dict, caller: Caller, correlation_id: str) -> dict:
        if workflow.STAFF not in caller.roles:
            raise WorkflowError("FORBIDDEN", "Only staff can create incidents")
        now = self.clock()
        item = {
            **data,
            "id": self.new_id(),
            "status": "DRAFT",
            "createdBy": caller.user_id,
            "createdAt": now,
            "updatedAt": now,
            "version": 1,
            "history": [{"at": now, "by": caller.user_id, "action": "CREATE", "from": "-", "to": "DRAFT"}],
        }
        self.repo.put(item, expected_version=None)
        self.events.status_changed(item, None, "CREATE", caller.user_id, None, correlation_id)
        return self.view(item, caller)

    def update(self, incident_id: str, data: dict, caller: Caller) -> dict:
        item = self._load_visible(incident_id, caller)
        if not workflow.can_edit(item["status"], item["createdBy"], caller):
            raise WorkflowError("FORBIDDEN", "Only the owner can edit a draft or returned incident")
        updated = {**item, **data, "updatedAt": self.clock(), "version": item["version"] + 1}
        self.repo.put(updated, expected_version=item["version"])
        return self.view(updated, caller)

    def transition(self, incident_id: str, action: str, comment: str | None, caller: Caller,
                   correlation_id: str) -> dict:
        item = self._load_visible(incident_id, caller)
        t = workflow.resolve(item["status"], action, item["createdBy"], caller, comment)
        now = self.clock()
        entry = {"at": now, "by": caller.user_id, "action": action, "from": t.source, "to": t.target}
        if comment:
            entry["comment"] = comment
        updated = {**item, "status": t.target, "updatedAt": now, "version": item["version"] + 1,
                   "history": [*item["history"], entry]}
        self.repo.put(updated, expected_version=item["version"])
        self.events.status_changed(updated, t.source, action, caller.user_id, comment, correlation_id)
        return self.view(updated, caller)


__all__ = ["IncidentService", "NotFound", "ConflictError", "WorkflowError"]
