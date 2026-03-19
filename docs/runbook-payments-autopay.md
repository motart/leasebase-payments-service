# Payments & Autopay — Operator Runbook

## Architecture Overview

```
EventBridge Scheduler → Lambda (scheduler-bridge) → ALB → payments-service /jobs/*
```

Four scheduled jobs run via `leasebase-dev-v2-scheduler-bridge` Lambda:

| Job | Schedule (UTC) | Endpoint |
|-----|---------------|----------|
| generate-charges | 1st of month 06:00 | `/internal/payments/jobs/generate-charges` |
| mark-overdue | Daily 07:00 | `/internal/payments/jobs/mark-overdue` |
| autopay-sweep | Daily 08:00 | `/internal/payments/jobs/autopay-sweep` |
| retry-failed-autopay | Daily 10:00 | `/internal/payments/jobs/retry-failed-autopay` |

## Authentication

All job and admin endpoints require header:
```
X-Internal-Service-Key: <INTERNAL_SERVICE_KEY>
```

## Admin Endpoints

Base path: `/internal/payments/admin`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/status` | GET | System health: DB, Stripe, recent jobs, webhook stats |
| `/admin/job-executions` | GET | Job history. `?job_name=X&limit=N` |
| `/admin/webhook-events` | GET | Webhook events. `?status=FAILED&limit=N` |
| `/admin/webhook-replay/:id` | POST | Replay a single webhook by Stripe event ID |
| `/admin/webhook-replay-failed` | POST | Batch-replay all FAILED webhooks. `?max_retries=3&limit=10` |
| `/admin/autopay-overview` | GET | Enrollment counts + recent attempt log |
| `/admin/payment-stats` | GET | 30-day transaction aggregates |

## Common Operations

### Check system health
```bash
curl -s -H "X-Internal-Service-Key: $KEY" \
  http://$ALB/internal/payments/admin/status | jq .
```

### View failed webhook events
```bash
curl -s -H "X-Internal-Service-Key: $KEY" \
  "http://$ALB/internal/payments/admin/webhook-events?status=FAILED" | jq .
```

### Replay a specific failed webhook
```bash
curl -s -X POST -H "X-Internal-Service-Key: $KEY" \
  http://$ALB/internal/payments/admin/webhook-replay/evt_XXXX | jq .
```

### Batch-replay all failed webhooks
```bash
curl -s -X POST -H "X-Internal-Service-Key: $KEY" \
  "http://$ALB/internal/payments/admin/webhook-replay-failed?max_retries=3&limit=20" | jq .
```

### Manually trigger a job
```bash
curl -s -X POST -H "X-Internal-Service-Key: $KEY" \
  http://$ALB/internal/payments/jobs/autopay-sweep | jq .
```

### Check autopay overview
```bash
curl -s -H "X-Internal-Service-Key: $KEY" \
  http://$ALB/internal/payments/admin/autopay-overview | jq .
```

## Troubleshooting

### Job not running on schedule
1. Check EventBridge schedule is ENABLED:
   ```bash
   aws scheduler list-schedules --query "Schedules[?contains(Name,'leasebase-dev')]"
   ```
2. Check Lambda logs:
   ```bash
   aws logs tail /aws/lambda/leasebase-dev-v2-scheduler-bridge --since 1h
   ```
3. Check CloudWatch alarms:
   ```bash
   aws cloudwatch describe-alarms --alarm-name-prefix leasebase-dev-v2-scheduler-bridge
   ```

### Webhook events stuck in FAILED
1. Check the error message via `/admin/webhook-events?status=FAILED`
2. If transient (network/timeout), replay with `/admin/webhook-replay-failed`
3. If persistent (bad data), investigate the payload and fix upstream, then replay individually

### Autopay payment failing
1. Check `/admin/autopay-overview` for recent failed attempts
2. Check the `autopay_attempt_log` table for `failure_reason`
3. Common causes:
   - Stripe payment method expired or declined
   - Insufficient funds
   - Charge already paid (idempotency guard prevents double-pay)

### Lambda timeout
- Current timeout: 30s
- CloudWatch alarm triggers at p99 > 25s
- If ALB is slow, check ECS task health and scaling
- Check VPC/security group allows Lambda → ALB traffic

## CloudWatch Alarms

| Alarm | Trigger | Action |
|-------|---------|--------|
| `*-scheduler-bridge-errors` | Any Lambda error in 5 min | Investigate Lambda logs |
| `*-scheduler-bridge-throttles` | Any throttle in 5 min | Check concurrency limits |
| `*-scheduler-bridge-duration` | p99 > 25s in 5 min | Check ALB/ECS health |

## Key Database Tables

- `job_execution` — Job run history (name, status, counts, timestamps)
- `webhook_event` — Stripe webhook storage (status: RECEIVED/PROCESSED/FAILED)
- `autopay_enrollment` — Tenant autopay settings (status: ENABLED/DISABLED)
- `autopay_attempt_log` — Individual autopay payment attempts
- `payment_transaction` — All payment records (source: MANUAL/AUTOPAY)
- `charge` — Monthly rent/fee charges
