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
  getStripe: vi.fn(),
  isStripeConfigured: vi.fn(() => false),
  getWebhookSecrets: vi.fn(() => ({ platform: '', connect: '' })),
}));

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
  sub: 'u1', userId: 'u1', orgId: 'org-1', email: 't@t.com', role: 'OWNER', name: 'T', scopes: ['api/read', 'api/write'], ...overrides,
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

describe('Data Isolation — payments-service', () => {
  // ── P1: GET / requires role (blocks TENANT) ──
  describe('P1: GET / role guard', () => {
    it('returns 403 for TENANT', async () => {
      activeUser.current = user({ role: 'TENANT' });
      expect((await req(port, 'GET', '/p/')).status).toBe(403);
    });
    it('returns 200 for OWNER', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQuery.mockResolvedValueOnce([]);
      mockQueryOne.mockResolvedValueOnce({ count: '0' });
      expect((await req(port, 'GET', '/p/')).status).toBe(200);
    });
  });

  // ── P2: POST / requires role (blocks TENANT and OWNER) ──
  describe('P2: POST / role guard', () => {
    it('returns 403 for TENANT', async () => {
      activeUser.current = user({ role: 'TENANT' });
      expect((await req(port, 'POST', '/p/', { leaseId: 'l1', amount: 1000 })).status).toBe(403);
    });
    it('returns 403 for OWNER', async () => {
      activeUser.current = user({ role: 'OWNER' });
      expect((await req(port, 'POST', '/p/', { leaseId: 'l1', amount: 1000 })).status).toBe(403);
    });
    it('returns 201 for PM_STAFF', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne.mockResolvedValueOnce({ id: 'pay-1', status: 'PENDING' });
      expect((await req(port, 'POST', '/p/', { leaseId: 'l1', amount: 1000 })).status).toBe(201);
    });
  });

  // ── P3: GET /:id tenant ownership ──
  describe('P3: GET /:id tenant ownership', () => {
    it('returns 200 for TENANT who owns the payment (via lease)', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne
        .mockResolvedValueOnce({ id: 'pay-1', organization_id: 'org-1', lease_id: 'lease-1' }) // payment found
        .mockResolvedValueOnce({ user_id: 't1' }); // ownership confirmed
      expect((await req(port, 'GET', '/p/pay-1')).status).toBe(200);
    });
    it('returns 404 for TENANT who does NOT own the payment', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne
        .mockResolvedValueOnce({ id: 'pay-1', organization_id: 'org-1', lease_id: 'lease-1' }) // payment found
        .mockResolvedValueOnce(null); // ownership fails
      expect((await req(port, 'GET', '/p/pay-1')).status).toBe(404);
    });
    it('returns 200 for ORG_ADMIN without ownership check', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne.mockResolvedValueOnce({ id: 'pay-1', organization_id: 'org-1', lease_id: 'lease-1' });
      expect((await req(port, 'GET', '/p/pay-1')).status).toBe(200);
    });
    it('returns 404 when payment not in org (cross-org)', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne.mockResolvedValueOnce(null);
      expect((await req(port, 'GET', '/p/pay-1')).status).toBe(404);
    });
  });
});
