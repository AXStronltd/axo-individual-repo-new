// Outbound WhatsApp message sender. A documented integration: if the required
// credentials are not configured, it reports unavailable rather than pretending
// a message was sent (brief §7, §12). The live adapter calls the WhatsApp Cloud
// API graph endpoint; the sandbox records messages in memory for tests/dev.

import { env } from '../../config/env.js';

export interface OutboundMessage {
  to: string;        // recipient WhatsApp number (digits)
  body: string;      // plain text (templates would be a separate method)
}

export interface WhatsAppSender {
  readonly name: string;
  readonly available: boolean;
  send(msg: OutboundMessage): Promise<{ sent: boolean; id?: string; reason?: string }>;
}

// In-memory sandbox sender: deterministic, no network, inspectable in tests.
export class SandboxWhatsAppSender implements WhatsAppSender {
  readonly name = 'whatsapp-sandbox';
  readonly available = true;
  public outbox: OutboundMessage[] = [];
  async send(msg: OutboundMessage) {
    this.outbox.push(msg);
    return { sent: true, id: 'wamid.sbx_' + this.outbox.length };
  }
}

// Live Cloud API sender. Marked unavailable unless the phone-number id and token
// are configured, so an unconfigured deployment never silently drops messages.
export class CloudApiWhatsAppSender implements WhatsAppSender {
  readonly name = 'whatsapp-cloud';
  get available() {
    return Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TOKEN);
  }
  async send(msg: OutboundMessage) {
    if (!this.available) return { sent: false, reason: 'whatsapp_not_configured' };
    const url = `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: msg.to, type: 'text', text: { body: msg.body } }),
    });
    if (!res.ok) return { sent: false, reason: `cloud_api_${res.status}` };
    const json: any = await res.json().catch(() => ({}));
    return { sent: true, id: json?.messages?.[0]?.id };
  }
}

export function makeSender(): WhatsAppSender {
  return env.APP_ENV === 'live' ? new CloudApiWhatsAppSender() : new SandboxWhatsAppSender();
}
