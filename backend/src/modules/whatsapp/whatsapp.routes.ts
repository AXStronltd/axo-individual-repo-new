import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import {
  verifySubscription,
  verifySignature,
  extractMessage,
  parseIntent,
} from './whatsapp.lib.js';
import {
  claimWebhookEvent,
  customerForWaId,
  hasLiveSession,
  issueOtp,
  confirmLink,
  verifyOtp,
} from './whatsapp.service.js';
import { makeSender } from './whatsapp.sender.js';
import { sendP2P, payByNumber } from '../p2p/p2p.service.js';
import { approvePush, declinePush } from '../collect/collect.service.js';
import { sendToUnregistered, refundClaimable, claimTransfer, claimByIdentity } from '../p2p/claim.service.js';
import { setPin, hasPin } from '../p2p/pin.service.js';
import { formatMiniStatement } from '../p2p/statement.lib.js';
import { stageConfirm, resolveConfirm, cancelConfirm, hasPendingConfirm } from './confirm.service.js';
import { amountToMinor, formatAmount, coachUnknown } from './chat.lib.js';
import { startCashOut } from '../cash/cash.service.js';
import { agentCashOut } from '../agent/agent.service.js';
import { buyBiller } from '../billers/billers.service.js';
import { reverseTransfer } from '../p2p/reversal.service.js';
import { verifyPin } from '../p2p/pin.service.js';
import { normalizeTag, normalizeWaId } from '../p2p/p2p.lib.js';
import { prisma } from '../../db/client.js';
import { formatMinor } from '../../lib/money.js';

const sender = makeSender();

export async function whatsappRoutes(app: FastifyInstance) {
  // The raw body is preserved on req.rawBody by the global parser in app.ts, so
  // the HMAC signature can be verified over the exact bytes Meta signed.

  // Meta subscription handshake.
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const challenge = verifySubscription({
      mode: q['hub.mode'],
      token: q['hub.verify_token'],
      challenge: q['hub.challenge'],
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    });
    if (challenge === null) return reply.code(403).send('forbidden');
    return reply.code(200).send(challenge);
  });

  // Inbound messages + status callbacks.
  app.post('/webhooks/whatsapp', async (req, reply) => {
    const raw = (req as any).rawBody ?? '';
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    if (!verifySignature(raw, sig, env.WHATSAPP_APP_SECRET)) {
      return reply.code(401).send({ error: 'bad_signature' });
    }
    // Always 200 quickly so Meta doesn't retry a message we already took.
    const msg = extractMessage(req.body);
    if (!msg) return reply.code(200).send({ ignored: true });

    const first = await claimWebhookEvent(msg.eventId);
    if (!first) return reply.code(200).send({ duplicate: true }); // de-dup retries

    try {
      await routeMessage(msg.waId, msg.text);
    } catch (e) {
      // Never leak internals to the chat; log server-side (fastify logger).
      req.log.error({ err: e }, 'whatsapp route error');
      await reply_safe(msg.waId, 'Something went wrong. Please try again in a moment.');
    }
    return reply.code(200).send({ ok: true });
  });
}

async function reply_safe(waId: string, body: string) {
  if (sender.available) await sender.send({ to: waId, body });
}

/**
 * The conversational router. Deliberately small: each intent maps to one safe
 * action. Money actions require a live verified session; a linked number alone
 * is never enough.
 */
