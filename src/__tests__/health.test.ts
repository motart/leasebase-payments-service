import { describe, it, expect } from 'vitest';
import { healthRoutes } from '@leasebase/service-common';

describe('healthRoutes', () => {
  it('creates a router with health and ready endpoints', () => {
    const router = healthRoutes();
    const routes = (router as any).stack?.map((r: any) => r.route?.path).filter(Boolean) ?? [];
    expect(routes).toContain('/health');
    expect(routes).toContain('/ready');
  });

  it('accepts health check functions', () => {
    const router = healthRoutes([{ name: 'db', check: async () => true }]);
    expect(router).toBeDefined();
  });
});
