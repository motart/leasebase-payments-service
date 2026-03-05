# LeaseBase payments-service

Payment processing via Stripe — rent collection, refunds, ledger.

## Stack

- **Runtime**: Node.js / NestJS (planned)
- **Container**: Docker -> ECS Fargate
- **Registry**: ECR `leasebase-{env}-v2-payments-service`
- **Port**: 3000

## Infrastructure

Managed by Terraform in [leasebase-iac](https://github.com/motart/leasebase-iac).

## Getting Started

```bash
# GitHub Packages auth (one-time setup)
export NODE_AUTH_TOKEN=$(gh auth token)

npm install
npm run dev
npm test
npm run lint
```

## Docker Build (local)

```bash
docker build \
  --build-arg NODE_AUTH_TOKEN=$(gh auth token) \
  -t leasebase-payments-service .
```

## CI/CD

Automated via GitHub Actions (`.github/workflows/dev-deploy.yml`).

**Trigger**: push to `develop` or manual `workflow_dispatch`.

**Pipeline**: install → lint → test → docker build → Trivy scan → ECR push → ECS deploy

**Config**: `deploy.dev.json` defines ECR repo, ECS cluster/service/task names.

**Auth**: AWS OIDC via `AWS_ROLE_ARN` repository variable. npm auth via `GITHUB_TOKEN`.

### Prerequisites

1. Set GitHub repo variable `AWS_ROLE_ARN` to the OIDC role ARN
2. Ensure the OIDC role trusts `motart/leasebase-payments-service` (Terraform)
3. `develop` branch must exist
