import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { HttpIncidentApi } from './api/httpClient';
import { MockIncidentApi, type MockUser } from './api/mockClient';
import type { IncidentApi, Role } from './api/types';

export interface AppConfig {
  mode: 'mock' | 'aws';
  apiUrl?: string;
  authority?: string;
  clientId?: string;
  logoutUrl?: string;
}

export interface SessionUser { id: string; name: string; roles: Role[] }

export interface Session {
  user: SessionUser;
  api: IncidentApi;
  signOut(): void;
  /** Demo mode only: switch between seeded users to walk the workflow as each role. */
  demo?: { users: MockUser[]; switchTo(id: string): void };
}

export const DEMO_USERS: MockUser[] = [
  { id: 'sam.staff@example.org', name: 'Sam (Staff)', roles: ['staff'] },
  { id: 'alex.staff@example.org', name: 'Alex (Staff)', roles: ['staff'] },
  { id: 'priya.supervisor@example.org', name: 'Priya (Supervisor)', roles: ['supervisor'] },
  { id: 'chris.compliance@example.org', name: 'Chris (Compliance)', roles: ['compliance'] },
];

export function createDemoSession(onChange: (s: Session) => void, initial = DEMO_USERS[0]): Session {
  let current = initial;
  const api = new MockIncidentApi(() => current);
  const build = (): Session => ({
    user: current,
    api,
    signOut: () => undefined,
    demo: {
      users: DEMO_USERS,
      switchTo: (id) => {
        current = DEMO_USERS.find((u) => u.id === id) ?? current;
        onChange(build());
      },
    },
  });
  return build();
}

/** OIDC Authorization Code + PKCE against Cognito. Returns null while redirecting to sign in. */
export async function createAwsSession(config: AppConfig): Promise<Session | null> {
  const redirectUri = `${window.location.origin}/`;
  const manager = new UserManager({
    authority: config.authority!,
    client_id: config.clientId!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });

  if (new URLSearchParams(window.location.search).has('code')) {
    await manager.signinRedirectCallback();
    window.history.replaceState({}, document.title, '/');
  }
  let user = await manager.getUser();
  if (!user || user.expired) {
    await manager.signinRedirect();
    return null;
  }
  const groups = (user.profile['cognito:groups'] as string[] | undefined) ?? [];
  const roles = groups.filter((g): g is Role => ['staff', 'supervisor', 'compliance'].includes(g));
  const email = (user.profile.email as string) ?? user.profile.sub;

  return {
    user: { id: email, name: email, roles },
    api: new HttpIncidentApi(config.apiUrl!, async () => {
      user = (await manager.getUser()) ?? user;
      return user!.id_token!;
    }),
    signOut: () => {
      void manager.removeUser();
      const url = new URL(config.logoutUrl!);
      url.searchParams.set('client_id', config.clientId!);
      url.searchParams.set('logout_uri', redirectUri);
      window.location.assign(url.toString());
    },
  };
}
