#!/bin/bash
# Deploy pyreplab notebook to analytics.unchainedsky.com
# Usage: ./deploy.sh

set -euo pipefail

HOST="100.55.95.25"
KEY="$HOME/.ssh/unchained-key.pem"
USER="ec2-user"
APP_DIR="/opt/pyodide-repl"

echo "Deploying to $HOST..."

ssh -o StrictHostKeyChecking=no -i "$KEY" "$USER@$HOST" "sudo bash -s" <<REMOTE
set -e
cd $APP_DIR
git pull
npm install --omit=dev
systemctl restart pyreplab
echo "--- Status ---"
systemctl is-active pyreplab
systemctl is-active caddy
REMOTE

echo "Deployed: https://analytics.unchainedsky.com"
