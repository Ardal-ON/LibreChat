import { createHmac } from 'node:crypto';
import type { IUser } from '@librechat/data-schemas';

interface SemaaIdentityHeaderOptions {
  endpoint: string;
  baseURL?: string | null;
  user?: Partial<IUser> | { id?: string; _id?: unknown; tenantId?: string; email?: string };
  nowMs?: number;
}

const DEFAULT_ENDPOINT_NAMES = ['semaa', 'semaa-agent', 'sem-aa-agent'];

export function createSemaaIdentityHeaders({
  endpoint,
  baseURL,
  user,
  nowMs = Date.now(),
}: SemaaIdentityHeaderOptions): Record<string, string> {
  const sharedSecret = process.env.SEMAA_AGENT_SHARED_SECRET;
  if (!sharedSecret || !isSemaaAgentEndpoint(endpoint, baseURL)) {
    return {};
  }

  const userId = getUserId(user);
  if (!userId) {
    return {};
  }

  const tenantId = user?.tenantId ?? '';
  const email = user?.email ?? '';
  const timestamp = String(nowMs);
  const signature = createHmac('sha256', sharedSecret)
    .update([userId, tenantId, email, timestamp].join('\n'), 'utf8')
    .digest('hex');

  return {
    'X-Semaa-User-Id': userId,
    'X-Semaa-Tenant-Id': tenantId,
    'X-Semaa-User-Email': email,
    'X-Semaa-Timestamp': timestamp,
    'X-Semaa-Signature': signature,
  };
}

export function isSemaaAgentEndpoint(endpoint: string, baseURL?: string | null): boolean {
  const configuredNames = (process.env.SEMAA_AGENT_ENDPOINT_NAMES ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const endpointNames = configuredNames.length > 0 ? configuredNames : DEFAULT_ENDPOINT_NAMES;
  if (endpointNames.includes(endpoint.toLowerCase())) {
    return true;
  }

  const configuredBaseURL = process.env.SEMAA_AGENT_BASE_URL?.replace(/\/+$/, '');
  const requestBaseURL = baseURL?.replace(/\/+$/, '');
  return Boolean(configuredBaseURL && requestBaseURL && configuredBaseURL === requestBaseURL);
}

function getUserId(user: SemaaIdentityHeaderOptions['user']): string {
  if (typeof user?.id === 'string' && user.id) {
    return user.id;
  }
  if (user?._id != null) {
    return String(user._id);
  }
  return '';
}
