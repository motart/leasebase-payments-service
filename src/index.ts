import { createApp, startApp, checkDbConnection } from '@leasebase/service-common';
import { paymentsRouter } from './routes/payments';
import { connectRouter } from './routes/connect';
import { webhooksRouter } from './routes/webhooks';
import { receiptsRouter } from './routes/receipts';
import { jobsRouter } from './routes/jobs';
import { paymentMethodsRouter } from './routes/payment-methods';
import { autopayRouter } from './routes/autopay';
import { adminRouter } from './routes/admin';
import { initStripe } from './stripe/client';

// Initialize Stripe client from secrets/env
initStripe();

const app = createApp({
  healthChecks: [{ name: 'database', check: checkDbConnection }],
  captureRawBody: true,
});

// Webhook routes use req.rawBody (captured by createApp's verify callback)
// for Stripe signature verification.
app.use('/internal/payments/webhooks', webhooksRouter);

// Standard JSON-parsed routes
app.use('/internal/payments/payment-methods', paymentMethodsRouter);
app.use('/internal/payments/autopay', autopayRouter);
app.use('/internal/payments/connect', connectRouter);
app.use('/internal/payments/jobs', jobsRouter);
app.use('/internal/payments', receiptsRouter);
app.use('/internal/payments', paymentsRouter);
app.use('/internal/payments/admin', adminRouter);

startApp(app);
