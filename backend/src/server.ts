import { buildApp } from './app.js';
import { env } from './config/env.js';
import { dispatchDueDeliveries } from './modules/notify/outbox.service.js';
import { sweepExpiredClaims } from './modules/p2p/claim.service.js';

const app = buildApp();

// Background work. Each loop is safe to run in several processes at once: the
// outbox claims a delivery before sending it, and the claim sweep refunds a
// claim only from 'unclaimed'.
function every(ms: number, name: string, job: () => Promise<unknown>) {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    job()
      .catch((err) => app.log.error({ err }, `${name} failed`))
      .finally(() => { running = false; });
  }, ms).unref();
}
every(5_000, 'webhook dispatch', () => dispatchDueDeliveries());
every(60_000, 'claim expiry sweep', () => sweepExpiredClaims());

app
  .listen({ port: env.PORT, host: '0.0.0.0' })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`Axo Business API listening on :${env.PORT} (${env.APP_ENV})`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
