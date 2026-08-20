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

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
      // Same-origin through the proxy, but explicit: without it the session cookie is not sent.
      credentials: 'same-origin',
    });
  } catch {
    throw new ServiceUnreachableError();
  }

  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new AuthError(body.error ?? `Request failed (${response.status})`, response.status);
  }
  return body as T;
}

/** Who is signed in, or null. Also the liveness check for the service. */
export async function fetchCurrentUser(): Promise<User | null> {
  const { user } = await call<{ user: User | null }>('/auth/me');
  return user;
}

export async function register(
  email: string,
  password: string,
  displayName: string,
): Promise<User> {
  const { user } = await call<{ user: User }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName }),
  });
  return user;
}

export async function login(email: string, password: string): Promise<User> {
  const { user } = await call<{ user: User }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return user;
}

export async function logout(): Promise<void> {
  await call('/auth/logout', { method: 'POST' });
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const { projects } = await call<{ projects: ProjectSummary[] }>('/projects');
  return projects;
}

export async function loadProject(id: string): Promise<{ name: string; document: unknown }> {
  const { project } = await call<{ project: { name: string; document: string } }>(`/projects/${id}`);
  return { name: project.name, document: JSON.parse(project.document) };
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
