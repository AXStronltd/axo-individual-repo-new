import { describe, it, expect } from 'vitest';
import { assessRisk, isDenylisted, RISK_THRESHOLDS, type RiskInputs } from '../src/modules/risk/risk.lib.js';

function inputs(over: Partial<RiskInputs> = {}): RiskInputs {
  return {
    amountMinor: 10000n,
    currency: 'KES',
    txnsLastHour: 0,
    sumLastHourMinor: 0n,
    distinctRecipientsLastHour: 0,
    senderDenylisted: false,
    recipientDenylisted: false,
    destinationDenylisted: false,
    newRecipient: false,
    perTxnCeilingMinor: 2_000_000n,
    ...over,
  };
}

describe('assessRisk', () => {
  it('allows an ordinary movement', () => {
    const r = assessRisk(inputs());
    expect(r.decision).toBe('allow');
    expect(r.score).toBeLessThan(RISK_THRESHOLDS.review);
  });

  it('blocks a denylisted recipient outright', () => {
    const r = assessRisk(inputs({ recipientDenylisted: true }));
    expect(r.decision).toBe('block');
    expect(r.signals.map((s) => s.code)).toContain('recipient_denylisted');
  });

  it('blocks a denylisted cash-out destination', () => {
    expect(assessRisk(inputs({ destinationDenylisted: true })).decision).toBe('block');
  });

  it('raises an elevated-velocity signal (one moderate signal alone stays allow)', () => {
    const r = assessRisk(inputs({ txnsLastHour: 12 }));
    expect(r.signals.some((s) => s.code === 'elevated_velocity')).toBe(true);
    expect(r.decision).toBe('allow'); // weight 25 < review threshold 40
  });

  it('routes very-high velocity (weight 50) to review', () => {
    const r = assessRisk(inputs({ txnsLastHour: 20 }));
    expect(r.decision).toBe('review');
    expect(r.signals.some((s) => s.code === 'high_velocity')).toBe(true);
  });

  it('blocks very high velocity + fanout together', () => {
    const r = assessRisk(inputs({ txnsLastHour: 20, distinctRecipientsLastHour: 10 }));
    expect(r.decision).toBe('block'); // 50 + 35 >= 80
  });

  it('flags possible structuring (repeated near-limit amounts)', () => {
    const r = assessRisk(inputs({ amountMinor: 1_950_000n, perTxnCeilingMinor: 2_000_000n, txnsLastHour: 4 }));
    expect(r.signals.some((s) => s.code === 'possible_structuring')).toBe(true);
  });

  it('is explainable — every firing signal carries a weight', () => {
    const r = assessRisk(inputs({ txnsLastHour: 12 }));
    expect(r.signals.every((s) => typeof s.weight === 'number' && s.weight > 0)).toBe(true);
    expect(r.score).toBe(r.signals.reduce((n, s) => n + s.weight, 0));
  });
});

describe('isDenylisted', () => {
  const dl = new Set(['@scammer', '254700000000']);
  it('matches normalized values', () => {
    expect(isDenylisted('@Scammer', dl)).toBe(true);
    expect(isDenylisted(' 254 700 000 000 ', dl)).toBe(true);
  });
  it('does not match clean values', () => {
    expect(isDenylisted('@amina', dl)).toBe(false);
    expect(isDenylisted('', dl)).toBe(false);
  });
});
