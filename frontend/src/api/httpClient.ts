import { ApiError, type Action, type Incident, type IncidentApi, type IncidentInput, type IncidentStatus } from './types';

/** Calls the deployed REST API with the user's Cognito ID token (validated by the API Gateway authorizer). */
export class HttpIncidentApi implements IncidentApi {
  constructor(private baseUrl: string, private getToken: () => Promise<string>) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const correlationId = crypto.randomUUID();
    const res = await fetch(this.baseUrl.replace(/\/$/, '') + path, {
      method,
      headers: {
        Authorization: await this.getToken(),
        'Content-Type': 'application/json',
        'X-Correlation-Id': correlationId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ code: 'BAD_RESPONSE', message: res.statusText }));
    if (!res.ok) throw new ApiError(res.status, { correlationId, ...data });
    return data as T;
  }

  async list(status?: IncidentStatus) {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return (await this.request<{ items: Incident[] }>('GET', `/incidents${qs}`)).items;
  }
  get(id: string) {
    return this.request<Incident>('GET', `/incidents/${id}`);
  }
  create(input: IncidentInput) {
    return this.request<Incident>('POST', '/incidents', input);
  }
  update(id: string, input: IncidentInput) {
    return this.request<Incident>('PUT', `/incidents/${id}`, input);
  }
  transition(id: string, action: Action, comment?: string) {
    return this.request<Incident>('POST', `/incidents/${id}/transitions`, { action, ...(comment ? { comment } : {}) });
  }
}
