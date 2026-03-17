import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const { mockQuery, mockQueryOne, activeUser } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockQueryOne: vi.fn(),
  activeUser: { current: null as any },
}));

vi.mock('@leasebase/service-common', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@leasebase/service-common')>();
  return {
    ...mod,
    query: mockQuery,
    queryOne: mockQueryOne,
    requireAuth: (req: any, _res: any, next: any) => {
      if (!activeUser.current) return next(new mod.UnauthorizedError());
      req.user = { ...activeUser.current };
      next();
    },
  };
});

vi.mock('../stripe/client', () => ({
  isStripeConfigured: () => true,
  getStripe: () => ({}),
  getPublishableKey: () => 'pk_test_xxx',
}));

import express from 'express';
import { autopayRouter } from '../routes/autopay';

function req(port: number, method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data).toString() } : {}) } },
      (res) => { let raw = ''; res.on('data', (c) => (raw += c)); res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, body: raw }); } }); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const tenant = (overrides: Record<string, any> = {}) => ({
  sub: 'u1', userId: 'u1', orgId: 'org-1', email: 't@t.com', role: 'TENANT', name: 'Tenant', scopes: ['api/read'], ...overrides,
});

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/ap', autopayRouter);
  app.use((err: any, _req: any, res: any, _next: any) => { res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } }); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; resolve(); }); });
});
afterAll(() => server?.close());
beforeEach(() => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
});

describe('GET / — autopay status', () => {
  it('returns disabled status when no enrollment exists', async () => {
    activeUser.current = tenant();
    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', monthly_rent: 150000, org_id: 'org-1' }) // active lease
      .mockResolvedValueOnce(null) // no enrollment
      .mockResolvedValueOnce(null); // no default PM

    const res = await req(port, 'GET', '/ap/');
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
    expect(res.body.data.status).toBe('DISABLED');
  });

  it('returns enabled status with payment method info', async () => {
    activeUser.current = tenant();
    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', monthly_rent: 150000, org_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'ae-1', status: 'ENABLED', payment_method_id: 'pm-1', lease_id: 'lease-1' })
      .mockResolvedValueOnce({ id: 'pm-1', type: 'card', last4: '4242', brand: 'visa' });

    const res = await req(port, 'GET', '/ap/');
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.payment_method.last4).toBe('4242');
  });
});

describe('PATCH / — enable/disable autopay', () => {
  it('rejects enabling without a default payment method', async () => {
    activeUser.current = tenant();
    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', monthly_rent: 150000, org_id: 'org-1' }) // active lease
      .mockResolvedValueOnce(null); // no default PM

    const res = await req(port, 'PATCH', '/ap/', { enabled: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_DEFAULT_METHOD');
  });

  it('enables autopay when default payment method exists', async () => {
    activeUser.current = tenant();
    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', monthly_rent: 150000, org_id: 'org-1' }) // active lease
      .mockResolvedValueOnce({ id: 'pm-1' }) // default PM
      .mockResolvedValueOnce({ id: 'ae-1', status: 'ENABLED', lease_id: 'lease-1' }) // upsert result
      .mockResolvedValueOnce(undefined); // audit log

    const res = await req(port, 'PATCH', '/ap/', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ENABLED');
  });

  it('disables autopay', async () => {
    activeUser.current = tenant();
    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', monthly_rent: 150000, org_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'ae-1', status: 'DISABLED', lease_id: 'lease-1' })
      .mockResolvedValueOnce(undefined); // audit log

    const res = await req(port, 'PATCH', '/ap/', { enabled: false });
    expect(res.status).toBe(200);
  });

  it('returns 404 when no active lease', async () => {
    activeUser.current = tenant();
    mockQueryOne.mockResolvedValueOnce(null); // no lease

    const res = await req(port, 'PATCH', '/ap/', { enabled: true });
    expect(res.status).toBe(404);
  });
});
