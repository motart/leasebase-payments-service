/**
 * Receipt email — sent directly via SES from payments-service (Phase 1).
 *
 * In Phase 2, receipt email delivery may move to notification-service
 * for template management and delivery tracking.
 */
import { logger } from '@leasebase/service-common';

const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || '';
const SES_REGION = process.env.SES_REGION || process.env.AWS_REGION || 'us-west-2';
const NODE_ENV = process.env.NODE_ENV || 'development';

export const isSesConfigured = Boolean(SES_FROM_EMAIL);

interface ReceiptEmailParams {
  toEmail: string;
  receiptNumber: string;
  amount: number; // cents
  currency: string;
  billingPeriod: string | null;
  propertyName: string | null;
  unitNumber: string | null;
  paymentMethodSummary: string | null;
  paidAt: string; // ISO date
}

function formatCurrency(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function buildReceiptHtml(params: ReceiptEmailParams): string {
  const amount = formatCurrency(params.amount, params.currency);
  const propertyLine = params.propertyName
    ? `<p>Property: <strong>${params.propertyName}</strong>${params.unitNumber ? ` — Unit ${params.unitNumber}` : ''}</p>`
    : '';
  const periodLine = params.billingPeriod
    ? `<p>Billing Period: ${params.billingPeriod}</p>`
    : '';
  const methodLine = params.paymentMethodSummary
    ? `<p>Payment Method: ${params.paymentMethodSummary}</p>`
    : '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1e293b;">Payment Receipt</h2>
  <p>Your payment of <strong>${amount}</strong> has been received.</p>
  <p>Receipt #: <strong>${params.receiptNumber}</strong></p>
  ${propertyLine}
  ${periodLine}
  ${methodLine}
  <p>Date: ${new Date(params.paidAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
  <p style="color: #64748b; font-size: 13px;">
    This is an automated receipt from LeaseBase. Please keep this for your records.
  </p>
  <p style="color: #94a3b8; font-size: 12px;">— LeaseBase</p>
</body>
</html>`.trim();
}

function buildReceiptText(params: ReceiptEmailParams): string {
  const amount = formatCurrency(params.amount, params.currency);
  const lines: string[] = [
    'Payment Receipt',
    '',
    `Your payment of ${amount} has been received.`,
    `Receipt #: ${params.receiptNumber}`,
  ];
  if (params.propertyName) {
    lines.push(`Property: ${params.propertyName}${params.unitNumber ? ` — Unit ${params.unitNumber}` : ''}`);
  }
  if (params.billingPeriod) {
    lines.push(`Billing Period: ${params.billingPeriod}`);
  }
  if (params.paymentMethodSummary) {
    lines.push(`Payment Method: ${params.paymentMethodSummary}`);
  }
  lines.push(`Date: ${new Date(params.paidAt).toLocaleDateString('en-US')}`);
  lines.push('', 'This is an automated receipt from LeaseBase.');
  return lines.join('\n');
}

/**
 * Send a payment receipt email via SES.
 * Returns true if sent, false if SES not configured (skipped).
 * Does NOT throw on SES failure — logs and returns false.
 */
export async function sendReceiptEmail(params: ReceiptEmailParams): Promise<boolean> {
  const subject = `Payment Receipt — ${params.receiptNumber}`;

  if (!SES_FROM_EMAIL) {
    const level = NODE_ENV === 'development' ? 'info' : 'warn';
    logger[level](
      { to: params.toEmail, receiptNumber: params.receiptNumber, emailSkipped: true },
      'Receipt email not sent — SES_FROM_EMAIL is not configured',
    );
    return false;
  }

  try {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const sesClient = new SESv2Client({ region: SES_REGION });

    const htmlBody = buildReceiptHtml(params);
    const textBody = buildReceiptText(params);

    logger.info(
      { to: params.toEmail, from: SES_FROM_EMAIL, receiptNumber: params.receiptNumber },
      'Sending receipt email via SES',
    );

    await sesClient.send(new SendEmailCommand({
      FromEmailAddress: SES_FROM_EMAIL,
      Destination: {
        ToAddresses: [params.toEmail],
      },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: {
            Html: { Data: htmlBody },
            Text: { Data: textBody },
          },
        },
      },
    }));

    logger.info({ to: params.toEmail, receiptNumber: params.receiptNumber }, 'Receipt email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: params.toEmail, receiptNumber: params.receiptNumber }, 'Failed to send receipt email');
    return false;
  }
}
