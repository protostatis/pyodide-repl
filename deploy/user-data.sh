#!/bin/bash
set -euo pipefail

# Log everything
exec > /var/log/pyreplab-setup.log 2>&1

# Install Node.js 20
dnf install -y git
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# Install Caddy
dnf install -y 'dnf-command(copr)'
dnf copr enable -y @caddy/caddy
dnf install -y caddy

# Clone repo
cd /opt
git clone https://github.com/protostatis/pyodide-repl.git
cd pyodide-repl
npm install --production

# Create .env — set your OpenRouter key here
cat > .env <<'ENVEOF'
OPENROUTER_API_KEY=your-key-here
OPENROUTER_MODEL=xiaomi/mimo-v2-flash
OPENROUTER_FALLBACK_MODEL=openrouter/free
ENVEOF

# Create systemd service for the Node app
cat > /etc/systemd/system/pyreplab.service <<'SVCEOF'
[Unit]
Description=pyreplab notebook
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/pyodide-repl
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=3000
User=root

[Install]
WantedBy=multi-user.target
SVCEOF

# Configure Caddy
cat > /etc/caddy/Caddyfile <<'CADDYEOF'
analytics.unchainedsky.com {
    reverse_proxy localhost:3000
}
CADDYEOF

# Start services
systemctl daemon-reload
systemctl enable pyreplab
systemctl start pyreplab
systemctl enable caddy
systemctl start caddy

echo "Setup complete"
