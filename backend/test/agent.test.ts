import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agentCommission, checkAgentFloat } from '../src/modules/agent/agent.lib.js';

describe('agentCommission', () => {
  it('computes bps commission', () => {
    expect(agentCommission(100000n, 50)).toBe(500n); // 0.5% of 1000.00
    expect(agentCommission(100000n, 0)).toBe(0n);
    expect(agentCommission(0n, 50)).toBe(0n);
  });
});

describe('checkAgentFloat', () => {
  it('blocks cash-in beyond float', () => {
    expect(checkAgentFloat({ kind: 'cash_in', amountMinor: 100n, floatMinor: 50n, status: 'active' })).toMatchObject({ ok: false });
  });
  it('allows cash-in within float', () => {
    expect(checkAgentFloat({ kind: 'cash_in', amountMinor: 50n, floatMinor: 100n, status: 'active' })).toEqual({ ok: true });
  });
  it('allows cash-out regardless of float (float goes up)', () => {
    expect(checkAgentFloat({ kind: 'cash_out', amountMinor: 9999n, floatMinor: 0n, status: 'active' })).toEqual({ ok: true });
  });
  it('blocks a suspended agent', () => {
    expect(checkAgentFloat({ kind: 'cash_out', amountMinor: 1n, floatMinor: 0n, status: 'suspended' })).toMatchObject({ ok: false });
  });
});

// --- service test with in-memory DB ---
const store = { agents: new Map<string, any>(), customers: new Map<string, any>(), wallets: new Map<string, any>(), agentTxns: new Map<string, any>(), ledger: [] as any[], seq: 0 };
function reset() {
  store.agents.clear(); store.customers.clear(); store.wallets.clear(); store.agentTxns.clear(); store.ledger = []; store.seq = 0;
  store.agents.set('AG1', { id: 'AG1', code: 'AG1', currency: 'KES', status: 'active', floatMinor: 100000n, commissionMinor: 0n, commissionBps: 50 });
  const wid = 'w_amina';
  store.wallets.set(wid, { id: wid, customerId: 'amina', currency: 'KES', balanceMinor: 20000n, reservedMinor: 0n });
  store.customers.set('amina', { id: 'amina', axoTag: '@amina', status: 'active', walletId: wid });
}
const tx: any = {
  agent: {
    findUniqueOrThrow: async ({ where }: any) => { const a = [...store.agents.values()].find(x => x.code === where.code || x.id === where.id); if (!a) throw new Error('no agent'); return a; },
    update: async ({ where, data }: any) => { const a = store.agents.get(where.id); if (data.floatMinor?.increment !== undefined) a.floatMinor += data.floatMinor.increment; if (data.floatMinor?.decrement !== undefined) a.floatMinor -= data.floatMinor.decrement; if (data.commissionMinor?.increment !== undefined) a.commissionMinor += data.commissionMinor.increment; return a; },
  },
  agentTxn: {
    findUnique: async ({ where }: any) => [...store.agentTxns.values()].find(t => t.idempotencyKey === where.idempotencyKey) ?? null,
    create: async ({ data }: any) => { const id = 'at_' + ++store.seq; const row = { id, ...data }; store.agentTxns.set(id, row); return row; },
  },
  customer: {
    findUniqueOrThrow: async ({ where }: any) => { const c = store.customers.get(where.id); if (!c) throw new Error('no cust'); return { ...c, wallet: store.wallets.get(c.walletId) }; },
    findUnique: async ({ where }: any) => { if (where.axoTag) { const c = [...store.customers.values()].find(x => x.axoTag === where.axoTag); return c ? { ...c, wallet: store.wallets.get(c.walletId) } : null; } const c = store.customers.get(where.id); return c ? { ...c, wallet: store.wallets.get(c.walletId) } : null; },
    create: async ({ data }: any) => { const id = 'sys_' + ++store.seq; const wid = 'w_' + id; store.wallets.set(wid, { id: wid, customerId: id, currency: data.currency, balanceMinor: 0n, reservedMinor: 0n }); const c = { id, axoTag: data.axoTag, status: 'active', walletId: wid }; store.customers.set(id, c); return { ...c, wallet: store.wallets.get(wid) }; },
  },
  customerLedgerEntry: { create: async ({ data }: any) => { store.ledger.push(data); return data; } },
  customerAccount: { update: async ({ where, data }: any) => { const w = store.wallets.get(where.id); w.balanceMinor += data.balanceMinor.increment; return w; } },
};
vi.mock('../src/db/client.js', () => ({ prisma: {}, inTransaction: (fn: any) => fn(tx) }));
const { agentCashIn, agentCashOut } = await import('../src/modules/agent/agent.service.js');

describe('agent cash-in/out (service)', () => {
  beforeEach(reset);
  it('cash-in: float down, wallet up, commission accrues, ledger balances', async () => {
    await agentCashIn({ agentCode: 'AG1', customerId: 'amina', amountMinor: 30000n });
    expect(store.agents.get('AG1').floatMinor).toBe(70000n);         // 100000 - 30000
    expect(store.wallets.get('w_amina').balanceMinor).toBe(50000n);  // 20000 + 30000
    expect(store.agents.get('AG1').commissionMinor).toBe(150n);      // 0.5% of 30000
    const net = store.ledger.reduce((n, e) => n + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n);
    expect(net).toBe(0n);
  });
  it('cash-in blocked beyond agent float', async () => {
    await expect(agentCashIn({ agentCode: 'AG1', customerId: 'amina', amountMinor: 999999n })).rejects.toThrow(/float/);
  });
  it('cash-out: wallet down, float up', async () => {
    await agentCashOut({ agentCode: 'AG1', customerId: 'amina', amountMinor: 15000n });
    expect(store.wallets.get('w_amina').balanceMinor).toBe(5000n);   // 20000 - 15000
    expect(store.agents.get('AG1').floatMinor).toBe(115000n);        // 100000 + 15000
  });
  it('cash-out blocked beyond customer balance', async () => {
    await expect(agentCashOut({ agentCode: 'AG1', customerId: 'amina', amountMinor: 999999n })).rejects.toThrow(/insufficient/);
  });
});
