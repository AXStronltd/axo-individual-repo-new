import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = { cases: new Map<string, any>(), customers: new Map<string, any>(), seq: 0 };
function reset() {
  store.cases.clear(); store.customers.clear(); store.seq = 0;
  store.customers.set('amina', { id: 'amina', status: 'active' });
}

const prismaFake: any = {
  customer: {
    update: async ({ where, data }: any) => { const c = store.customers.get(where.id); Object.assign(c, data); return c; },
  },
  riskCase: {
    create: async ({ data }: any) => { const id = 'case_' + ++store.seq; const row = { id, resolvedBy: null, resolvedAt: null, ...data }; store.cases.set(id, row); return row; },
    findUniqueOrThrow: async ({ where }: any) => { const c = store.cases.get(where.id); if (!c) throw new Error('not found'); return c; },
    update: async ({ where, data }: any) => { const row = { ...store.cases.get(where.id), ...data }; store.cases.set(where.id, row); return row; },
  },
  // $transaction runs an array of already-created promises (our fakes execute eagerly)
  $transaction: async (ops: any[]) => Promise.all(ops),
};

vi.mock('../src/db/client.js', () => ({ prisma: prismaFake, inTransaction: (fn: any) => fn(prismaFake) }));

const { freezeCustomer, releaseFreeze, resolveCase } = await import('../src/modules/risk/risk.service.js');

describe('freeze / release maker-checker', () => {
  beforeEach(reset);

  it('freezing sets the account to frozen and opens a case', async () => {
    const kase = await freezeCustomer({ customerId: 'amina', operatorId: 'op1', reason: 'suspicious' });
    expect(store.customers.get('amina').status).toBe('frozen');
    expect(kase.kind).toBe('manual_freeze');
    expect(kase.openedBy).toBe('op1');
  });

  it('the SAME operator cannot release the freeze (maker-checker)', async () => {
    const kase = await freezeCustomer({ customerId: 'amina', operatorId: 'op1', reason: 'x' });
    await expect(releaseFreeze({ caseId: kase.id, operatorId: 'op1' })).rejects.toThrow(/maker-checker/);
    expect(store.customers.get('amina').status).toBe('frozen'); // still frozen
  });

  it('a DIFFERENT operator can release, reactivating the account', async () => {
    const kase = await freezeCustomer({ customerId: 'amina', operatorId: 'op1', reason: 'x' });
    const r = await releaseFreeze({ caseId: kase.id, operatorId: 'op2' });
    expect(r.released).toBe(true);
    expect(store.customers.get('amina').status).toBe('active');
    expect(store.cases.get(kase.id).status).toBe('cleared');
    expect(store.cases.get(kase.id).resolvedBy).toBe('op2');
  });

  it('cannot release a case that is already resolved', async () => {
    const kase = await freezeCustomer({ customerId: 'amina', operatorId: 'op1', reason: 'x' });
    await releaseFreeze({ caseId: kase.id, operatorId: 'op2' });
    await expect(releaseFreeze({ caseId: kase.id, operatorId: 'op3' })).rejects.toThrow(/already resolved/);
  });
});

describe('resolveCase', () => {
  beforeEach(reset);
  it('a system-opened case can be resolved by any operator', async () => {
    const kase = await prismaFake.riskCase.create({ data: { kind: 'transaction_blocked', subjectType: 'customer', subjectId: 'amina', openedBy: 'system', status: 'under_review' } });
    const r = await resolveCase({ caseId: kase.id, operatorId: 'op1', outcome: 'confirmed' });
    expect(r.status).toBe('confirmed');
  });
});
