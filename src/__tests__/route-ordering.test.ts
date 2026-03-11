import { describe, it, expect } from 'vitest';
import { paymentsRouter } from '../routes/payments';

/**
 * Regression test: /ledger routes must be registered BEFORE /:id routes.
 *
 * Express matches routes in registration order. If /:id appears first,
 * GET /ledger is matched as GET /:id with id="ledger", returning 404
 * "Payment not found" instead of the ledger list.
 */
describe('payments route ordering', () => {
  // Extract registered routes from the Express router stack
  const routes = (paymentsRouter as any).stack
    ?.filter((layer: any) => layer.route)
    .map((layer: any) => ({
      method: Object.keys(layer.route.methods)[0],
      path: layer.route.path,
    })) ?? [];

  it('should register GET /ledger before GET /:id', () => {
    const getLedgerIdx = routes.findIndex(
      (r: any) => r.method === 'get' && r.path === '/ledger',
    );
    const getIdIdx = routes.findIndex(
      (r: any) => r.method === 'get' && r.path === '/:id',
    );

    expect(getLedgerIdx).toBeGreaterThan(-1);
    expect(getIdIdx).toBeGreaterThan(-1);
    expect(getLedgerIdx).toBeLessThan(getIdIdx);
  });

  it('should register POST /ledger before PUT /:id', () => {
    const postLedgerIdx = routes.findIndex(
      (r: any) => r.method === 'post' && r.path === '/ledger',
    );
    const putIdIdx = routes.findIndex(
      (r: any) => r.method === 'put' && r.path === '/:id',
    );

    expect(postLedgerIdx).toBeGreaterThan(-1);
    expect(putIdIdx).toBeGreaterThan(-1);
    expect(postLedgerIdx).toBeLessThan(putIdIdx);
  });
});
