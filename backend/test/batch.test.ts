import { describe, it, expect } from 'vitest';
import { parseRecipientCsv, validateRecipients, batchTotalMinor } from '../src/modules/batches/batch.lib.js';

describe('CSV parsing', () => {
  it('parses rows and skips a header', () => {
    const csv = 'recipient,destination,amountMinor\nHassan,+254711,70000\nAmina,+254722,70000';
    const { rows } = parseRecipientCsv(csv);
    expect(rows.length).toBe(2);
    expect(rows[0]!.recipient).toBe('Hassan');
    expect(rows[0]!.amountMinor).toBe(70000n);
  });

  it('works without a header row', () => {
    const { rows } = parseRecipientCsv('Yusuf,+254733,50000');
    expect(rows.length).toBe(1);
    expect(rows[0]!.amountMinor).toBe(50000n);
  });

  it('flags an unparseable amount as undefined', () => {
    const { rows } = parseRecipientCsv('Bad,+254700,abc');
    expect(rows[0]!.amountMinor).toBeUndefined();
  });
});

describe('recipient validation', () => {
  it('accepts well-formed recipients', () => {
    const { rows } = parseRecipientCsv('Hassan,+254711,70000\nAmina,+254722,70000');
    const v = validateRecipients(rows);
    expect(v.valid.length).toBe(2);
    expect(v.errors.length).toBe(0);
  });

  it('reports missing fields and bad amounts with line numbers', () => {
    const { rows } = parseRecipientCsv(',+254711,70000\nAmina,,70000\nYusuf,+254733,0');
    const v = validateRecipients(rows);
    expect(v.valid.length).toBe(0);
    expect(v.errors).toContainEqual({ line: 1, reason: 'missing recipient' });
    expect(v.errors).toContainEqual({ line: 2, reason: 'missing destination' });
    expect(v.errors).toContainEqual({ line: 3, reason: 'invalid amount' });
  });

  it('detects duplicate destinations', () => {
    const { rows } = parseRecipientCsv('Hassan,+254711,70000\nHassanAgain,+254711,70000');
    const v = validateRecipients(rows);
    expect(v.valid.length).toBe(2); // still valid, but flagged
    expect(v.duplicates).toContainEqual({ destination: '+254711', count: 2 });
  });
});

describe('batch total', () => {
  it('sums recipient amounts', () => {
    const { rows } = parseRecipientCsv('Hassan,+254711,70000\nAmina,+254722,70000\nYusuf,+254733,50000');
    const v = validateRecipients(rows);
    expect(batchTotalMinor(v.valid)).toBe(190000n);
  });

  it('is zero for an empty batch', () => {
    expect(batchTotalMinor([])).toBe(0n);
  });
});
