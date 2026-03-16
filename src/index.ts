import express from 'express';
import { createApp, startApp, checkDbConnection } from '@leasebase/service-common';
import { paymentsRouter } from './routes/payments';
import { connectRouter } from './routes/connect';
import { webhooksRouter } from './routes/webhooks';
import { receiptsRouter } from './routes/receipts';
import { jobsRouter } from './routes/jobs';
import { initStripe } from './stripe/client';

// Initialize Stripe client from secrets/env
initStripe();

const app = createApp({
  healthChecks: [{ name: 'database', check: checkDbConnection }],
});

// Webhook routes need raw body for Stripe signature verification.
// Mount BEFORE the JSON-parsed routes.
app.use(
  '/internal/payments/webhooks',
  express.raw({ type: 'application/json' }),
  webhooksRouter,
);

// Standard JSON-parsed routes
app.use('/internal/payments/connect', connectRouter);
app.use('/internal/payments/jobs', jobsRouter);
app.use('/internal/payments', receiptsRouter);
app.use('/internal/payments', paymentsRouter);

startApp(app);
