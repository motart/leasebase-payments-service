import { describe, it, expect } from 'vitest';
import { paymentsRouter } from '../routes/payments';

/**
 * Regression test: named routes must be registered BEFORE /:id routes.
 *
 * Express matches routes in registration order. If /:id appears first,
 * GET /charges is matched as GET /:id with id="charges", returning 404.
 */
describe('payments route ordering', () => {
  const routes = (paymentsRouter as any).stack
    ?.filter((layer: any) => layer.route)
    .map((layer: any) => ({
      method: Object.keys(layer.route.methods)[0],
      path: layer.route.path,
    })) ?? [];

  it('should register GET /charges before GET /:id', () => {
    const getChargesIdx = routes.findIndex(
      (r: any) => r.method === 'get' && r.path === '/charges',
    );
    const getIdIdx = routes.findIndex(
      (r: any) => r.method === 'get' && r.path === '/:id',
    );

    expect(getChargesIdx).toBeGreaterThan(-1);
    expect(getIdIdx).toBeGreaterThan(-1);
    expect(getChargesIdx).toBeLessThan(getIdIdx);
  });

  it('should register GET /mine before GET /:id', () => {
    const getMineIdx = routes.findIndex(
      (r: any) => r.method === 'get' && r.path === '/mine',
    );
    const getIdIdx = routes.findIndex(
      (r: any) => r.method === 'get' && r.path === '/:id',
    );

    expect(getMineIdx).toBeGreaterThan(-1);
    expect(getIdIdx).toBeGreaterThan(-1);
    expect(getMineIdx).toBeLessThan(getIdIdx);
  });
});
