/**
 * Autopay notification helpers.
 *
 * Phase 1B continues the Phase 1 pattern of sending emails directly via SES.
 * Also creates in-app notifications via HTTP POST to notification-service.
 */
import { logger } from '@leasebase/service-common';

const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || '';
const SES_REGION = process.env.SES_REGION || process.env.AWS_REGION || 'us-west-2';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || '';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

function formatCurrency(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

// ── SES email helpers ────────────────────────────────────────────────────────

async function sendSesEmail(
  to: string,
  subject: string,
  htmlBody: string,
  textBody: string,
): Promise<boolean> {
  if (!SES_FROM_EMAIL) {
    logger.info({ to, subject, emailSkipped: true }, 'Email not sent — SES_FROM_EMAIL not configured');
    return false;
  }

  try {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const client = new SESv2Client({ region: SES_REGION });

    await client.send(new SendEmailCommand({
      FromEmailAddress: SES_FROM_EMAIL,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: { Html: { Data: htmlBody }, Text: { Data: textBody } },
        },
      },
    }));

    logger.info({ to, subject }, 'Autopay notification email sent');
    return true;
  } catch (err) {
    logger.error({ err, to, subject }, 'Failed to send autopay notification email');
    return false;
  }
}

// ── Autopay Success Email ────────────────────────────────────────────────────

export async function sendAutopaySuccessEmail(params: {
  toEmail: string;
  amount: number;
  currency: string;
  receiptNumber: string;
  billingPeriod: string | null;
}): Promise<boolean> {
  const amount = formatCurrency(params.amount, params.currency);
  const subject = `Autopay Payment Received — ${params.receiptNumber}`;

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #F8FAFC;">
  <div style="height: 4px; background: linear-gradient(90deg, #18D7F0 0%, #5EEA7A 60%, #D9FF1F 100%);"></div>
  <div style="padding: 32px 24px;">
    <div style="margin-bottom: 24px;"><span style="font-weight: 700; font-size: 18px; color: #0F172A; letter-spacing: 0.5px;">LeaseBase</span></div>
    <h2 style="color: #0F172A; margin: 0 0 16px;">Autopay Payment Received</h2>
    <p style="color: #334155;">Your autopay payment of <strong>${amount}</strong> has been successfully processed.</p>
    <p style="color: #334155;">Receipt #: <strong>${params.receiptNumber}</strong></p>
    ${params.billingPeriod ? `<p style="color: #334155;">Billing Period: ${params.billingPeriod}</p>` : ''}
    <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 24px 0;" />
    <p style="color: #64748b; font-size: 13px;">This is an automated payment from your enrolled autopay. No action is needed.</p>
    <p style="color: #94a3b8; font-size: 12px;">— LeaseBase · Property Performance Platform</p>
  </div>
</body></html>`.trim();

  const text = [
    'Autopay Payment Received',
    '',
    `Your autopay payment of ${amount} has been successfully processed.`,
    `Receipt #: ${params.receiptNumber}`,
    params.billingPeriod ? `Billing Period: ${params.billingPeriod}` : '',
    '',
    'This is an automated payment from your enrolled autopay.',
  ].filter(Boolean).join('\n');

  return sendSesEmail(params.toEmail, subject, html, text);
}

// ── Autopay Failure Email ────────────────────────────────────────────────────

export async function sendAutopayFailureEmail(params: {
  toEmail: string;
  amount: number;
  currency: string;
  failureReason: string | null;
  retryNumber: number;
  maxRetries: number;
  nextRetryDate: string | null;
}): Promise<boolean> {
  const amount = formatCurrency(params.amount, params.currency);
  const subject = 'Autopay Payment Failed — Action May Be Needed';

  const retryInfo = params.nextRetryDate
    ? `We will retry your payment on ${new Date(params.nextRetryDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} (attempt ${params.retryNumber + 1} of ${params.maxRetries}).`
    : '';

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #F8FAFC;">
  <div style="height: 4px; background: linear-gradient(90deg, #18D7F0 0%, #5EEA7A 60%, #D9FF1F 100%);"></div>
  <div style="padding: 32px 24px;">
    <div style="margin-bottom: 24px;"><span style="font-weight: 700; font-size: 18px; color: #0F172A; letter-spacing: 0.5px;">LeaseBase</span></div>
    <h2 style="color: #dc2626; margin: 0 0 16px;">Autopay Payment Failed</h2>
    <p style="color: #334155;">Your autopay payment of <strong>${amount}</strong> could not be processed.</p>
    ${params.failureReason ? `<p style="color: #334155;">Reason: ${params.failureReason}</p>` : ''}
    ${retryInfo ? `<p style="color: #334155;">${retryInfo}</p>` : ''}
    <p style="color: #334155;">You can also make a manual payment at any time through your tenant portal.</p>
    <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 24px 0;" />
    <p style="color: #64748b; font-size: 13px;">If you believe this is an error, please check your payment method or contact your property manager.</p>
    <p style="color: #94a3b8; font-size: 12px;">— LeaseBase · Property Performance Platform</p>
  </div>
</body></html>`.trim();

  const text = [
    'Autopay Payment Failed',
    '',
    `Your autopay payment of ${amount} could not be processed.`,
    params.failureReason ? `Reason: ${params.failureReason}` : '',
    retryInfo,
    '',
    'You can also make a manual payment at any time through your tenant portal.',
  ].filter(Boolean).join('\n');

  return sendSesEmail(params.toEmail, subject, html, text);
}

// ── Retry Exhausted Email ────────────────────────────────────────────────────

export async function sendRetryExhaustedEmail(params: {
  toEmail: string;
  amount: number;
  currency: string;
}): Promise<boolean> {
  const amount = formatCurrency(params.amount, params.currency);
  const subject = 'Autopay Failed — Manual Payment Required';

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #F8FAFC;">
  <div style="height: 4px; background: linear-gradient(90deg, #18D7F0 0%, #5EEA7A 60%, #D9FF1F 100%);"></div>
  <div style="padding: 32px 24px;">
    <div style="margin-bottom: 24px;"><span style="font-weight: 700; font-size: 18px; color: #0F172A; letter-spacing: 0.5px;">LeaseBase</span></div>
    <h2 style="color: #dc2626; margin: 0 0 16px;">Autopay Attempts Exhausted</h2>
    <p style="color: #334155;">After multiple attempts, we were unable to process your autopay payment of <strong>${amount}</strong>.</p>
    <p style="color: #334155;"><strong>Please make a manual payment through your tenant portal as soon as possible to avoid late fees.</strong></p>
    <p style="color: #334155;">You may also want to check or update your saved payment method.</p>
    <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 24px 0;" />
    <p style="color: #64748b; font-size: 13px;">Contact your property manager if you need assistance.</p>
    <p style="color: #94a3b8; font-size: 12px;">— LeaseBase · Property Performance Platform</p>
  </div>
</body></html>`.trim();

  const text = [
    'Autopay Attempts Exhausted',
    '',
    `After multiple attempts, we were unable to process your autopay payment of ${amount}.`,
    '',
    'Please make a manual payment through your tenant portal as soon as possible.',
    'You may also want to check or update your saved payment method.',
  ].join('\n');

  return sendSesEmail(params.toEmail, subject, html, text);
}
