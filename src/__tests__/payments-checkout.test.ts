import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const { mockQuery, mockQueryOne, activeUser, mockIsStripeConfigured, mockAccountsRetrieve, mockPiCreate, mockPiRetrieve, mockCustomersCreate } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockQueryOne: vi.fn(),
  activeUser: { current: null as any },
  mockIsStripeConfigured: vi.fn(() => true),
  mockAccountsRetrieve: vi.fn(),
  mockPiCreate: vi.fn(),
  mockPiRetrieve: vi.fn(),
  mockCustomersCreate: vi.fn(),
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
  getStripe: () => ({
    accounts: { retrieve: mockAccountsRetrieve },
    paymentIntents: { create: mockPiCreate, retrieve: mockPiRetrieve },
    customers: { create: mockCustomersCreate },
  }),
  isStripeConfigured: () => mockIsStripeConfigured(),
  getPublishableKey: () => 'pk_test_xxx',
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

const tenant = (overrides: Record<string, any> = {}) => ({
  sub: 'u1', userId: 'u1', orgId: 'org-1', email: 't@t.com', role: 'TENANT', name: 'Tenant', scopes: ['api/read'], ...overrides,
});

const owner = (overrides: Record<string, any> = {}) => ({
  sub: 'o1', userId: 'o1', orgId: 'org-1', email: 'o@t.com', role: 'OWNER', name: 'Owner', scopes: ['api/read'], ...overrides,
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
beforeEach(() => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockAccountsRetrieve.mockReset();
  mockPiCreate.mockReset();
  mockPiRetrieve.mockReset();
  mockCustomersCreate.mockReset();
  mockIsStripeConfigured.mockReturnValue(true);
});

// ════════════════════════════════════════════════════════════════════════════
// POST /checkout/create-intent — Embedded PaymentIntent for in-app checkout
// ════════════════════════════════════════════════════════════════════════════

describe('POST /checkout/create-intent', () => {
  it('creates a PaymentIntent and returns clientSecret for valid tenant', async () => {
    activeUser.current = tenant();

    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: 180000, org_id: 'org-1' }) // lease
      .mockResolvedValueOnce({ id: 'c-1', amount: 180000, status: 'PENDING' }) // charge exists
      .mockResolvedValueOnce(null) // no existing txn
      .mockResolvedValueOnce({ id: 'pa-1', stripe_account_id: 'acct_dest', default_fee_percent: 100, status: 'ACTIVE' }) // payment_account ACTIVE
      .mockResolvedValueOnce({ stripe_customer_id: 'cus_existing' }) // getOrCreateStripeCustomer lookup
      .mockResolvedValueOnce({ id: 'txn-1' }) // INSERT payment_transaction
      .mockResolvedValueOnce(undefined); // insertAuditLog

    mockPiCreate.mockResolvedValueOnce({
      id: 'pi_test_123',
      client_secret: 'pi_test_123_secret_abc',
    });

    const res = await req(port, 'POST', '/p/checkout/create-intent', {});

    expect(res.status).toBe(201);
    expect(res.body.data.clientSecret).toBe('pi_test_123_secret_abc');
    expect(res.body.data.paymentIntentId).toBe('pi_test_123');
    expect(res.body.data.publishableKey).toBe('pk_test_xxx');
    expect(res.body.data.amount).toBe(180000);
    expect(res.body.data.currency).toBe('usd');
  });

  it('passes correct destination charge parameters to Stripe', async () => {
    activeUser.current = tenant();

    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: 200000, org_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'c-1', amount: 200000, status: 'PENDING' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'pa-1', stripe_account_id: 'acct_xyz', default_fee_percent: 100, status: 'ACTIVE' })
      .mockResolvedValueOnce({ stripe_customer_id: 'cus_test' })
      .mockResolvedValueOnce({ id: 'txn-1' })
      .mockResolvedValueOnce(undefined);

    mockPiCreate.mockResolvedValueOnce({ id: 'pi_x', client_secret: 'pi_x_secret' });

    await req(port, 'POST', '/p/checkout/create-intent', {});

    const args = mockPiCreate.mock.calls[0][0];
    expect(args.amount).toBe(200000);
    expect(args.currency).toBe('usd');
    expect(args.customer).toBe('cus_test');
    expect(args.transfer_data.destination).toBe('acct_xyz');
    expect(args.application_fee_amount).toBe(2000);
    expect(args.metadata.source).toBe('TENANT_PORTAL');
  });

  it('returns 422 NO_PAYMENT_ACCOUNT when owner has not enabled payments', async () => {
    activeUser.current = tenant();

    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: 180000, org_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'c-1', amount: 180000, status: 'PENDING' })
      .mockResolvedValueOnce(null) // no existing txn
      .mockResolvedValueOnce(null) // no ACTIVE payment_account
      .mockResolvedValueOnce(null); // no any-status payment_account

    const res = await req(port, 'POST', '/p/checkout/create-intent', {});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_PAYMENT_ACCOUNT');
  });

  it('returns 422 NO_RENT_CONFIGURED when rent is null', async () => {
    activeUser.current = tenant();
    mockQueryOne.mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: null, org_id: 'org-1' });

    const res = await req(port, 'POST', '/p/checkout/create-intent', {});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_RENT_CONFIGURED');
  });

  it('returns 409 PAYMENT_IN_PROGRESS when Stripe PI is processing', async () => {
    activeUser.current = tenant();

    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: 180000, org_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'c-1', amount: 180000, status: 'PENDING' })
      .mockResolvedValueOnce({ id: 'existing-txn', stripe_payment_intent_id: 'pi_active', status: 'PENDING', charge_id: 'c-1' });

    mockPiRetrieve.mockResolvedValueOnce({ id: 'pi_active', status: 'processing' });

    const res = await req(port, 'POST', '/p/checkout/create-intent', {});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_IN_PROGRESS');
  });

  it('clears stale PENDING txn and creates new intent when Stripe PI is abandoned', async () => {
    activeUser.current = tenant();

    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: 180000, org_id: 'org-1' }) // lease
      .mockResolvedValueOnce({ id: 'c-1', amount: 180000, status: 'PENDING' }) // charge
      .mockResolvedValueOnce({ id: 'stale-txn', stripe_payment_intent_id: 'pi_stale', status: 'PENDING', charge_id: 'c-1' }) // existing stale txn
      .mockResolvedValueOnce(undefined) // UPDATE stale txn to CANCELED
      .mockResolvedValueOnce({ id: 'pa-1', stripe_account_id: 'acct_dest', default_fee_percent: 100, status: 'ACTIVE' }) // payment_account
      .mockResolvedValueOnce({ stripe_customer_id: 'cus_existing' }) // customer
      .mockResolvedValueOnce({ id: 'txn-new' }) // INSERT new txn
      .mockResolvedValueOnce(undefined); // audit log

    // Stripe says old PI is abandoned
    mockPiRetrieve.mockResolvedValueOnce({ id: 'pi_stale', status: 'requires_payment_method' });
    // New PI creation
    mockPiCreate.mockResolvedValueOnce({ id: 'pi_fresh', client_secret: 'pi_fresh_secret' });

    const res = await req(port, 'POST', '/p/checkout/create-intent', {});

    expect(res.status).toBe(201);
    expect(res.body.data.clientSecret).toBe('pi_fresh_secret');
    expect(mockPiRetrieve).toHaveBeenCalledWith('pi_stale');
  });

  it('rejects OWNER role', async () => {
    activeUser.current = owner();
    const res = await req(port, 'POST', '/p/checkout/create-intent', {});
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Route ordering — /checkout must come before /:id
// ════════════════════════════════════════════════════════════════════════════

describe('route ordering — /checkout/create-intent before /:id', () => {
  it('should register POST /checkout/create-intent before GET /:id', () => {
    const routes = (paymentsRouter as any).stack
      ?.filter((layer: any) => layer.route)
      .map((layer: any) => ({
        method: Object.keys(layer.route.methods)[0],
        path: layer.route.path,
      })) ?? [];

    const createIntentIdx = routes.findIndex((r: any) => r.method === 'post' && r.path === '/checkout/create-intent');
    const getIdIdx = routes.findIndex((r: any) => r.method === 'get' && r.path === '/:id');

    expect(createIntentIdx).toBeGreaterThan(-1);
    expect(getIdIdx).toBeGreaterThan(-1);
    expect(createIntentIdx).toBeLessThan(getIdIdx);
  });
});
