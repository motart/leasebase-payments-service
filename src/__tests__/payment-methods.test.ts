import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const { mockQuery, mockQueryOne, mockGetPool, activeUser, mockStripeCreate, mockStripeRetrieve, mockStripeDetach, mockIsStripeConfigured, mockGetPublishableKey, mockCustomerCreate } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockQueryOne: vi.fn(),
  mockGetPool: vi.fn(),
  activeUser: { current: null as any },
  mockStripeCreate: vi.fn(),
  mockStripeRetrieve: vi.fn(),
  mockStripeDetach: vi.fn(),
  mockIsStripeConfigured: vi.fn(() => true),
  mockGetPublishableKey: vi.fn(() => 'pk_test_xxx'),
  mockCustomerCreate: vi.fn(),
}));

vi.mock('@leasebase/service-common', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@leasebase/service-common')>();
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return {
    ...mod,
    query: mockQuery,
    queryOne: mockQueryOne,
    getPool: () => ({ connect: () => Promise.resolve(mockClient) }),
    requireAuth: (req: any, _res: any, next: any) => {
      if (!activeUser.current) return next(new mod.UnauthorizedError());
      req.user = { ...activeUser.current };
      next();
    },
  };
});

vi.mock('../stripe/client', () => ({
  getStripe: () => ({
    setupIntents: { create: mockStripeCreate, retrieve: mockStripeRetrieve },
    paymentMethods: { detach: mockStripeDetach, retrieve: vi.fn() },
    customers: { create: mockCustomerCreate },
  }),
  isStripeConfigured: () => mockIsStripeConfigured(),
  getPublishableKey: () => mockGetPublishableKey(),
}));

vi.mock('../lib/stripe-customers', () => ({
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue('cus_test123'),
}));

import express from 'express';
import { paymentMethodsRouter } from '../routes/payment-methods';

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
  app.use('/pm', paymentMethodsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => { res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } }); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; resolve(); }); });
});
afterAll(() => server?.close());
beforeEach(() => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockStripeCreate.mockReset();
  mockStripeRetrieve.mockReset();
  mockStripeDetach.mockReset();
  mockIsStripeConfigured.mockReturnValue(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /setup-intent
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /setup-intent', () => {
  it('creates a SetupIntent and returns clientSecret', async () => {
    activeUser.current = tenant();
    mockStripeCreate.mockResolvedValueOnce({
      id: 'seti_test',
      client_secret: 'seti_test_secret_xxx',
    });

    const res = await req(port, 'POST', '/pm/setup-intent');

    expect(res.status).toBe(201);
    expect(res.body.data.clientSecret).toBe('seti_test_secret_xxx');
    expect(res.body.data.setupIntentId).toBe('seti_test');
    expect(res.body.data.publishableKey).toBe('pk_test_xxx');
    expect(res.body.data.customerId).toBe('cus_test123');
  });

  it('returns 503 when Stripe is not configured', async () => {
    activeUser.current = tenant();
    mockIsStripeConfigured.mockReturnValue(false);

    const res = await req(port, 'POST', '/pm/setup-intent');
    expect(res.status).toBe(503);
  });

  it('rejects unauthenticated requests', async () => {
    activeUser.current = null;
    const res = await req(port, 'POST', '/pm/setup-intent');
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /setup-intent/complete
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /setup-intent/complete', () => {
  it('persists payment method from succeeded SetupIntent', async () => {
    activeUser.current = tenant();

    mockStripeRetrieve.mockResolvedValueOnce({
      id: 'seti_test',
      status: 'succeeded',
      customer: 'cus_test123',
      payment_method: {
        id: 'pm_test',
        type: 'card',
        card: { last4: '4242', brand: 'visa', exp_month: 12, exp_year: 2027, fingerprint: 'fp_abc' },
      },
    });

    mockQueryOne
      .mockResolvedValueOnce(null)  // existing PM check
      .mockResolvedValueOnce({ count: '0' }) // count existing methods
      .mockResolvedValueOnce({ id: 'local-pm-1', type: 'card', last4: '4242', brand: 'visa', is_default: true }) // INSERT
      .mockResolvedValueOnce(undefined); // audit log

    const res = await req(port, 'POST', '/pm/setup-intent/complete', { setupIntentId: 'seti_test' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('local-pm-1');
    expect(res.body.data.is_default).toBe(true);
  });

  it('returns existing PM if already persisted (idempotent)', async () => {
    activeUser.current = tenant();

    mockStripeRetrieve.mockResolvedValueOnce({
      id: 'seti_test',
      status: 'succeeded',
      customer: 'cus_test123',
      payment_method: { id: 'pm_existing', type: 'card', card: { last4: '4242', brand: 'visa' } },
    });

    mockQueryOne
      .mockResolvedValueOnce({ id: 'local-pm-existing' }) // existing PM found
      .mockResolvedValueOnce({ id: 'local-pm-existing', type: 'card', last4: '4242' }); // fetch full row

    const res = await req(port, 'POST', '/pm/setup-intent/complete', { setupIntentId: 'seti_test' });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('local-pm-existing');
  });

  it('rejects if SetupIntent not succeeded', async () => {
    activeUser.current = tenant();

    mockStripeRetrieve.mockResolvedValueOnce({
      id: 'seti_test',
      status: 'requires_payment_method',
      payment_method: null,
    });

    const res = await req(port, 'POST', '/pm/setup-intent/complete', { setupIntentId: 'seti_test' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SETUP_NOT_COMPLETE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /', () => {
  it('lists active payment methods for authenticated tenant', async () => {
    activeUser.current = tenant();
    mockQuery.mockResolvedValueOnce([
      { id: 'pm-1', type: 'card', last4: '4242', brand: 'visa', is_default: true, status: 'ACTIVE' },
      { id: 'pm-2', type: 'card', last4: '1234', brand: 'mastercard', is_default: false, status: 'ACTIVE' },
    ]);

    const res = await req(port, 'GET', '/pm/');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].is_default).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /:id
// ═══════════════════════════════════════════════════════════════════════════

describe('DELETE /:id', () => {
  it('rejects deletion of PM tied to active autopay', async () => {
    activeUser.current = tenant();
    mockQueryOne
      .mockResolvedValueOnce({ id: 'ae-1' }); // active autopay enrollment found

    const res = await req(port, 'DELETE', '/pm/pm-1');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUTOPAY_ACTIVE');
  });

  it('detaches PM from Stripe and marks DETACHED', async () => {
    activeUser.current = tenant();
    mockQueryOne
      .mockResolvedValueOnce(null) // no active autopay
      .mockResolvedValueOnce({ id: 'pm-1', stripe_payment_method_id: 'pm_stripe_1', is_default: false }) // PM row
      .mockResolvedValueOnce({ id: 'pm-1', status: 'DETACHED' }) // UPDATE result
      .mockResolvedValueOnce(undefined); // audit log

    mockStripeDetach.mockResolvedValueOnce({});

    const res = await req(port, 'DELETE', '/pm/pm-1');
    expect(res.status).toBe(200);
    expect(mockStripeDetach).toHaveBeenCalledWith('pm_stripe_1');
  });
});
