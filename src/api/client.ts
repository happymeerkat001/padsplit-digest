import { logger } from '../utils/logger.js';

const BASE_URL = 'https://www.padsplit.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_REFERER = 'https://www.padsplit.com/host/communication';
const REQUEST_TIMEOUT_MS = 30_000;

interface GraphqlBody {
  operationName: string;
  query: string;
  variables?: Record<string, unknown>;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export class AuthError extends Error {
  override name = 'AuthError';
}

export class SchemaError extends Error {
  override name = 'SchemaError';
}

export class DataIntegrityError extends Error {
  override name = 'DataIntegrityError';
}

export function getSessionCookie(): string {
  const cookie = (process.env['PADSPLIT_COOKIE'] ?? '').trim();
  if (!cookie) {
    throw new AuthError('PADSPLIT_COOKIE is missing');
  }
  return cookie;
}

function buildHeaders(): {
  headers: HeadersInit;
  headerStrategy: 'csrf-augmented';
  csrfRequired: boolean;
} {
  const cookie = getSessionCookie();
  const csrfMatch = cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  const csrfToken = csrfMatch?.[1] ?? '';

  return {
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRFToken': csrfToken,
      Origin: BASE_URL,
      Referer: DEFAULT_REFERER,
      'User-Agent': USER_AGENT,
    },
    headerStrategy: 'csrf-augmented',
    csrfRequired: csrfToken.length > 0,
  };
}

async function parseJsonOrSnippet(response: Response): Promise<{ data: unknown; snippet: string }> {
  const text = await response.text();
  const snippet = text.slice(0, 400);

  try {
    return { data: JSON.parse(text) as unknown, snippet };
  } catch {
    return { data: null, snippet };
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const startedAt = Date.now();
  const { headers, headerStrategy, csrfRequired } = buildHeaders();
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal,
  });

  if (response.status === 401) {
    throw new AuthError('Session expired');
  }

  if (response.status === 403) {
    throw new AuthError('Cookie or CSRF token invalid');
  }

  const { data, snippet } = await parseJsonOrSnippet(response);

  if (!response.ok) {
    throw new Error(`GET ${path} failed (${response.status}): ${snippet}`);
  }

  logger.info('PadSplit API GET complete', {
    endpoint: url,
    durationMs: Date.now() - startedAt,
    headerStrategy,
    csrfRequired,
  });

  return data as T;
}

export async function graphqlRequest<T>(body: GraphqlBody): Promise<T> {
  const endpoint = '/api/graphql/';
  const url = `${BASE_URL}${endpoint}`;
  const startedAt = Date.now();
  const { headers, headerStrategy, csrfRequired } = buildHeaders();
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    throw new AuthError('Session expired');
  }

  if (response.status === 403) {
    throw new AuthError('Cookie or CSRF token invalid');
  }

  const { data, snippet } = await parseJsonOrSnippet(response);

  if (!response.ok) {
    throw new Error(`GraphQL ${body.operationName} failed (${response.status}): ${snippet}`);
  }

  const parsed = data as GraphqlResponse<T>;
  const errors =
    parsed.errors ??
    ((parsed.data as Record<string, unknown> | undefined)?.['errors'] as Array<{ message?: string }> | undefined);

  if (errors && errors.length > 0) {
    const messages = errors.map((error) => error.message ?? 'Unknown GraphQL error').join('; ');
    throw new SchemaError(messages);
  }

  if (parsed.data === undefined) {
    throw new SchemaError(`GraphQL ${body.operationName} response missing data`);
  }

  logger.info('PadSplit GraphQL request complete', {
    endpoint: url,
    operationName: body.operationName,
    durationMs: Date.now() - startedAt,
    headerStrategy,
    csrfRequired,
  });

  return parsed.data;
}
