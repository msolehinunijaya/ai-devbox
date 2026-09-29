#!/usr/bin/env bash
# AI Devbox server setup. Run as root: ./setup.sh
# Idempotent: safe to re-run. Run it again after `tailscale up` to install the preview site,
# and after a Claude Code update to give the ai user the new binary.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
ROOT="$PWD"
AI=ai
AI_HOME=/home/$AI

log() { printf '\n▶ %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }

log "Swappiness 10 (swapfile already exists)"
echo 'vm.swappiness=10' > /etc/sysctl.d/99-ai-devbox.conf
sysctl -q -p /etc/sysctl.d/99-ai-devbox.conf

log "User $AI (no sudo)"
id "$AI" >/dev/null 2>&1 || useradd -m -s /bin/bash "$AI"
if id -nG "$AI" | grep -qw sudo; then echo "$AI must not be in the sudo group" >&2; exit 1; fi
install -d -o "$AI" -g "$AI" -m 755 "$ROOT/run" "$ROOT/run/jobs" "$ROOT/run/worktrees" \
  "$ROOT/run/docroot" "$ROOT/run/logs" "$ROOT/repos"
install -d -o root -g root -m 700 /etc/ai-devbox

log "Claude Code for $AI"
# Hard link to root's install: no extra disk, and it survives root's updater removing old versions.
install -d -m 755 /opt/ai-devbox/bin
ln -f "$(readlink -f /root/.local/bin/claude)" /opt/ai-devbox/bin/claude
grep -q '/opt/ai-devbox/bin' "$AI_HOME/.profile" 2>/dev/null \
  || echo 'PATH="/opt/ai-devbox/bin:$PATH"' >> "$AI_HOME/.profile"
install -d -o "$AI" -g "$AI" -m 700 "$AI_HOME/.claude"
install -o "$AI" -g "$AI" -m 644 config/claude-settings.json "$AI_HOME/.claude/settings.json"
# Skip the first-run screens (theme, login method) so take-over sessions start straight away.
sudo -u "$AI" -H node -e '
  const f = process.env.HOME + "/.claude.json", fs = require("fs");
  let j = {}; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  j.hasCompletedOnboarding = true; j.theme = j.theme || "dark";
  fs.writeFileSync(f, JSON.stringify(j, null, 2), { mode: 0o600 });'
chmod 755 ai cli.js

log "SSH key and git identity for $AI"
install -d -o "$AI" -g "$AI" -m 700 "$AI_HOME/.ssh"
[ -f "$AI_HOME/.ssh/id_ed25519" ] \
  || sudo -u "$AI" ssh-keygen -q -t ed25519 -N '' -C "ai-devbox@$(hostname)" -f "$AI_HOME/.ssh/id_ed25519"
touch "$AI_HOME/.ssh/known_hosts"
for h in github.com gitlab.com; do   # reuse root's already-trusted host keys
  ssh-keygen -F "$h" -f "$AI_HOME/.ssh/known_hosts" >/dev/null 2>&1 \
    || ssh-keygen -F "$h" -f /root/.ssh/known_hosts | grep -v '^#' >> "$AI_HOME/.ssh/known_hosts"
done
chown "$AI:$AI" "$AI_HOME/.ssh/known_hosts"; chmod 644 "$AI_HOME/.ssh/known_hosts"
sudo -u "$AI" git config --global user.name "AI Devbox"
sudo -u "$AI" git config --global user.email "ai-devbox@$(hostname)"

log "MariaDB user $AI (unix socket auth, only ai_* databases)"
mysql -e "CREATE USER IF NOT EXISTS '$AI'@'localhost' IDENTIFIED VIA unix_socket;
          GRANT ALL PRIVILEGES ON \`ai\\_%\`.* TO '$AI'@'localhost';"

log "PHP-FPM pool [$AI] on php8.4-fpm"
install -m 644 config/php-fpm-ai.conf /etc/php/8.4/fpm/pool.d/ai.conf
php-fpm8.4 -t 2>&1 | tail -1
systemctl reload php8.4-fpm

log "earlyoom: never kill the dashboard"
if ! grep -q 'ai-dashboard' /etc/default/earlyoom; then
  sed -i "s/--avoid '^(/--avoid '^(ai-dashboard|/" /etc/default/earlyoom
  systemctl restart earlyoom
fi

log "Playwright (screenshots)"
[ -d tools/node_modules/playwright ] || (cd tools && npm ci --no-audit --no-fund)
if [ ! -d tools/ms-playwright ]; then
  if [ -d /root/.cache/ms-playwright ]; then cp -al /root/.cache/ms-playwright tools/ms-playwright
  else PLAYWRIGHT_BROWSERS_PATH="$ROOT/tools/ms-playwright" tools/node_modules/.bin/playwright install --only-shell chromium; fi
fi

log "Tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
    -o /etc/apt/sources.list.d/tailscale.list
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tailscale
fi
systemctl enable --now tailscaled >/dev/null
ufw allow in on tailscale0 comment 'AI Devbox over Tailscale' >/dev/null

log "nginx preview site"
TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
if [ -z "$TS_IP" ]; then
  echo "Tailscale is not logged in yet: run 'tailscale up', then run this script again."
else
  sed "s/__TS_IP__/$TS_IP/g; s/__TS_DASHED__/${TS_IP//./-}/g" config/nginx-ai.conf \
    > /etc/nginx/sites-available/ai-devbox
  ln -sf /etc/nginx/sites-available/ai-devbox /etc/nginx/sites-enabled/ai-devbox
  nginx -t 2>&1 | tail -1
  systemctl reload nginx
  printf '{ "ts_ip": "%s", "domain": "%s.sslip.io" }\n' "$TS_IP" "${TS_IP//./-}" > "$ROOT/run/host.json"
  echo "Previews: http://<job>.${TS_IP//./-}.sslip.io"
fi

log "Done"
