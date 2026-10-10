import { describe, it, expect } from 'vitest';
import { invoiceTotalMinor, isOverdue } from '../src/modules/invoices/invoices.service.js';

describe('invoice total (integer tax, no floats)', () => {
  it('adds VAT 16% correctly', () => {
    // subtotal 1000.00 (100000 minor) + 16% = 1160.00 (116000)
    expect(invoiceTotalMinor(100000n, 16)).toBe(116000n);
  });

  it('handles 0% tax', () => {
    expect(invoiceTotalMinor(64000n, 0)).toBe(64000n);
  });

  it('rounds fractional tax down to the minor unit', () => {
    // 333 minor * 16% = 53.28 minor -> 53 (integer division on basis points)
    expect(invoiceTotalMinor(333n, 16)).toBe(333n + 53n);
  });

  it('handles non-integer rates (7.5%)', () => {
    // 10000 minor * 7.5% = 750
    expect(invoiceTotalMinor(10000n, 7.5)).toBe(10750n);
  });
});

describe('overdue derivation', () => {
  const past = new Date('2026-01-01');
  const now = new Date('2026-02-01');
  const future = new Date('2026-03-01');

  it('is overdue when issued and past due', () => {
    expect(isOverdue({ status: 'issued', dueDate: past }, now)).toBe(true);
    expect(isOverdue({ status: 'partially_paid', dueDate: past }, now)).toBe(true);
  });

  it('is not overdue before the due date', () => {
    expect(isOverdue({ status: 'issued', dueDate: future }, now)).toBe(false);
  });

  it('paid, draft and cancelled are never overdue', () => {
    expect(isOverdue({ status: 'paid', dueDate: past }, now)).toBe(false);
    expect(isOverdue({ status: 'draft', dueDate: past }, now)).toBe(false);
    expect(isOverdue({ status: 'cancelled', dueDate: past }, now)).toBe(false);
  });

  it('no due date means not overdue', () => {
    expect(isOverdue({ status: 'issued', dueDate: null }, now)).toBe(false);
  });
});
