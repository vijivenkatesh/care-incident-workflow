// Types are generated from the OpenAPI contract (`npm run gen:api`), so the UI
// and the API can't drift apart silently: a contract change breaks the build.
import type { components } from './schema';

type Schemas = components['schemas'];
export type Incident = Schemas['Incident'];
export type IncidentInput = Schemas['IncidentInput'];
export type IncidentStatus = Schemas['IncidentStatus'];
export type Severity = Schemas['Severity'];
export type Action = Schemas['Action'];
export type ApiErrorBody = Schemas['Error'] & { errors?: string[] };

export type Role = 'staff' | 'supervisor' | 'compliance';

export interface IncidentApi {
  list(status?: IncidentStatus): Promise<Incident[]>;
  get(id: string): Promise<Incident>;
  create(input: IncidentInput): Promise<Incident>;
  update(id: string, input: IncidentInput): Promise<Incident>;
  transition(id: string, action: Action, comment?: string): Promise<Incident>;
}

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) {
    super(body.message);
  }
}

export const ACTION_LABELS: Record<Action, string> = {
  SUBMIT: 'Submit for review',
  START_REVIEW: 'Start review',
  APPROVE: 'Approve',
  RETURN: 'Return to staff',
  REPORT: 'Report to regulator',
  CLOSE: 'Close',
};

export const STATUS_COLOURS: Record<IncidentStatus, 'default' | 'info' | 'warning' | 'success' | 'error' | 'primary' | 'secondary'> = {
  DRAFT: 'default',
  SUBMITTED: 'info',
  UNDER_REVIEW: 'primary',
  RETURNED: 'warning',
  APPROVED: 'success',
  REPORTED: 'secondary',
  CLOSED: 'default',
};
