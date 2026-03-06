#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# build_push.sh — Build Docker image, scan with Trivy, push to ECR
#
# Required environment variables:
#   DEPLOY_CONFIG  — path to deploy JSON (e.g. deploy.dev.json)
#   GITHUB_SHA     — full commit SHA (set by GitHub Actions)
#   GITHUB_TOKEN   — GitHub token for npm auth (set by GitHub Actions)
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load config ──────────────────────────────────────────────────────────────
CONFIG="$REPO_ROOT/${DEPLOY_CONFIG:?DEPLOY_CONFIG is required}"
AWS_REGION=$(jq -r '.aws_region' "$CONFIG")
AWS_ACCOUNT_ID=$(jq -r '.aws_account_id' "$CONFIG")
ECR_REPO=$(jq -r '.ecr_repository' "$CONFIG")

ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_BASE="${ECR_REGISTRY}/${ECR_REPO}"
IMAGE_SHA="${IMAGE_BASE}:${GITHUB_SHA}"
IMAGE_LATEST="${IMAGE_BASE}:dev-latest"

echo "▸ Building image: ${IMAGE_SHA}"

# ── Build ────────────────────────────────────────────────────────────────────
docker buildx build \
  --build-arg NODE_AUTH_TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN is required}" \
  --tag "${IMAGE_SHA}" \
  --tag "${IMAGE_LATEST}" \
  --load \
  --file "${REPO_ROOT}/Dockerfile" \
  "${REPO_ROOT}"

# ── Trivy scan ───────────────────────────────────────────────────────────────
echo "▸ Scanning image with Trivy..."
trivy image \
  --exit-code 1 \
  --severity CRITICAL,HIGH \
  --ignore-unfixed \
  --no-progress \
  "${IMAGE_SHA}" || {
    echo "⚠ Trivy found vulnerabilities (see above). Continuing with push..."
  }

# ── Push to ECR ──────────────────────────────────────────────────────────────
echo "▸ Pushing ${IMAGE_SHA}"
docker push "${IMAGE_SHA}"

echo "▸ Pushing ${IMAGE_LATEST}"
docker push "${IMAGE_LATEST}"

# ── Print build info ─────────────────────────────────────────────────────────
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE_LATEST}" 2>/dev/null | sed 's/.*@//' || echo "unknown")
echo "✓ Done — pushed ${IMAGE_SHA} and ${IMAGE_LATEST}"
echo "  Commit SHA : ${GITHUB_SHA}"
echo "  Image digest: ${DIGEST}"

# ── Export for downstream steps ──────────────────────────────────────────────
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "image=${IMAGE_LATEST}" >> "$GITHUB_OUTPUT"
  echo "image_sha=${IMAGE_SHA}" >> "$GITHUB_OUTPUT"
  echo "sha=${GITHUB_SHA}" >> "$GITHUB_OUTPUT"
  echo "digest=${DIGEST}" >> "$GITHUB_OUTPUT"
fi
