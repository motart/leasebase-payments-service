import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const { mockQuery, mockQueryOne, activeUser, mockStripeCreate, mockIsStripeConfigured } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockQueryOne: vi.fn(),
  activeUser: { current: null as any },
  mockStripeCreate: vi.fn(),
  mockIsStripeConfigured: vi.fn(() => true),
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
    checkout: { sessions: { create: mockStripeCreate } },
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
  mockStripeCreate.mockReset();
  mockIsStripeConfigured.mockReturnValue(true);
});

// ════════════════════════════════════════════════════════════════════════════
// POST /checkout — Stripe Checkout Session for tenant rent payment
// ════════════════════════════════════════════════════════════════════════════

describe('POST /checkout', () => {
  const validBody = {
    returnUrl: 'https://app.leasebase.ai/payments/success',
    cancelUrl: 'https://app.leasebase.ai/payments/cancel',
  };

  it('creates a checkout session for authenticated tenant with active lease', async () => {
    activeUser.current = tenant();

    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: 150000, org_id: 'org-1' }) // getActiveLeaseForTenant
      .mockResolvedValueOnce(null) // find charge by idempotency_key (not found)
      .mockResolvedValueOnce({ id: 'c-1', amount: 150000, status: 'PENDING' }) // INSERT charge
      .mockResolvedValueOnce(undefined) // insertAuditLog for charge
      .mockResolvedValueOnce(null) // existing transaction check
      .mockResolvedValueOnce({ stripe_account_id: 'acct_abc123', default_fee_percent: 100 }) // payment_account
      .mockResolvedValueOnce({ id: 'txn-1' }) // INSERT payment_transaction
      .mockResolvedValueOnce(undefined); // insertAuditLog for txn

    mockStripeCreate.mockResolvedValueOnce({
      id: 'cs_test_session',
      url: 'https://checkout.stripe.com/c/pay/cs_test_session',
    });

    const res = await req(port, 'POST', '/p/checkout', validBody);

    expect(res.status).toBe(201);
    expect(res.body.data.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_session');
    expect(res.body.data.sessionId).toBe('cs_test_session');
  });

  it('queries lease_service.leases via lease_tenants (not Prisma tables)', async () => {
    activeUser.current = tenant();

    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: 150000, org_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'c-1', amount: 150000, status: 'PENDING' }) // found existing charge
      .mockResolvedValueOnce(null) // no existing txn
      .mockResolvedValueOnce({ stripe_account_id: 'acct_abc123', default_fee_percent: 100 })
      .mockResolvedValueOnce({ id: 'txn-1' })
      .mockResolvedValueOnce(undefined);

    mockStripeCreate.mockResolvedValueOnce({ id: 'cs_test', url: 'https://checkout.stripe.com/x' });

    await req(port, 'POST', '/p/checkout', validBody);

    const leaseSql = mockQueryOne.mock.calls[0][0] as string;
    expect(leaseSql).toContain('lease_service.leases');
    expect(leaseSql).toContain('lease_tenants');
    expect(leaseSql).not.toContain('"Lease"');
    expect(leaseSql).not.toContain('"TenantProfile"');
  });

  it('passes correct Stripe Connect parameters (destination charge)', async () => {
    activeUser.current = tenant();

    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: 200000, org_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'c-1', amount: 200000, status: 'PENDING' }) // found existing charge
      .mockResolvedValueOnce(null) // no existing txn
      .mockResolvedValueOnce({ stripe_account_id: 'acct_xyz789', default_fee_percent: 100 })
      .mockResolvedValueOnce({ id: 'txn-1' })
      .mockResolvedValueOnce(undefined);

    mockStripeCreate.mockResolvedValueOnce({ id: 'cs_test', url: 'https://checkout.stripe.com/x' });

    await req(port, 'POST', '/p/checkout', validBody);

    const stripeArgs = mockStripeCreate.mock.calls[0][0];
    expect(stripeArgs.mode).toBe('payment');
    expect(stripeArgs.line_items[0].price_data.unit_amount).toBe(200000);
    expect(stripeArgs.payment_intent_data.transfer_data.destination).toBe('acct_xyz789');
    expect(stripeArgs.payment_intent_data.application_fee_amount).toBe(2000);
    expect(stripeArgs.success_url).toBe(validBody.returnUrl);
    expect(stripeArgs.cancel_url).toBe(validBody.cancelUrl);
  });

  it('returns 422 when lease unit has null rent_amount', async () => {
    activeUser.current = tenant();
    mockQueryOne.mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: null, org_id: 'org-1' });

    const res = await req(port, 'POST', '/p/checkout', validBody);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_RENT_CONFIGURED');
  });

  it('returns 422 when lease unit has zero rent_amount', async () => {
    activeUser.current = tenant();
    mockQueryOne.mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: 0, org_id: 'org-1' });

    const res = await req(port, 'POST', '/p/checkout', validBody);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_RENT_CONFIGURED');
  });

  it('returns 404 when tenant has no active lease', async () => {
    activeUser.current = tenant();
    mockQueryOne.mockResolvedValueOnce(null); // no lease found

    const res = await req(port, 'POST', '/p/checkout', validBody);

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('No active lease');
  });

  it('returns 422 when org has no active payment account', async () => {
    activeUser.current = tenant();
    mockQueryOne
      .mockResolvedValueOnce({ lease_id: 'lease-1', rent_amount: 150000, org_id: 'org-1' }) // lease
      .mockResolvedValueOnce({ id: 'c-1', amount: 150000, status: 'PENDING' }) // charge exists
      .mockResolvedValueOnce(null) // no existing txn
      .mockResolvedValueOnce(null); // no payment_account

    const res = await req(port, 'POST', '/p/checkout', validBody);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_PAYMENT_ACCOUNT');
  });

  it('returns 503 when Stripe is not configured', async () => {
    activeUser.current = tenant();
    mockIsStripeConfigured.mockReturnValue(false);

    const res = await req(port, 'POST', '/p/checkout', validBody);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STRIPE_NOT_CONFIGURED');
  });

  it('rejects OWNER role (checkout is tenant-only)', async () => {
    activeUser.current = owner();

    const res = await req(port, 'POST', '/p/checkout', validBody);

    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated requests', async () => {
    activeUser.current = null;

    const res = await req(port, 'POST', '/p/checkout', validBody);

    expect(res.status).toBe(401);
  });

  it('rejects invalid body (missing returnUrl)', async () => {
    activeUser.current = tenant();

    const res = await req(port, 'POST', '/p/checkout', { cancelUrl: 'https://example.com' });

    // validateBody throws ZodError; status depends on service-common error mapping
    expect([400, 422, 500]).toContain(res.status);
  });

  it('scopes lease query by user_id and orgId from JWT', async () => {
    activeUser.current = tenant({ userId: 'u-42', orgId: 'org-7' });

    mockQueryOne.mockResolvedValueOnce(null); // no lease

    await req(port, 'POST', '/p/checkout', validBody);

    const params = mockQueryOne.mock.calls[0][1] as any[];
    expect(params[0]).toBe('u-42');
    expect(params[1]).toBe('org-7');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Route ordering — /checkout must come before /:id
// ════════════════════════════════════════════════════════════════════════════

describe('route ordering — /checkout', () => {
  it('should register POST /checkout before GET /:id', () => {
    const routes = (paymentsRouter as any).stack
      ?.filter((layer: any) => layer.route)
      .map((layer: any) => ({
        method: Object.keys(layer.route.methods)[0],
        path: layer.route.path,
      })) ?? [];

    const checkoutIdx = routes.findIndex((r: any) => r.method === 'post' && r.path === '/checkout');
    const getIdIdx = routes.findIndex((r: any) => r.method === 'get' && r.path === '/:id');

    expect(checkoutIdx).toBeGreaterThan(-1);
    expect(getIdIdx).toBeGreaterThan(-1);
    expect(checkoutIdx).toBeLessThan(getIdIdx);
  });
});
