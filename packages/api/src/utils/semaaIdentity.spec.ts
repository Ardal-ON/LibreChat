import { createHmac } from 'node:crypto';
import { createSemaaIdentityHeaders } from './semaaIdentity';

describe('createSemaaIdentityHeaders', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SEMAA_AGENT_SHARED_SECRET = 'shared-secret-value';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('signs the authenticated user for the Semaa endpoint', () => {
    const headers = createSemaaIdentityHeaders({
      endpoint: 'semaa-agent',
      baseURL: 'https://agent.example.com/v1',
      user: { id: 'user-a', tenantId: 'tenant-1', email: 'a@example.com' },
      nowMs: 2000000000000,
    });

    const expectedSignature = createHmac('sha256', 'shared-secret-value')
      .update(['user-a', 'tenant-1', 'a@example.com', '2000000000000'].join('\n'), 'utf8')
      .digest('hex');

    expect(headers).toMatchObject({
      'X-Semaa-User-Id': 'user-a',
      'X-Semaa-Tenant-Id': 'tenant-1',
      'X-Semaa-User-Email': 'a@example.com',
      'X-Semaa-Timestamp': '2000000000000',
      'X-Semaa-Signature': expectedSignature,
    });
  });

  it('does not modify unrelated custom endpoints', () => {
    const headers = createSemaaIdentityHeaders({
      endpoint: 'openrouter',
      baseURL: 'https://openrouter.ai/api/v1',
      user: { id: 'user-a' },
    });

    expect(headers).toEqual({});
  });
});
