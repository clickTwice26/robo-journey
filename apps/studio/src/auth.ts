/**
 * Account API client.
 *
 * Every call is same-origin through the Vite proxy and carries the session cookie automatically.
 * Nothing here handles a password beyond passing it straight to the server: the browser never
 * hashes, never stores, and never logs one.
 */

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
}

/**
 * Where an account stands in the queue. Mirrors the server's `AccessStatus`.
 *
 * A place in line and nothing more. How many seats exist, how many are taken and how long the wait
 * might be are all absent on purpose -- see the note on the server's own type.
 */
export interface AccessStatus {
  readonly state: 'idle' | 'queued' | 'active' | 'cooldown';
  readonly position: number | null;
  readonly waiting: number;
  readonly expiresAt: string | null;
  readonly cooldownUntil: string | null;
  /** Why the last seat ended, so the queue screen can explain itself. */
  readonly lastReason: 'idle' | 'expired' | null;
  /** Time still owed from an interrupted session, carried back on re-admission. */
  readonly carriedMs: number | null;
}

export interface Session {
  readonly user: User | null;
  readonly access: AccessStatus | null;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class ServiceUnreachableError extends AuthError {
  constructor() {
    super(
      'Cannot reach the account service. Your work is still saved locally — start it with ' +
        '`npm run service` to sync to your account.',
      0,
    );
  }
}

/**
 * Refused because the account has no seat right now.
 *
 * Carries the access status the server sent with the refusal, so the app can go straight to
 * showing the queue rather than asking where it stands in a second request.
 */
export class NoAccessError extends AuthError {
  constructor(
    message: string,
    readonly access: AccessStatus | null,
  ) {
    super(message, 403);
    this.name = 'NoAccessError';
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      // Only when there is something to describe. Declaring JSON and then sending nothing is a
      // 400 from Fastify -- "body cannot be empty when content-type is set" -- which is exactly
      // what every bodyless POST here does: joining the queue, the heartbeat, signing out.
      headers: init.body === undefined ? { ...init.headers } : { 'Content-Type': 'application/json', ...init.headers },
      // Same-origin through the proxy, but explicit: without it the session cookie is not sent.
      credentials: 'same-origin',
    });
  } catch {
    throw new ServiceUnreachableError();
  }

  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    access?: AccessStatus;
  };
  if (!response.ok) {
    if (response.status === 403 && body.access) {
      throw new NoAccessError(body.error ?? 'No active session.', body.access);
    }
    throw new AuthError(body.error ?? `Request failed (${response.status})`, response.status);
  }
  return body as T;
}

/**
 * Who is signed in and where they stand, or nulls. Also the liveness check for the service.
 *
 * Both in one call because the app cannot decide what to render from either alone: an identity
 * without a seat means the queue, not the workspace.
 */
export async function fetchSession(): Promise<Session> {
  return call<Session>('/auth/me');
}

export async function register(
  email: string,
  password: string,
  displayName: string,
): Promise<Session> {
  return call<Session>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName }),
  });
}

export async function login(email: string, password: string): Promise<Session> {
  return call<Session>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

// --- Access -------------------------------------------------------------------------------------

/** Ask for a seat, or rejoin the queue after a cooldown. */
export async function requestAccess(): Promise<AccessStatus> {
  const { access } = await call<{ access: AccessStatus }>('/access', { method: 'POST' });
  return access;
}

/**
 * Say we are still here, and find out whether anything has changed.
 *
 * Doubles as the poll: it is how the app learns it has been admitted from the queue and how it
 * learns its hour is over, so there is nothing else to poll.
 */
export async function heartbeat(present: boolean): Promise<AccessStatus> {
  const { access } = await call<{ access: AccessStatus }>('/access/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ present }),
  });
  return access;
}

/** Give up a seat or a place in the queue. */
export async function releaseAccess(): Promise<AccessStatus> {
  const { access } = await call<{ access: AccessStatus }>('/access/release', { method: 'POST' });
  return access;
}

export async function logout(): Promise<void> {
  await call('/auth/logout', { method: 'POST' });
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const { projects } = await call<{ projects: ProjectSummary[] }>('/projects');
  return projects;
}

export async function loadProject(id: string): Promise<{ name: string; document: unknown }> {
  // The document arrives as a value, not as a string of JSON: the column is JSONB, so the server
  // never encodes it and there is nothing here to decode.
  const { project } = await call<{ project: { name: string; document: unknown } }>(`/projects/${id}`);
  return { name: project.name, document: project.document };
}

export async function createProject(name: string, document: unknown): Promise<ProjectSummary> {
  const { project } = await call<{ project: ProjectSummary }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ name, document }),
  });
  return project;
}

export async function saveProject(
  id: string,
  name: string,
  document: unknown,
): Promise<ProjectSummary> {
  const { project } = await call<{ project: ProjectSummary }>(`/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, document }),
  });
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  await call(`/projects/${id}`, { method: 'DELETE' });
}
