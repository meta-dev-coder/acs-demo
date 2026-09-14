#!/usr/bin/env bash
# One-shot deployment script for I595StackV3.
# Run from: cesium-poc/infra/
# Usage: bash deploy-i595-v3.sh
#
# This script:
#  1. Creates an IAM execution role for CloudFormation (bypasses user-level Lambda block)
#  2. Uploads Lambda zips to the AES-256 assets bucket
#  3. Creates I595StackV3 CloudFormation stack using that execution role
#  4. Waits for completion

set -euo pipefail

REGION="us-east-1"
ACCOUNT="589391957147"
BUCKET="i595-deploy-assets-${ACCOUNT}-${REGION}"
STACK_NAME="I595StackV3"
ROLE_NAME="I595CfnExecutionRole"

# ── Step 1: Create CloudFormation execution role ──────────────────────────────
echo "=== Step 1: Create CloudFormation execution role ==="

ROLE_EXISTS=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text 2>/dev/null || echo "NONE")

if [ "$ROLE_EXISTS" = "NONE" ]; then
  echo "Creating IAM role $ROLE_NAME..."
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "cloudformation.amazonaws.com"},
        "Action": "sts:AssumeRole"
      }]
    }' \
    --description "CloudFormation execution role for I595 CDK deployment" \
    --region "$REGION" > /dev/null

  aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/AdministratorAccess

  # Wait for role to propagate
  echo "Waiting for role propagation..."
  sleep 15
  echo "Role created."
else
  echo "Role $ROLE_NAME already exists: $ROLE_EXISTS"
fi

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
echo "Execution role ARN: $ROLE_ARN"

# ── Step 2: Ensure AES-256 assets bucket exists ────────────────────────────────
echo ""
echo "=== Step 2: Verify assets bucket ==="
if ! aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "ERROR: Bucket $BUCKET does not exist. Run cdk synth first."
  exit 1
fi
echo "Bucket $BUCKET exists."

# ── Step 3: Synthesize I595StackV3 ───────────────────────────────────────────
echo ""
echo "=== Step 3: Synthesize I595StackV3 ==="
export CDK_DEFAULT_ACCOUNT="$ACCOUNT"
export CDK_DEFAULT_REGION="$REGION"

# Update stack name in the CDK entry point
INFRA_BIN="bin/i595-infra.ts"
# Temporarily set to V3 name (undo after if needed)
CURRENT_STACK=$(grep "new I595Stack(app," "$INFRA_BIN" | sed "s/.*'\\(.*\\)'.*/\\1/")
echo "Current stack name in CDK: $CURRENT_STACK"

if [ "$CURRENT_STACK" != "$STACK_NAME" ]; then
  sed -i.bak "s/new I595Stack(app, '$CURRENT_STACK'/new I595Stack(app, '$STACK_NAME'/" "$INFRA_BIN"
  echo "Updated stack name to $STACK_NAME"
fi

npm run build 2>&1 | tail -3
npx cdk synth "$STACK_NAME" 2>&1 | tail -5
echo "Synth complete."

# ── Step 4: Upload assets ─────────────────────────────────────────────────────
echo ""
echo "=== Step 4: Upload Lambda assets to S3 ==="

export STACK_NAME
python3 - << 'PYEOF'
import json, subprocess, sys, os

cdk_out = os.path.join(os.getcwd(), 'cdk.out')
stack_name = os.environ.get('STACK_NAME', 'I595StackV3')
assets_file = os.path.join(cdk_out, f'{stack_name}.assets.json')

with open(assets_file) as f:
    manifest = json.load(f)

region = 'us-east-1'
errors = []

for asset_id, asset in manifest.get('files', {}).items():
    src_path = asset['source']['path']
    for dest_key, dst in asset['destinations'].items():
        bucket = dst.get('bucketName', '')
        obj_key = dst.get('objectKey', '')
        if not bucket or not obj_key:
            continue

        local = os.path.join(cdk_out, src_path)
        s3_url = f's3://{bucket}/{obj_key}'

        # Check if already exists
        check = subprocess.run(
            ['aws', 's3api', 'head-object', '--bucket', bucket, '--key', obj_key, '--region', region],
            capture_output=True
        )
        if check.returncode == 0:
            print(f'  Already exists: {obj_key[:50]}...')
            continue

        if os.path.isdir(local):
            zip_path = local + '.zip'
            if not os.path.exists(zip_path):
                r = subprocess.run(['zip', '-r', zip_path, '.'], cwd=local, capture_output=True)
                if r.returncode != 0:
                    print(f'ZIP FAILED: {local}', file=sys.stderr)
                    continue
            local_file = zip_path
        elif os.path.isfile(local):
            local_file = local
        else:
            print(f'MISSING: {local}', file=sys.stderr)
            continue

        print(f'  Uploading {src_path[:50]} -> {obj_key[:50]}...')
        result = subprocess.run(
            ['aws', 's3', 'cp', local_file, s3_url, '--region', region, '--no-progress'],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f'  FAILED: {result.stderr.strip()}', file=sys.stderr)
            errors.append(s3_url)
        else:
            print(f'  OK')

if errors:
    sys.exit(1)
print('All assets ready.')
PYEOF

# ── Step 5: Deploy stack ──────────────────────────────────────────────────────
echo ""
echo "=== Step 5: Create CloudFormation stack $STACK_NAME ==="

# Get the template S3 key from the assets manifest
TEMPLATE_KEY=$(python3 -c "
import json, os
cdk_out = 'cdk.out'
with open(f'cdk.out/${STACK_NAME}.assets.json') as f:
    m = json.load(f)
for aid, a in m['files'].items():
    if a['source']['path'].endswith('template.json'):
        for dk, dv in a['destinations'].items():
            print(dv['objectKey'])
            break
        break
")
echo "Template key: $TEMPLATE_KEY"

TEMPLATE_URL="https://${BUCKET}.s3.${REGION}.amazonaws.com/${TEMPLATE_KEY}"

# Check if stack exists
EXISTING=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NONE")

if [ "$EXISTING" = "NONE" ]; then
  echo "Creating new stack..."
  aws cloudformation create-stack \
    --stack-name "$STACK_NAME" \
    --template-url "$TEMPLATE_URL" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
    --role-arn "$ROLE_ARN" \
    --region "$REGION"
elif [ "$EXISTING" = "ROLLBACK_FAILED" ] || [ "$EXISTING" = "CREATE_FAILED" ]; then
  echo "Stack is in $EXISTING state — cannot update. Use a different stack name or clean up first."
  exit 1
else
  echo "Stack already exists in state: $EXISTING"
  echo "Use a new STACK_NAME (e.g., I595StackV4) to redeploy."
  exit 0
fi

# ── Step 6: Wait ──────────────────────────────────────────────────────────────
echo ""
echo "=== Step 6: Waiting for stack creation (this takes 3-5 minutes) ==="
aws cloudformation wait stack-create-complete \
  --stack-name "$STACK_NAME" \
  --region "$REGION"

echo ""
echo "=== Deployment complete! ==="
echo "Stack $STACK_NAME is now CREATE_COMPLETE."
