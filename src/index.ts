import { createApp, startApp, checkDbConnection } from '@leasebase/service-common';
import { paymentsRouter } from './routes/payments';

const app = createApp({
  healthChecks: [{ name: 'database', check: checkDbConnection }],
});

app.use('/internal/payments', paymentsRouter);

startApp(app);
