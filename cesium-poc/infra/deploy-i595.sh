#!/usr/bin/env bash
# One-shot deployment script for I595Stack.
# Run from: cesium-poc/infra/
# Prerequisites: AWS CLI v2 configured as aayush_metadev, us-east-1 region

set -euo pipefail

BUCKET="i595-deploy-assets-589391957147-us-east-1"
REGION="us-east-1"

echo "=== Step 1: Create i595 deployment assets bucket (AES-256, no KMS) ==="
if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "Bucket $BUCKET already exists — skipping creation."
else
  aws s3api create-bucket \
    --bucket "$BUCKET" \
    --region "$REGION"
  aws s3api put-bucket-versioning \
    --bucket "$BUCKET" \
    --versioning-configuration Status=Enabled \
    --region "$REGION"
  echo "Bucket created."
fi

echo ""
echo "=== Step 2: Remove stuck I595Stack (ROLLBACK_FAILED) ==="
STATUS=$(aws cloudformation describe-stacks \
  --stack-name I595Stack --region "$REGION" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [ "$STATUS" = "DOES_NOT_EXIST" ]; then
  echo "I595Stack does not exist — nothing to clean up."
elif [ "$STATUS" = "ROLLBACK_FAILED" ]; then
  echo "Step 2a: Initiating delete on ROLLBACK_FAILED stack..."
  aws cloudformation delete-stack \
    --stack-name I595Stack \
    --region "$REGION"

  echo "Waiting (may go to DELETE_FAILED if SnapshotProxy blocks)..."
  aws cloudformation wait stack-delete-complete \
    --stack-name I595Stack --region "$REGION" 2>/dev/null || true

  AFTER=$(aws cloudformation describe-stacks \
    --stack-name I595Stack --region "$REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "DOES_NOT_EXIST")

  if [ "$AFTER" = "DELETE_FAILED" ]; then
    echo "Step 2b: Stack hit DELETE_FAILED (SnapshotProxy still blocking). Retrying with retain..."
    aws cloudformation delete-stack \
      --stack-name I595Stack \
      --retain-resources SnapshotProxyFnF8655E2A \
      --region "$REGION"
    echo "Waiting for final deletion..."
    aws cloudformation wait stack-delete-complete \
      --stack-name I595Stack --region "$REGION" 2>/dev/null || true
  fi
  echo "Stack removed."
else
  echo "Stack status is: $STATUS — no cleanup needed."
fi

echo ""
echo "=== Step 3: CDK synth + deploy ==="
export AWS_DEFAULT_REGION="$REGION"
export CDK_DEFAULT_ACCOUNT="589391957147"
export CDK_DEFAULT_REGION="$REGION"

npm run build 2>&1 | tail -5
npx cdk deploy I595Stack --require-approval never --region "$REGION"

echo ""
echo "=== Deployment complete ==="
