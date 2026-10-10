import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { bigintReplacer } from '../../lib/money.js';
import { MAX_ATTEMPTS, SIGNATURE_HEADER, nextBackoffMs, signPayload } from './outbox.lib.js';

export type MerchantEvent = 'payment.succeeded' | 'payment.refunded' | 'payment_request.cancelled';

/**
 * Queue a merchant event for every active endpoint the merchant has registered.
 *
 * MUST be called with the transaction client of the money movement it describes:
 * that is what makes the outbox transactional — the payment and its notification
 * commit together or not at all, so a merchant is never told about money that
 * didn't move, and never misses money that did.
 */
export async function enqueueMerchantEvent(
  tx: PrismaClient,
  merchantId: string,
  event: MerchantEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const endpoints = await tx.merchantWebhook.findMany({ where: { merchantId, active: true } });
  for (const ep of endpoints) {
    const delivery = await tx.webhookDelivery.create({
      data: { merchantId, endpointId: ep.id, event, payloadJson: '' },
    });
    // The delivery id doubles as the event id the receiver de-dups on, so the
    // body is written once the id exists.
    const payload = JSON.stringify({ id: delivery.id, type: event, createdAt: delivery.createdAt.toISOString(), data }, bigintReplacer);
    await tx.webhookDelivery.update({ where: { id: delivery.id }, data: { payloadJson: payload } });
  }
}

type Poster = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

/**
 * Deliver due webhooks. At-least-once: a delivery is claimed (attempts bumped,
 * next attempt pushed out) BEFORE it is sent, so two dispatchers never send the
 * same attempt, and a crash mid-send just means it is retried later.
 */
export async function dispatchDueDeliveries(opts: { now?: Date; limit?: number; post?: Poster; timeoutMs?: number } = {}) {
  const now = opts.now ?? new Date();
  const post: Poster = opts.post ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) }));
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: opts.limit ?? 50,
  });

  let delivered = 0;
  let failed = 0;
  for (const d of due) {
    const attempts = d.attempts + 1;
    const claimed = await prisma.webhookDelivery.updateMany({
      where: { id: d.id, status: 'pending', attempts: d.attempts },
      data: { attempts, nextAttemptAt: new Date(now.getTime() + nextBackoffMs(attempts)) },
    });
    if (claimed.count !== 1) continue; // another dispatcher took it

    const endpoint = await prisma.merchantWebhook.findUnique({ where: { id: d.endpointId } });
    if (!endpoint || !endpoint.active) {
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'failed', lastError: 'endpoint_inactive' } });
      failed++;
      continue;
    }

    let error: string | null = null;
    try {
      const signature = signPayload(endpoint.secret, d.payloadJson, Math.floor(now.getTime() / 1000));
      const res = await post(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature, 'axo-event-id': d.id },
        body: d.payloadJson,
      });
      if (!res.ok) error = `http_${res.status}`;
    } catch (e) {
      error = (e as Error).name === 'TimeoutError' ? 'timeout' : 'network_error';
    }

    if (!error) {
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'delivered', deliveredAt: new Date(), lastError: null } });
      delivered++;
    } else {
      await prisma.webhookDelivery.update({
        where: { id: d.id },
        data: { lastError: error, ...(attempts >= MAX_ATTEMPTS ? { status: 'failed' as const } : {}) },
      });
      failed++;
    }
  }
  return { attempted: due.length, delivered, failed };
}
