import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = buildApp();

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
