import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { env } from './config/env.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { merchantRoutes } from './modules/merchants/merchants.routes.js';
import { paymentRoutes } from './modules/payments/payments.routes.js';
import { invoiceRoutes } from './modules/invoices/invoices.routes.js';
import { payoutRoutes } from './modules/payouts/payouts.routes.js';
import { reconciliationRoutes } from './modules/reconciliation/reconciliation.routes.js';
import { batchRoutes } from './modules/batches/batches.routes.js';
import { p2pRoutes } from './modules/p2p/p2p.routes.js';
import { whatsappRoutes } from './modules/whatsapp/whatsapp.routes.js';
import { cashRoutes } from './modules/cash/cash.routes.js';
import { riskRoutes } from './modules/risk/risk.routes.js';
import { collectRoutes } from './modules/collect/collect.routes.js';
import { globalRoutes } from './modules/global/global.routes.js';
import { extrasRoutes } from './modules/p2p/extras.routes.js';
import { agentRoutes } from './modules/agent/agent.routes.js';
import { payNumberRoutes } from './modules/merchants/paynumbers.routes.js';
import { customerRoutes } from './modules/customer/customer.routes.js';
import { integrationRoutes } from './modules/merchants/integrations.routes.js';
import { reportRoutes } from './modules/reports/reports.routes.js';

export function buildApp() {
  const app = Fastify({ logger: env.APP_ENV === 'live' });

  app.register(cors, { origin: true });
  app.register(jwt, {
    secret: { private: env.JWT_SECRET, public: env.JWT_SECRET },
    // a named key lets us sign refresh tokens with a different secret
    // (see auth.routes). Fastify-jwt verifies with the default secret.
  });

  // JSON body parser that PRESERVES the raw bytes on req.rawBody, so webhook
  // routes (WhatsApp, ramps) can verify HMAC signatures over exactly what was
  // sent. Registered once here, globally, rather than per-route.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  app.get('/health', async () => ({ ok: true, env: env.APP_ENV }));

  app.register(authRoutes);
  app.register(merchantRoutes);
  app.register(paymentRoutes);
  app.register(invoiceRoutes);
  app.register(payoutRoutes);
  app.register(reconciliationRoutes);
  app.register(batchRoutes);
  app.register(p2pRoutes);
  app.register(whatsappRoutes);
  app.register(cashRoutes);
  app.register(riskRoutes);
  app.register(collectRoutes);
  app.register(globalRoutes);
  app.register(extrasRoutes);
  app.register(agentRoutes);
  app.register(payNumberRoutes);
  app.register(customerRoutes);
  app.register(integrationRoutes);
  app.register(reportRoutes);

  return app;
}
