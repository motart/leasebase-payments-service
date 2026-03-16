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

import express from 'express';
import { paymentsRouter } from '../routes/payments';

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

const user = (overrides: Record<string, any> = {}) => ({
  sub: 'u1', userId: 'u1', orgId: 'org-1', email: 't@t.com', role: 'TENANT', name: 'T', scopes: ['api/read'], ...overrides,
});

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/p', paymentsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => { res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } }); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; resolve(); }); });
});
afterAll(() => server?.close());
beforeEach(() => { mockQuery.mockReset(); mockQueryOne.mockReset(); });

// ════════════════════════════════════════════════════════════════════════════
// GET /mine — Tenant's own payments
// ════════════════════════════════════════════════════════════════════════════

describe('GET /mine', () => {
  it('returns paginated payments for authenticated tenant', async () => {
    activeUser.current = user();
    // 1st query: getTenantLeaseLinks
    mockQuery
      .mockResolvedValueOnce([{ user_id: 'u1', lease_id: 'l-1', org_id: 'org-1' }])
      // 2nd query: payment_transaction SELECT
      .mockResolvedValueOnce([
        { id: 'pay-1', organization_id: 'org-1', lease_id: 'l-1', amount: 150000, currency: 'usd', method: 'card', status: 'SUCCEEDED', created_at: '2024-06-01', updated_at: '2024-06-01' },
        { id: 'pay-2', organization_id: 'org-1', lease_id: 'l-1', amount: 150000, currency: 'usd', method: 'card', status: 'PENDING', created_at: '2024-07-01', updated_at: '2024-07-01' },
      ]);
    mockQueryOne.mockResolvedValueOnce({ count: '2' });

    const res = await req(port, 'GET', '/p/mine');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.total).toBe(2);
  });

  it('returns empty list when tenant has no lease links', async () => {
    activeUser.current = user();
    mockQuery.mockResolvedValueOnce([]); // no tenant_profiles rows

    const res = await req(port, 'GET', '/p/mine');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta.total).toBe(0);
  });

  it('scopes by user_id and organizationId via tenant_profiles', async () => {
    activeUser.current = user({ userId: 'u-42', orgId: 'org-7' });
    mockQuery
      .mockResolvedValueOnce([{ user_id: 'u-42', lease_id: 'l-1', org_id: 'org-7' }])
      .mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ count: '0' });

    await req(port, 'GET', '/p/mine');
    // First query call is getTenantLeaseLinks which queries tenant_profiles
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('tenant_profiles');
    const params = mockQuery.mock.calls[0][1] as any[];
    expect(params[0]).toBe('u-42');
    expect(params[1]).toBe('org-7');
  });

  it('requires authentication', async () => {
    activeUser.current = null;
    const res = await req(port, 'GET', '/p/mine');
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Route ordering — /mine must come before /:id
// ════════════════════════════════════════════════════════════════════════════

describe('route ordering', () => {
  it('should register GET /mine before GET /:id', () => {
    const routes = (paymentsRouter as any).stack
      ?.filter((layer: any) => layer.route)
      .map((layer: any) => ({
        method: Object.keys(layer.route.methods)[0],
        path: layer.route.path,
      })) ?? [];

    const getMineIdx = routes.findIndex((r: any) => r.method === 'get' && r.path === '/mine');
    const getIdIdx = routes.findIndex((r: any) => r.method === 'get' && r.path === '/:id');

    expect(getMineIdx).toBeGreaterThan(-1);
    expect(getIdIdx).toBeGreaterThan(-1);
    expect(getMineIdx).toBeLessThan(getIdIdx);
  });
});
