import { ApiError, type Action, type Incident, type IncidentApi, type IncidentInput, type IncidentStatus, type Role } from './types';

/**
 * In-browser stand-in for the API so the UI runs with no AWS account (`mode: "mock"`).
 * It mirrors services/src/incidents/workflow.py; in AWS mode the server is the only
 * source of truth and the UI just renders `allowedActions` from the response.
 */
interface Rule { action: Action; from: IncidentStatus; to: IncidentStatus; role: Role; ownerOnly?: boolean; comment?: boolean }

const RULES: Rule[] = [
  { action: 'SUBMIT', from: 'DRAFT', to: 'SUBMITTED', role: 'staff', ownerOnly: true },
  { action: 'SUBMIT', from: 'RETURNED', to: 'SUBMITTED', role: 'staff', ownerOnly: true },
  { action: 'START_REVIEW', from: 'SUBMITTED', to: 'UNDER_REVIEW', role: 'supervisor' },
  { action: 'APPROVE', from: 'UNDER_REVIEW', to: 'APPROVED', role: 'supervisor' },
  { action: 'RETURN', from: 'UNDER_REVIEW', to: 'RETURNED', role: 'supervisor', comment: true },
  { action: 'REPORT', from: 'APPROVED', to: 'REPORTED', role: 'compliance' },
  { action: 'CLOSE', from: 'REPORTED', to: 'CLOSED', role: 'compliance' },
];

export interface MockUser { id: string; name: string; roles: Role[] }

type Stored = Omit<Incident, 'allowedActions' | 'canEdit'>;

const permitted = (r: Rule, user: MockUser, owner: string) =>
  user.roles.includes(r.role) && (!r.ownerOnly || user.id === owner);

const canView = (i: Stored, user: MockUser) =>
  i.createdBy === user.id ||
  (user.roles.includes('supervisor') && i.status !== 'DRAFT') ||
  (user.roles.includes('compliance') && ['APPROVED', 'REPORTED', 'CLOSED'].includes(i.status));

export class MockIncidentApi implements IncidentApi {
  private items = new Map<string, Stored>();

  constructor(private currentUser: () => MockUser) {}

  private view(i: Stored): Incident {
    const user = this.currentUser();
    return {
      ...structuredClone(i),
      allowedActions: [...new Set(RULES.filter((r) => r.from === i.status && permitted(r, user, i.createdBy)).map((r) => r.action))].sort(),
      canEdit: ['DRAFT', 'RETURNED'].includes(i.status) && user.roles.includes('staff') && user.id === i.createdBy,
    };
  }

  private load(id: string): Stored {
    const i = this.items.get(id);
    if (!i || !canView(i, this.currentUser())) throw new ApiError(404, { code: 'NOT_FOUND', message: 'Incident not found' });
    return i;
  }

  async list(status?: IncidentStatus) {
    const user = this.currentUser();
    return [...this.items.values()]
      .filter((i) => canView(i, user) && (!status || i.status === status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((i) => this.view(i));
  }

  async get(id: string) {
    return this.view(this.load(id));
  }

  async create(input: IncidentInput) {
    const user = this.currentUser();
    if (!user.roles.includes('staff')) throw new ApiError(403, { code: 'FORBIDDEN', message: 'Only staff can create incidents' });
    const now = new Date().toISOString();
    const item: Stored = {
      ...input, id: crypto.randomUUID(), status: 'DRAFT', createdBy: user.id, createdAt: now, updatedAt: now, version: 1,
      history: [{ at: now, by: user.id, action: 'CREATE', from: '-', to: 'DRAFT' }],
    };
    this.items.set(item.id, item);
    return this.view(item);
  }

  async update(id: string, input: IncidentInput) {
    const i = this.load(id);
    if (!this.view(i).canEdit) throw new ApiError(403, { code: 'FORBIDDEN', message: 'Only the owner can edit a draft or returned incident' });
    const updated = { ...i, ...input, updatedAt: new Date().toISOString(), version: i.version + 1 };
    this.items.set(id, updated);
    return this.view(updated);
  }

  async transition(id: string, action: Action, comment?: string) {
    const i = this.load(id);
    const user = this.currentUser();
    const rule = RULES.find((r) => r.action === action && r.from === i.status && permitted(r, user, i.createdBy));
    if (!rule) throw new ApiError(409, { code: 'INVALID_TRANSITION', message: `Cannot ${action} an incident in ${i.status}` });
    if (rule.comment && !comment?.trim()) throw new ApiError(400, { code: 'COMMENT_REQUIRED', message: `A comment is required to ${action}` });
    const now = new Date().toISOString();
    const updated: Stored = {
      ...i, status: rule.to, updatedAt: now, version: i.version + 1,
      history: [...i.history, { at: now, by: user.id, action, from: rule.from, to: rule.to, ...(comment ? { comment } : {}) }],
      ...(rule.to === 'REPORTED' ? { regulatorReference: 'REG-' + id.slice(0, 8).toUpperCase() } : {}),
    };
    this.items.set(id, updated);
    return this.view(updated);
  }
}
