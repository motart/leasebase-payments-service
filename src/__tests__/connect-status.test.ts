import { describe, it, expect } from 'vitest';
import { deriveConnectState } from '../lib/connect-status';
import type Stripe from 'stripe';

function makeAccount(overrides: Partial<Stripe.Account> = {}): Stripe.Account {
  return {
    id: 'acct_test',
    object: 'account',
    charges_enabled: false,
    payouts_enabled: false,
    capabilities: {},
    requirements: {
      currently_due: ['individual.first_name'],
      pending_verification: [],
      disabled_reason: null,
    },
    ...overrides,
  } as unknown as Stripe.Account;
}

describe('deriveConnectState', () => {
  it('returns ACTIVE when charges_enabled and payouts_enabled', () => {
    const result = deriveConnectState(makeAccount({
      charges_enabled: true,
      payouts_enabled: true,
    }));
    expect(result.status).toBe('ACTIVE');
    expect(result.charges_enabled).toBe(true);
    expect(result.payouts_enabled).toBe(true);
  });

  it('returns RESTRICTED when disabled_reason is set', () => {
    const result = deriveConnectState(makeAccount({
      charges_enabled: false,
      payouts_enabled: false,
      requirements: {
        currently_due: [],
        pending_verification: [],
        disabled_reason: 'requirements.past_due',
      } as any,
    }));
    expect(result.status).toBe('RESTRICTED');
  });

  it('returns PENDING_VERIFICATION when currently_due is empty and pending_verification is non-empty', () => {
    const result = deriveConnectState(makeAccount({
      charges_enabled: false,
      payouts_enabled: false,
      requirements: {
        currently_due: [],
        pending_verification: ['individual.verification.document'],
        disabled_reason: null,
      } as any,
    }));
    expect(result.status).toBe('PENDING_VERIFICATION');
  });

  it('returns ONBOARDING_INCOMPLETE as default fallback', () => {
    const result = deriveConnectState(makeAccount({
      charges_enabled: false,
      payouts_enabled: false,
      requirements: {
        currently_due: ['individual.first_name'],
        pending_verification: [],
        disabled_reason: null,
      } as any,
    }));
    expect(result.status).toBe('ONBOARDING_INCOMPLETE');
  });

  it('ACTIVE takes priority over RESTRICTED (charges+payouts enabled despite disabled_reason)', () => {
    const result = deriveConnectState(makeAccount({
      charges_enabled: true,
      payouts_enabled: true,
      requirements: {
        currently_due: [],
        pending_verification: [],
        disabled_reason: 'listed',
      } as any,
    }));
    expect(result.status).toBe('ACTIVE');
  });

  it('serializes capabilities and requirements as JSON strings', () => {
    const result = deriveConnectState(makeAccount({
      capabilities: { card_payments: 'active', transfers: 'active' } as any,
      requirements: { currently_due: ['x'], pending_verification: [], disabled_reason: null } as any,
    }));
    expect(JSON.parse(result.capabilities)).toEqual({ card_payments: 'active', transfers: 'active' });
    expect(JSON.parse(result.requirements)).toHaveProperty('currently_due');
  });

  it('handles undefined capabilities/requirements gracefully', () => {
    const result = deriveConnectState(makeAccount({
      capabilities: undefined as any,
      requirements: undefined as any,
    }));
    expect(result.status).toBe('ONBOARDING_INCOMPLETE');
    expect(result.capabilities).toBe('{}');
    expect(result.requirements).toBe('{}');
  });
});
