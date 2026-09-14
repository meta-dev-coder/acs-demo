#!/usr/bin/env zsh
# I-595 AWS Tools Setup
# Run once in iTerm: chmod +x setup-aws-tools.sh && ./setup-aws-tools.sh
set -e

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo "${GREEN}✓ $1${NC}"; }
warn() { echo "${YELLOW}⚠ $1${NC}"; }
step() { echo "\n${YELLOW}── $1 ──${NC}"; }

# ── 1. Homebrew ──────────────────────────────────────────────────────────────
step "Homebrew"
if command -v brew &>/dev/null; then
  ok "Homebrew already installed ($(brew --version | head -1))"
else
  warn "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Apple Silicon path
  [[ -f /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
  ok "Homebrew installed"
fi

# ── 2. AWS CLI v2 ────────────────────────────────────────────────────────────
step "AWS CLI"
if command -v aws &>/dev/null; then
  ok "AWS CLI already installed ($(aws --version 2>&1))"
else
  warn "Installing AWS CLI v2 via Homebrew..."
  brew install awscli
  ok "AWS CLI installed"
fi

# ── 3. Node.js 22 via nvm ────────────────────────────────────────────────────
step "Node.js 22"
if command -v nvm &>/dev/null || [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh" 2>/dev/null || true
  ok "nvm found"
else
  warn "Installing nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh"
  ok "nvm installed"
fi

source "$HOME/.nvm/nvm.sh" 2>/dev/null || true
nvm install 22 --lts 2>/dev/null || true
nvm use 22
ok "Node $(node --version) active"

# ── 4. CDK CLI ───────────────────────────────────────────────────────────────
step "AWS CDK CLI"
if command -v cdk &>/dev/null; then
  ok "CDK already installed ($(cdk --version))"
else
  warn "Installing CDK CLI globally..."
  npm install -g aws-cdk@2
  ok "CDK installed ($(cdk --version))"
fi

# ── 5. CDK project dependencies ──────────────────────────────────────────────
step "CDK project npm install"
INFRA_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Directory: $INFRA_DIR"
cd "$INFRA_DIR"
npm install
ok "npm install complete"

# ── 6. Verify AWS credentials ────────────────────────────────────────────────
step "AWS credentials check"
if aws sts get-caller-identity &>/dev/null; then
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  REGION=$(aws configure get region || echo "not set")
  ok "Authenticated — Account: $ACCOUNT, Region: $REGION"
else
  echo "${RED}✗ Not authenticated. Run: aws configure${NC}"
  echo "  You need: AWS Access Key ID, Secret Access Key, Region (us-east-1)"
  echo ""
  echo "  Or for SSO: aws sso login --profile your-profile"
fi

# ── 7. Summary ───────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════"
echo "  Setup complete. Next steps:"
echo ""
echo "  1. If not authenticated above:"
echo "     aws configure"
echo ""
echo "  2. Bootstrap CDK (once per account/region):"
echo "     npx cdk bootstrap aws://\$(aws sts get-caller-identity --query Account --output text)/us-east-1"
echo ""
echo "  3. Deploy infrastructure:"
echo "     npx cdk deploy --outputs-file cdk-outputs.json"
echo ""
echo "  4. Follow DEPLOY.md for next steps after deploy."
echo "════════════════════════════════════════════════"