async function routeMessage(waId: string, text: string) {
  const intent = parseIntent(text);
  const customer = await customerForWaId(waId);

  if (intent.kind === 'help') {
    return reply_safe(waId, menuText(!!customer));
  }

  if (intent.kind === 'register') {
    if (customer) return reply_safe(waId, `You already have an Axo wallet (${customer.axoTag}). Reply BALANCE or SEND.`);
    const { code } = await issueOtp(waId, 'link');
    // In live, the code is delivered by the template message; in sandbox it is
    // placed in the outbox. We never echo the code back into this same thread.
    await reply_safe(waId, 'Welcome to Axo. We sent you a 6-digit code — reply with it to verify your number.');
    // sandbox convenience: surface code via a separate message so tests can read it
    if (sender.name === 'whatsapp-sandbox') await sender.send({ to: waId, body: `[sandbox code] ${code}` });
    return;
  }

  if (intent.kind === 'verify') {
    const res = await verifyOtp(waId, 'link', intent.code);
    if (!res.ok) return reply_safe(waId, res.reason === 'expired' ? 'That code expired. Reply REGISTER to get a new one.' : 'That code is not right. Try again.');
    let c = await customerForWaId(waId);
    if (!c) { await provisionWallet(waId); c = await customerForWaId(waId); }
    else { await confirmLink(waId, c.id); }
    // FIRST-CONTACT: if they were trying to pay a business before signing up,
    // finish that payment now — so "anyone with WhatsApp can pay like M-Pesa".
    const resumed = await resumePendingPay(waId, c!);
    if (resumed) return;
    return reply_safe(waId, `✅ Verified. Your Axo tag is ${c!.axoTag}. Reply BALANCE, or SEND <amount> to @tag.`);
  }

  // CLAIM a send-to-unregistered — works even with no wallet yet (it provisions one).
  if (intent.kind === 'claim') {
    let r = await claimTransfer({ code: intent.code, recipientWaId: waId });
    // Identity fallback: the money was addressed to a number this person no longer
    // uses (lost phone / changed number), but they are signed in here on a verified
    // Axo account. Their proven identity — not the old number — is the authority,
    // so settle it to their wallet. Only an already-verified customer qualifies.
    if (r.status === 'rejected' && 'reason' in r && r.reason === 'wrong_recipient' && customer) {
      r = await claimByIdentity({ code: intent.code, customerId: customer.id });
    }
    if (r.status === 'claimed') return reply_safe(waId, `✅ Claimed! The money is now in your Axo wallet. Reply BALANCE to see it.`);
    const why = ('reason' in r && r.reason) || 'unknown';
    return reply_safe(waId, `Couldn't claim ${intent.code}: ${why}.`);
  }

  // A brand-new number trying to PAY A BUSINESS: don't turn them away — start
  // instant onboarding, remember what they wanted to pay, and finish it after
  // they verify. This is the M-Pesa-like "anyone can just pay" behaviour.
  if (!customer && (intent.kind === 'pay_till' || intent.kind === 'pay_bill' || intent.kind === 'confirm')) {
    return startPayOnboarding(waId, intent);
  }

  if (!customer) {
    return reply_safe(waId, 'You need an Axo wallet first. Reply REGISTER to start — no SIM, no app to install.');
  }

  // A staged money action awaiting confirmation takes PRIORITY: a PIN, a bare
  // code, or YES confirms it; NO cancels. This is the "enter PIN to pay" step.
  if (await hasPendingConfirm(waId)) {
    if (intent.kind === 'cancel') { await cancelConfirm(waId); return reply_safe(waId, 'Cancelled. Nothing was sent.'); }
    if (intent.kind === 'pin' || intent.kind === 'verify' || intent.kind === 'confirm') {
      const secret = intent.kind === 'pin' ? intent.pin : intent.kind === 'verify' ? intent.code : 'YES';
      const r = await resolveConfirm(waId, customer.id, secret);
      if (!r.ok) {
        const m: Record<string, string> = {
          none: 'Nothing to confirm.', expired: 'That confirmation expired — please start again.',
          wrong_pin: 'Wrong PIN. Try again, or reply NO to cancel.', locked: 'Too many wrong PINs — your account is locked for safety. Contact support.',
          need_pin: 'Reply with your PIN to confirm, or NO to cancel.',
        };
        return reply_safe(waId, m[r.reason] ?? 'Could not confirm.');
      }
      return executeConfirmed(waId, customer, r.action);
    }
    // anything else while a confirm is pending: re-show the prompt
    return reply_safe(waId, 'You have a payment waiting. Reply with your PIN (or YES) to confirm, or NO to cancel.');
  }

  // Approve / decline a pending STK-style push with YES / NO.
  if (intent.kind === 'confirm' || intent.kind === 'cancel') {
    const pending = await prisma.pushPrompt.findFirst({ where: { customerId: customer.id, status: 'pending' }, orderBy: { createdAt: 'desc' } });
    if (!pending) return reply_safe(waId, intent.kind === 'confirm' ? 'Nothing to approve right now.' : 'Nothing to cancel.');
    if (intent.kind === 'cancel') { await declinePush(pending.ref); return reply_safe(waId, 'Declined. Nothing was charged.'); }
    if (!(await hasLiveSession(waId))) return reply_safe(waId, 'Please verify again before approving. Reply REGISTER.');
    const r = await approvePush(pending.ref);
    if (r.status === 'approved') return reply_safe(waId, `✅ Approved — ${customer.currency} ${formatMinor(pending.amountMinor, 0)} paid.`);
    return reply_safe(waId, `Couldn't approve: ${('reason' in r && r.reason) || 'try again'}.`);
  }

  if (intent.kind === 'balance') {
    const bal = customer.wallet ? formatAmount(customer.wallet.balanceMinor, customer.currency) : `${customer.currency} 0`;
    return reply_safe(waId, `💰 ${customer.axoTag}\nBalance: ${bal}`);
  }

  if (intent.kind === 'history') {
    const xfers = await prisma.p2PTransfer.findMany({
      where: { OR: [{ senderId: customer.id }, { recipientId: customer.id }] },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    if (!xfers.length) return reply_safe(waId, 'No transactions yet.');
    const lines = xfers.map((x: any) => {
      const out = x.senderId === customer.id;
      return `${out ? '−' : '+'} ${customer.currency} ${formatMinor(x.amountMinor, 0)} · ${x.status}`;
    });
    return reply_safe(waId, '🧾 Recent:\n' + lines.join('\n'));
  }

  if (intent.kind === 'setpin') {
    await setPin(customer.id, intent.pin);
    return reply_safe(waId, '🔒 Your PIN is set. You\'ll be asked for it before sending money.');
  }

  if (intent.kind === 'mini') {
    const rows = await prisma.p2PTransfer.findMany({
      where: { OR: [{ senderId: customer.id }, { recipientId: customer.id }] },
      orderBy: { createdAt: 'desc' }, take: 5,
    });
    const mapped = rows.map((x: any) => ({ direction: x.senderId === customer.id ? 'out' as const : 'in' as const, amountMinor: x.amountMinor, status: x.status, note: x.note }));
    return reply_safe(waId, formatMiniStatement(mapped, customer.currency, 0));
  }

  if (intent.kind === 'recall') {
    const r = await refundClaimable({ code: intent.code, by: 'sender' });
    return reply_safe(waId, r.ok ? `↩️ Recalled — ${intent.code} refunded to your balance.` : `Couldn't recall ${intent.code}: ${r.reason}.`);
  }

  // RECEIVE CRYPTO — symmetric with the business "receive crypto". Shows the
  // customer's deposit address so anyone, anywhere, can pay them in stablecoin.
  if (intent.kind === 'receive_crypto') {
    const addr = cryptoAddressFor(customer.id);
    return reply_safe(waId, `👛 Your Axo crypto address (USDC/USDT):\n${addr}\n\nAnyone can send you stablecoin here — it lands in your Axo wallet once confirmed on-chain. No bank, no borders.`);
  }

  // SEND GLOBALLY — symmetric with the business "send globally". Quotes the FX
  // and stages a confirm; on PIN/YES it goes out through the cross-border ramp.
  if (intent.kind === 'send_global') {
    if (!(await hasLiveSession(waId))) return reply_safe(waId, 'Please verify again before sending. Reply REGISTER.');
    const amountMinor = amountToMinor(intent.amount, customer.currency);
    if (amountMinor === null) return reply_safe(waId, 'Enter a valid amount, e.g. GLOBAL 100 USD to 0xabc…');
    const summary = `Send ${formatAmount(amountMinor, customer.currency)} → ${intent.toCurrency} to ${intent.dest}`;
    await stageConfirm({ waId, action: 'send_global', amountMinor, currency: customer.currency, summary, toPhone: intent.dest, account: intent.toCurrency, note: 'global' });
    return reply_safe(waId, confirmPrompt(summary + ' (cross-border, FX + fee shown at settlement)', await hasPin(customer.id)));
  }

  // WITHDRAW cash at an agent (e.g. Amran) — the individual side of agentCashOut.
  if (intent.kind === 'withdraw') {
    if (!(await hasLiveSession(waId))) return reply_safe(waId, 'Please verify again before withdrawing. Reply REGISTER.');
    const amountMinor = amountToMinor(intent.amount, customer.currency);
    if (amountMinor === null) return reply_safe(waId, 'Enter a valid amount, e.g. WITHDRAW 1000 from AMRAN.');
    const summary = `Withdraw ${formatAmount(amountMinor, customer.currency)} at agent ${intent.agent}`;
    await stageConfirm({ waId, action: 'withdraw', amountMinor, currency: customer.currency, summary, number: intent.agent });
    return reply_safe(waId, confirmPrompt(summary, await hasPin(customer.id)));
  }

  // BUY AIRTIME / data.
  if (intent.kind === 'airtime') {
    if (!(await hasLiveSession(waId))) return reply_safe(waId, 'Please verify again first. Reply REGISTER.');
    const amountMinor = amountToMinor(intent.amount, customer.currency);
    if (amountMinor === null) return reply_safe(waId, 'Enter a valid amount, e.g. AIRTIME 100.');
    const who = intent.phone ?? 'your own number';
    const summary = `Buy ${formatAmount(amountMinor, customer.currency)} airtime for ${who}`;
    await stageConfirm({ waId, action: 'airtime', amountMinor, currency: customer.currency, summary, toPhone: intent.phone ?? '', note: 'airtime' });
    return reply_safe(waId, confirmPrompt(summary, await hasPin(customer.id)));
  }

  // PAY A UTILITY BILL (electricity token, water, TV, internet).
  if (intent.kind === 'bill') {
    if (!(await hasLiveSession(waId))) return reply_safe(waId, 'Please verify again first. Reply REGISTER.');
    const amountMinor = amountToMinor(intent.amount, customer.currency);
    if (amountMinor === null) return reply_safe(waId, 'Enter a valid amount, e.g. BILL power 123456 500.');
    const kind = billerKind(intent.biller);
    const summary = `Pay ${formatAmount(amountMinor, customer.currency)} — ${kind} (${intent.account})`;
    await stageConfirm({ waId, action: 'bill', amountMinor, currency: customer.currency, summary, number: kind, account: intent.account });
    return reply_safe(waId, confirmPrompt(summary, await hasPin(customer.id)));
  }

  // REQUEST money from someone — sends them a pay prompt they can approve.
  if (intent.kind === 'request') {
    const tag = normalizeTag(intent.from);
    const target = tag ? await prisma.customer.findUnique({ where: { axoTag: tag }, include: { waLink: true } }) : null;
    const amountMinor = amountToMinor(intent.amount, customer.currency);
    if (amountMinor === null) return reply_safe(waId, 'Enter a valid amount, e.g. REQUEST 500 from @amina.');
    if (!target) return reply_safe(waId, `Couldn't find ${intent.from} on Axo to request from.`);
    // Notify the payer with a ready-to-send command (they still confirm on their side).
    if (sender.available && target.waLink?.waId) {
      await sender.send({ to: target.waLink.waId, body: `🙋 ${customer.axoTag} is requesting ${formatAmount(amountMinor, customer.currency)}${intent.note ? ' for ' + intent.note : ''}.\nReply SEND ${intent.amount} to ${customer.axoTag} to pay.` });
    }
    return reply_safe(waId, `📨 Request for ${formatAmount(amountMinor, customer.currency)} sent to ${target.axoTag}. You'll be notified if they pay.`);
  }

  // REVERSE a completed send (within the window).
  if (intent.kind === 'reverse_txn') {
    const xfer = await prisma.p2PTransfer.findFirst({ where: { senderId: customer.id, status: 'completed' }, orderBy: { createdAt: 'desc' } });
    if (!xfer) return reply_safe(waId, 'No recent send to reverse.');
    try {
      await reverseTransfer({ transferId: xfer.id, byCustomerId: customer.id });
      return reply_safe(waId, `↩️ Reversed your last send of ${formatAmount(xfer.amountMinor, customer.currency)} — it's back in your balance.`);
    } catch (e) { return reply_safe(waId, `Couldn't reverse: ${(e as Error).message}.`); }
  }

  // CHANGE PIN (needs the old PIN).
  if (intent.kind === 'changepin') {
    if (await hasPin(customer.id)) {
      const v = await verifyPin(customer.id, intent.oldPin);
      if (!v.ok) return reply_safe(waId, 'Your current PIN is wrong. Try CHANGEPIN <old> <new> again.');
    }
    await setPin(customer.id, intent.newPin);
    return reply_safe(waId, '🔒 Your PIN has been changed.');
  }

  // Send to a phone number — registered OR not. STAGE it; confirm before moving.
  if (intent.kind === 'send_phone') {
    if (!(await hasLiveSession(waId))) return reply_safe(waId, 'Please verify again before sending. Reply REGISTER.');
    const amountMinor = amountToMinor(intent.amount, customer.currency);
    if (amountMinor === null) return reply_safe(waId, 'Enter a valid amount, e.g. SENDTO +254711 500');
    const summary = `Send ${formatAmount(amountMinor, customer.currency)} to ${intent.phone}`;
    await stageConfirm({ waId, action: 'send_phone', amountMinor, currency: customer.currency, summary, toPhone: intent.phone, note: intent.note });
    return reply_safe(waId, confirmPrompt(summary, await hasPin(customer.id)));
  }

  if (intent.kind === 'send') {
    if (!(await hasLiveSession(waId))) return reply_safe(waId, 'For your security, please verify again before sending. Reply REGISTER to re-verify.');
    const tag = normalizeTag(intent.to);
    if (!tag) return reply_safe(waId, 'That recipient tag looks wrong. Use e.g. SEND 500 to @amina');
    const recipient = await prisma.customer.findUnique({ where: { axoTag: tag } });
    if (!recipient) return reply_safe(waId, `No Axo user found for ${tag}. Check the tag, or use SENDTO <phone> <amount>.`);
    const amountMinor = amountToMinor(intent.amount, customer.currency);
    if (amountMinor === null) return reply_safe(waId, 'Enter a valid amount, e.g. SEND 500 to @amina');
    const summary = `Send ${formatAmount(amountMinor, customer.currency)} to ${recipient.axoTag}`;
    await stageConfirm({ waId, action: 'send', amountMinor, currency: customer.currency, summary, toTag: recipient.axoTag, note: intent.note });
    return reply_safe(waId, confirmPrompt(summary, await hasPin(customer.id)));
  }

  // PAY A BUSINESS by Till / Paybill — STAGE it; confirm before moving.
  if (intent.kind === 'pay_till' || intent.kind === 'pay_bill') {
    if (!(await hasLiveSession(waId))) return reply_safe(waId, 'For your security, please verify again before paying. Reply REGISTER to re-verify.');
    const amountMinor = amountToMinor(intent.amount, customer.currency);
    if (amountMinor === null) return reply_safe(waId, 'Enter a valid amount.');
    const kind = intent.kind === 'pay_till' ? 'till' : 'paybill';
    const number = intent.kind === 'pay_till' ? intent.till : intent.paybill;
    const account = intent.kind === 'pay_bill' ? intent.account : undefined;
    const where = kind === 'till' ? `Till ${number}` : `Paybill ${number} (a/c ${account})`;
    const summary = `Pay ${formatAmount(amountMinor, customer.currency)} to ${where}`;
    await stageConfirm({ waId, action: kind === 'till' ? 'pay_till' : 'pay_bill', amountMinor, currency: customer.currency, summary, number, account });
    return reply_safe(waId, confirmPrompt(summary, await hasPin(customer.id)));
  }

  // Friendlier fallback: try to tell what they meant and guide them.
  const coach = coachUnknown(text);
  return reply_safe(waId, coach ?? ("I didn't catch that. " + menuText(true)));
}

/** Map a biller keyword to its canonical kind. */
function billerKind(word: string): 'airtime' | 'electricity' | 'water' | 'tv' | 'internet' | 'other' {
  const w = (word || '').toLowerCase();
  if (/power|electric|kplc|token|umeme/.test(w)) return 'electricity';
  if (/water|maji/.test(w)) return 'water';
  if (/tv|dstv|gotv|startimes|zuku/.test(w)) return 'tv';
  if (/internet|wifi|fibre|fiber|data/.test(w)) return 'internet';
  if (/airtime/.test(w)) return 'airtime';
  return 'other';
}

/** A deterministic display deposit address for a customer. The real address is
 *  minted by the crypto custody provider at go-live; this is a stable stand-in. */
function cryptoAddressFor(customerId: string): string {
  let h = 0; for (const c of customerId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hex = (h.toString(16) + '0'.repeat(8)).slice(0, 8);
  return `0x${hex}…axo${(h % 9000 + 1000)}`;
}

/** The "Pay X to Y? reply PIN / YES" prompt shown before any money moves. */
function confirmPrompt(summary: string, pinSet: boolean): string {
  return pinSet
    ? `Confirm: ${summary}.\nReply with your PIN to send, or NO to cancel.`
    : `Confirm: ${summary}.\nReply YES to send, or NO to cancel.\n(Tip: set a PIN with SETPIN 1234 for extra safety.)`;
}

/** Execute a confirmed money action (the router calls this after PIN/YES check). */
async function executeConfirmed(waId: string, customer: any, p: any) {
  if (p.action === 'send') {
    const recipient = await prisma.customer.findUnique({ where: { axoTag: p.toTag } });
    if (!recipient) return reply_safe(waId, 'That recipient is no longer available.');
    try {
      const xfer = await sendP2P({ senderId: customer.id, recipientId: recipient.id, amountMinor: p.amountMinor, currency: p.currency, note: p.note ?? undefined });
      await reply_safe(waId, `✅ Sent ${formatAmount(xfer.amountMinor, p.currency)} to ${recipient.axoTag}.`);
      const rLink = await prisma.whatsAppLink.findUnique({ where: { customerId: recipient.id } });
      if (rLink) await reply_safe(rLink.waId, `💰 You received ${formatAmount(xfer.amountMinor, recipient.currency)} from ${customer.axoTag}.`);
    } catch (e) { return reply_safe(waId, `Couldn't send: ${(e as Error).message}.`); }
    return;
  }
  if (p.action === 'send_phone') {
    try {
      const ct = await sendToUnregistered({ senderId: customer.id, recipientPhone: p.toPhone, amountMinor: p.amountMinor, currency: p.currency, note: p.note ?? undefined });
      await reply_safe(waId, `📤 ${formatAmount(p.amountMinor, p.currency)} reserved for ${p.toPhone}. They'll get a claim message (code ${(ct as any).code}). Reply RECALL ${(ct as any).code} to cancel if unclaimed.`);
      if (sender.available) await sender.send({ to: String(p.toPhone).replace(/^\+/, ''), body: `💸 You've been sent ${formatAmount(p.amountMinor, p.currency)} on Axo. Reply CLAIM ${(ct as any).code} to receive it — no app, no SIM needed.` });
    } catch (e) {
      const msg = (e as Error).message;
      return reply_safe(waId, msg.includes('already has an Axo wallet') ? 'That number is already on Axo — use SEND <amount> to @their-tag.' : `Couldn't send: ${msg}.`);
    }
    return;
  }
  if (p.action === 'pay_till' || p.action === 'pay_bill') {
    const kind = p.action === 'pay_till' ? 'till' : 'paybill';
    try {
      const r = await payByNumber({ customerId: customer.id, kind, number: p.number, account: p.account ?? undefined, amountMinor: p.amountMinor, currency: p.currency });
      if (r.status === 'rejected') {
        return reply_safe(waId, r.reason === 'unknown_account_line' ? `That account isn't recognised for paybill ${p.number}.` : `No Axo business found for that ${kind} number.`);
      }
      const where = kind === 'till' ? `Till ${p.number}` : `Paybill ${p.number} (a/c ${p.account})`;
      await reply_safe(waId, `✅ Paid ${formatAmount(p.amountMinor, p.currency)} to ${where}.`);
    } catch (e) { return reply_safe(waId, `Couldn't pay: ${(e as Error).message}.`); }
    return;
  }
  if (p.action === 'send_global') {
    // destination currency was stashed in `account`, the destination in `toPhone`.
    try {
      const r: any = await startCashOut({ customerId: customer.id, amountMinor: p.amountMinor, currency: p.currency, destination: `${p.account}:${p.toPhone}` });
      if (r.status === 'unavailable') return reply_safe(waId, 'Global send isn’t available yet in your region — it needs a cross-border rail. Your money was not touched.');
      await reply_safe(waId, `🌐 Sending ${formatAmount(p.amountMinor, p.currency)} to ${p.toPhone} (${p.account}). You’ll get a confirmation when it settles.`);
    } catch (e) { return reply_safe(waId, `Couldn't send globally: ${(e as Error).message}.`); }
    return;
  }
  if (p.action === 'withdraw') {
    try {
      await agentCashOut({ agentCode: p.number, customerId: customer.id, amountMinor: p.amountMinor, currency: p.currency });
      await reply_safe(waId, `🏧 Withdraw approved. Collect ${formatAmount(p.amountMinor, p.currency)} cash from agent ${p.number}. New balance: ${formatAmount((customer.wallet?.balanceMinor ?? 0n) - p.amountMinor, p.currency)}.`);
    } catch (e) {
      const m = (e as Error).message;
      return reply_safe(waId, m.includes('no agent') || m.includes('not found') ? `Agent ${p.number} not found. Check the agent code.` : `Couldn't withdraw: ${m}.`);
    }
    return;
  }
  if (p.action === 'airtime') {
    try {
      await buyBiller({ customerId: customer.id, kind: 'airtime', target: p.toPhone || 'self', amountMinor: p.amountMinor, currency: p.currency });
      const who = p.toPhone ? p.toPhone : 'your number';
      await reply_safe(waId, `📱 ${formatAmount(p.amountMinor, p.currency)} airtime sent to ${who}.`);
    } catch (e) { return reply_safe(waId, `Couldn't buy airtime: ${(e as Error).message}.`); }
    return;
  }
  if (p.action === 'bill') {
    try {
      const purchase: any = await buyBiller({ customerId: customer.id, kind: p.number, target: p.account, amountMinor: p.amountMinor, currency: p.currency });
      let msg = `✅ Paid ${formatAmount(p.amountMinor, p.currency)} — ${p.number} (${p.account}).`;
      if (purchase?.token) msg += `\n⚡ Your token: ${purchase.token}\nEnter it on your meter.`;
      await reply_safe(waId, msg);
    } catch (e) { return reply_safe(waId, `Couldn't pay the bill: ${(e as Error).message}.`); }
    return;
  }
}

/** Infer a new user's country+currency from their phone prefix. Somalia = USD. */
function countryCurrencyFor(digits: string): { country: string; currency: string } {
  if (digits.startsWith('252')) return { country: 'SO', currency: 'USD' }; // Somalia uses USD
  if (digits.startsWith('255')) return { country: 'TZ', currency: 'TZS' };
  if (digits.startsWith('256')) return { country: 'UG', currency: 'UGX' };
  if (digits.startsWith('254')) return { country: 'KE', currency: 'KES' };
  return { country: 'KE', currency: 'KES' }; // default
}

/** Create a wallet-holder for a WhatsApp number and link+verify it. */
async function provisionWallet(waId: string) {
  const digits = normalizeWaId(waId) ?? waId;
  const cc = countryCurrencyFor(digits);
  const created = await prisma.customer.create({
    data: {
      axoTag: '@u' + digits.slice(-7),
      displayName: 'Axo user ' + digits.slice(-4),
      country: cc.country, currency: cc.currency, status: 'unverified',
      wallet: { create: { currency: cc.currency } },
    },
  });
  await confirmLink(waId, created.id);
  return created;
}

/**
 * First-contact onboarding for a payer. An unknown number tried to pay a business;
 * we stash what they wanted, send an OTP, and tell them to verify. After they
 * verify, resumePendingPay finishes the payment automatically.
 */
async function startPayOnboarding(waId: string, intent: any) {
  const amountMinor = BigInt(Math.round(parseFloat(intent.amount ?? '0') * 1));
  if (intent.kind === 'confirm') {
    // They can't approve a push they don't have a wallet for; guide them.
    return reply_safe(waId, 'To pay with Axo, reply REGISTER first — it takes one message, no app to install.');
  }
  if (!(amountMinor > 0n)) return reply_safe(waId, 'Tell me the amount, e.g. PAY TILL 832909 500');
  await prisma.pendingPayIntent.upsert({
    where: { waId },
    update: {
      kind: intent.kind === 'pay_till' ? 'till' : 'paybill',
      number: intent.kind === 'pay_till' ? intent.till : intent.paybill,
      account: intent.kind === 'pay_bill' ? intent.account : null,
      amountMinor, currency: 'KES',
    },
    create: {
      waId,
      kind: intent.kind === 'pay_till' ? 'till' : 'paybill',
      number: intent.kind === 'pay_till' ? intent.till : intent.paybill,
      account: intent.kind === 'pay_bill' ? intent.account : null,
      amountMinor, currency: 'KES',
    },
  });
  const { code } = await issueOtp(waId, 'link');
  await reply_safe(waId, "You don't need an app — I'll set up your Axo in one step so you can pay. Reply with the 6-digit code I just sent to confirm your number.");
  if (sender.name === 'whatsapp-sandbox') await sender.send({ to: waId, body: `[sandbox code] ${code}` });
  return;
}

/** After a new payer verifies, execute the payment they were trying to make. */
async function resumePendingPay(waId: string, customer: any): Promise<boolean> {
  const p = await prisma.pendingPayIntent.findUnique({ where: { waId } });
  if (!p) return false;
  await prisma.pendingPayIntent.delete({ where: { waId } });
  try {
    const r = await payByNumber({
      customerId: customer.id,
      kind: p.kind as 'till' | 'paybill',
      number: p.number!,
      account: p.account ?? undefined,
      amountMinor: p.amountMinor,
      currency: p.currency,
    });
    if (r.status === 'rejected') {
      await reply_safe(waId, `✅ Your Axo wallet ${customer.axoTag} is ready — but that payment needs funds first. Top up, then try again.`);
      return true;
    }
    const where = p.kind === 'till' ? `Till ${p.number}` : `Paybill ${p.number} (a/c ${p.account})`;
    await reply_safe(waId, `✅ Welcome to Axo! Wallet ${customer.axoTag} created and ${p.currency} ${formatMinor(p.amountMinor, 0)} paid to ${where}.`);
  } catch (e) {
    await reply_safe(waId, `✅ Your Axo wallet ${customer.axoTag} is ready. Couldn't complete the payment: ${(e as Error).message}. Try again.`);
  }
  return true;
}

function menuText(linked: boolean) {
  return linked
    ? 'Axo menu:\n• BALANCE  • MINI\n• SEND <amount> to @tag\n• SENDTO <phone> <amount>\n• REQUEST <amount> from @tag\n• PAY TILL <no> <amount>\n• PAYBILL <no> <acct> <amount>\n• AIRTIME <amount> [phone]\n• BILL <power|water|tv> <acct> <amount>\n• WITHDRAW <amount> from <agent>\n• CRYPTO · GLOBAL <amt> <CUR> to <dest>\n• REVERSE <txn> · RECALL <code>\n• SETPIN <1234> · CHANGEPIN <old> <new>\n• HELP'
    : 'Welcome to Axo — money over WhatsApp.\n• REGISTER to open a wallet\n• CLAIM <code> if someone sent you money\n• HELP';
}
