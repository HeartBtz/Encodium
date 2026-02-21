#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
# Encodium — Fully Autonomous Installation Script
# ONE command, ZERO manual steps.
#   bash install.sh
# Installs: Node.js, MariaDB, ffmpeg, npm deps, creates DB,
# .env, admin account, PM2, systemd — everything.
# ═══════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

APP_PORT=4000
APP_NAME="encodium"
MARIADB_STARTED_BY_US=0

NC='\033[0m'; BOLD='\033[1m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RED='\033[0;31m'; YELLOW='\033[0;33m'

log()  { echo -e "${CYAN}[encodium]${NC} $*"; }
ok()   { echo -e "${GREEN}[  OK  ]${NC} $*"; }
warn() { echo -e "${YELLOW}[ WARN ]${NC} $*"; }
err()  { echo -e "${RED}[ERROR ]${NC} $*" >&2; }
die()  { err "$*"; exit 1; }

# ─── Helpers ───────────────────────────────────────────────
rand_string() {
  # Generate a random alphanumeric string (arg1 = length, default 24)
  local len="${1:-24}"
  if command -v openssl &>/dev/null; then
    openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$len"
  else
    tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c "$len"
  fi
}

banner() {
  echo -e "${BOLD}${CYAN}"
  echo "  ╔══════════════════════════════════════╗"
  echo "  ║         Encodium Installer           ║"
  echo "  ║      Video Encoding Platform         ║"
  echo "  ╚══════════════════════════════════════╝"
  echo -e "${NC}"
}

# ─── Pre-flight checks ────────────────────────────────────
preflight() {
  log "Running pre-flight checks…"

  # Need curl for nvm install
  if ! command -v curl &>/dev/null; then
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq curl ca-certificates
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y curl ca-certificates
    elif command -v pacman &>/dev/null; then
      sudo pacman -Sy --noconfirm curl ca-certificates
    else
      die "curl is required but not found. Install it manually."
    fi
  fi

  # Need sudo
  if ! command -v sudo &>/dev/null; then
    die "sudo is required but not found."
  fi

  ok "Pre-flight checks passed"
}

# ─── Node.js via nvm ───────────────────────────────────────
install_node() {
  log "Checking Node.js…"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "$NVM_DIR/nvm.sh"
  fi

  if command -v node &>/dev/null; then
    local NODE_VER
    NODE_VER="$(node -v)"
    local MAJOR="${NODE_VER#v}"
    MAJOR="${MAJOR%%.*}"
    if (( MAJOR >= 18 )); then
      ok "Node.js $NODE_VER already installed"
    else
      warn "Node.js $NODE_VER is too old (need >=18), upgrading…"
      nvm install 20
      nvm alias default 20
      nvm use default
      ok "Node.js $(node -v) installed"
    fi
  else
    log "Installing nvm + Node.js 20 LTS…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    source "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm alias default 20
    nvm use default
    ok "Node.js $(node -v) installed"
  fi

  # Resolve absolute paths for systemd/pm2
  NODE_BIN="$(command -v node)"
  NPM_BIN="$(command -v npm)"
}

# ─── MariaDB ───────────────────────────────────────────────
install_mariadb() {
  log "Checking MariaDB…"

  local HAS_SERVER=0
  # Check if server binary exists (not just client)
  if command -v mariadbd &>/dev/null || command -v mysqld &>/dev/null; then
    HAS_SERVER=1
  elif dpkg -l mariadb-server 2>/dev/null | grep -q "^ii" 2>/dev/null; then
    HAS_SERVER=1
  elif rpm -q mariadb-server &>/dev/null 2>/dev/null; then
    HAS_SERVER=1
  fi

  if (( HAS_SERVER )); then
    ok "MariaDB server already installed"
  else
    log "Installing MariaDB server…"
    if command -v apt-get &>/dev/null; then
      # Prevent interactive prompts
      export DEBIAN_FRONTEND=noninteractive
      sudo apt-get update -qq
      sudo apt-get install -y -qq mariadb-server mariadb-client
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y mariadb-server mariadb
    elif command -v pacman &>/dev/null; then
      sudo pacman -Sy --noconfirm mariadb
      sudo mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql 2>/dev/null || true
    else
      die "Cannot auto-install MariaDB. Install it manually and re-run this script."
    fi
    ok "MariaDB installed"
  fi

  # Ensure MariaDB is running
  ensure_mariadb_running
}

ensure_mariadb_running() {
  log "Ensuring MariaDB is running…"

  local MYSQL_CMD="mysql"
  if command -v mariadb &>/dev/null; then MYSQL_CMD="mariadb"; fi

  # Quick check: already running?
  if sudo $MYSQL_CMD -e "SELECT 1" &>/dev/null 2>&1; then
    ok "MariaDB is already running"
    return 0
  fi

  # Method 1: systemctl (real systemd host)
  if command -v systemctl &>/dev/null; then
    if systemctl is-active --quiet mariadb 2>/dev/null; then
      ok "MariaDB active via systemd"
      return 0
    fi
    # Try starting via systemctl
    if sudo systemctl start mariadb 2>/dev/null; then
      wait_for_mariadb
      return 0
    fi
    if sudo systemctl start mysql 2>/dev/null; then
      wait_for_mariadb
      return 0
    fi
    log "systemctl start failed, falling back to manual daemon…"
  fi

  # Method 2: Manual daemon start (containers / Coder / Docker / WSL)
  start_mariadb_manual
}

start_mariadb_manual() {
  log "Starting MariaDB daemon manually…"

  # Ensure socket directory exists
  local SOCKET_DIR="/run/mysqld"
  if [[ ! -d "$SOCKET_DIR" ]]; then
    sudo mkdir -p "$SOCKET_DIR"
    sudo chown mysql:mysql "$SOCKET_DIR" 2>/dev/null || sudo chmod 777 "$SOCKET_DIR"
  fi

  # Ensure datadir exists and is initialized
  local DATADIR="/var/lib/mysql"
  if [[ ! -d "$DATADIR/mysql" ]]; then
    log "Initializing MariaDB data directory…"
    if command -v mariadb-install-db &>/dev/null; then
      sudo mariadb-install-db --user=mysql --basedir=/usr --datadir="$DATADIR" 2>/dev/null || true
    elif command -v mysql_install_db &>/dev/null; then
      sudo mysql_install_db --user=mysql --basedir=/usr --datadir="$DATADIR" 2>/dev/null || true
    fi
  fi

  # Kill any stale process
  sudo killall -q mariadbd mysqld 2>/dev/null || true
  sleep 1

  # Start daemon in background
  if command -v mariadbd-safe &>/dev/null; then
    sudo mariadbd-safe --user=mysql &
  elif command -v mysqld_safe &>/dev/null; then
    sudo mysqld_safe --user=mysql &
  elif command -v mariadbd &>/dev/null; then
    sudo mariadbd --user=mysql --socket="$SOCKET_DIR/mysqld.sock" &
  elif command -v mysqld &>/dev/null; then
    sudo mysqld --user=mysql --socket="$SOCKET_DIR/mysqld.sock" &
  else
    die "Cannot find MariaDB/MySQL daemon binary. Is the server package installed?"
  fi

  MARIADB_STARTED_BY_US=1
  disown 2>/dev/null || true

  wait_for_mariadb
}

wait_for_mariadb() {
  log "Waiting for MariaDB to be ready…"

  local MYSQL_CMD="mysql"
  if command -v mariadb &>/dev/null; then MYSQL_CMD="mariadb"; fi

  local MAX_TRIES=30
  local i=0
  while (( i < MAX_TRIES )); do
    if sudo $MYSQL_CMD -e "SELECT 1" &>/dev/null 2>&1; then
      ok "MariaDB is ready"
      return 0
    fi
    sleep 1
    i=$((i + 1))
    if (( i % 5 == 0 )); then
      log "  Still waiting… (${i}/${MAX_TRIES}s)"
    fi
  done

  die "MariaDB did not become ready after ${MAX_TRIES}s. Check logs: sudo journalctl -u mariadb -n 50"
}

# ─── ffmpeg ────────────────────────────────────────────────
install_ffmpeg() {
  log "Checking ffmpeg…"
  if command -v ffmpeg &>/dev/null && command -v ffprobe &>/dev/null; then
    ok "ffmpeg found: $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
  else
    log "Installing ffmpeg…"
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y -qq ffmpeg
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y ffmpeg
    elif command -v pacman &>/dev/null; then
      sudo pacman -Sy --noconfirm ffmpeg
    else
      die "Cannot auto-install ffmpeg. Install it manually and re-run."
    fi
    ok "ffmpeg installed"
  fi

  # GPU hint
  if command -v nvidia-smi &>/dev/null; then
    ok "NVIDIA GPU detected: $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
  elif [[ -d /dev/dri ]]; then
    ok "VA-API/QSV device found (/dev/dri)"
  else
    warn "No GPU detected — encoding will use CPU (libx265/libsvtav1)"
  fi
}

# ─── Directories ───────────────────────────────────────────
create_dirs() {
  mkdir -p "$SCRIPT_DIR/data/thumbs" \
           "$SCRIPT_DIR/data/encoded" \
           "$SCRIPT_DIR/data/logs"
  ok "Data directories created"
}

# ─── npm install ───────────────────────────────────────────
install_deps() {
  log "Installing Node.js dependencies…"
  cd "$SCRIPT_DIR"
  npm install --production 2>&1 | tail -5
  ok "Dependencies installed"
}

# ─── Database setup ────────────────────────────────────────
setup_database() {
  log "Setting up Encodium database…"

  # If .env already exists, read creds from it instead of generating new ones
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    local EXISTING_USER EXISTING_PASS EXISTING_DB
    EXISTING_USER=$(grep -E '^DB_USER=' "$SCRIPT_DIR/.env" | cut -d= -f2- | tr -d "'" | tr -d '"') || true
    EXISTING_PASS=$(grep -E '^DB_PASS=' "$SCRIPT_DIR/.env" | cut -d= -f2- | tr -d "'" | tr -d '"') || true
    EXISTING_DB=$(grep -E '^DB_NAME=' "$SCRIPT_DIR/.env" | cut -d= -f2- | tr -d "'" | tr -d '"') || true
    if [[ -n "$EXISTING_USER" && -n "$EXISTING_PASS" ]]; then
      log "Using database credentials from existing .env"
      export SETUP_DB_NAME="${EXISTING_DB:-encodium}"
      export SETUP_DB_USER="$EXISTING_USER"
      export SETUP_DB_PASS="$EXISTING_PASS"
    fi
  fi

  local DB_NAME="${SETUP_DB_NAME:-encodium}"
  local DB_USER_NAME="${SETUP_DB_USER:-encodium}"
  local DB_PASS="${SETUP_DB_PASS:-}"

  # Generate password if we don't have one yet
  if [[ -z "$DB_PASS" ]]; then
    DB_PASS="$(rand_string 24)"
    log "Generated DB password"
  fi

  local MYSQL_CMD="mysql"
  if command -v mariadb &>/dev/null; then MYSQL_CMD="mariadb"; fi

  # Determine root access method
  local ROOT_OK=0
  local ROOT_CMD=()

  if sudo $MYSQL_CMD -e "SELECT 1" &>/dev/null 2>&1; then
    ROOT_CMD=(sudo "$MYSQL_CMD")
    ROOT_OK=1
  elif $MYSQL_CMD -u root -e "SELECT 1" &>/dev/null 2>&1; then
    ROOT_CMD=("$MYSQL_CMD" -u root)
    ROOT_OK=1
  elif [[ -n "${MYSQL_ROOT_PASS:-}" ]]; then
    if $MYSQL_CMD -u root -p"$MYSQL_ROOT_PASS" -e "SELECT 1" &>/dev/null 2>&1; then
      ROOT_CMD=("$MYSQL_CMD" -u root -p"$MYSQL_ROOT_PASS")
      ROOT_OK=1
    fi
  fi

  if (( ! ROOT_OK )); then
    die "Cannot access MariaDB as root. Try: export MYSQL_ROOT_PASS='yourpass' before running install.sh"
  fi

  "${ROOT_CMD[@]}" <<EOSQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER_NAME'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER_NAME'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER_NAME'@'localhost';
FLUSH PRIVILEGES;
EOSQL
  ok "Database '$DB_NAME' ready, user '$DB_USER_NAME' configured"

  # Export for .env creation
  export SETUP_DB_NAME="$DB_NAME"
  export SETUP_DB_USER="$DB_USER_NAME"
  export SETUP_DB_PASS="$DB_PASS"
}

# ─── .env file ─────────────────────────────────────────────
create_env() {
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    # Update DB creds if they were regenerated
    if [[ -n "${SETUP_DB_PASS:-}" ]]; then
      sed -i "s|^DB_USER=.*|DB_USER=${SETUP_DB_USER}|" "$SCRIPT_DIR/.env"
      sed -i "s|^DB_PASS=.*|DB_PASS=${SETUP_DB_PASS}|" "$SCRIPT_DIR/.env"
      sed -i "s|^DB_NAME=.*|DB_NAME=${SETUP_DB_NAME}|" "$SCRIPT_DIR/.env"
    fi
    # Ensure PORT is set
    if ! grep -q "^PORT=" "$SCRIPT_DIR/.env"; then
      echo "PORT=$APP_PORT" >> "$SCRIPT_DIR/.env"
    fi
    ok ".env already exists (credentials synced)"
    return 0
  fi

  log "Creating .env…"

  local JWT_SECRET
  JWT_SECRET="$(rand_string 48)"

  # Detect a sensible default MEDIA_DIR
  local MEDIA_DIR="${MEDIA_DIR:-}"
  if [[ -z "$MEDIA_DIR" ]]; then
    if [[ -d "$HOME/Videos" ]]; then
      MEDIA_DIR="$HOME/Videos"
    elif [[ -d "$HOME/media" ]]; then
      MEDIA_DIR="$HOME/media"
    else
      MEDIA_DIR="$SCRIPT_DIR/data/media"
      mkdir -p "$MEDIA_DIR"
    fi
  fi

  local ENCODE_DIR="${ENCODE_DIR:-$SCRIPT_DIR/data/encoded}"

  cat > "$SCRIPT_DIR/.env" <<EOF
# Encodium Configuration — auto-generated $(date -Iseconds 2>/dev/null || date)
NODE_ENV=production

DB_HOST=localhost
DB_PORT=3306
DB_USER=${SETUP_DB_USER:-encodium}
DB_PASS=${SETUP_DB_PASS:-changeme}
DB_NAME=${SETUP_DB_NAME:-encodium}

JWT_SECRET=$JWT_SECRET
PORT=$APP_PORT

# Directories
MEDIA_DIR=$MEDIA_DIR
ENCODE_DIR=$ENCODE_DIR
THUMB_DIR=$SCRIPT_DIR/data/thumbs
MAX_WORKERS=2
EOF

  chmod 600 "$SCRIPT_DIR/.env"
  ok ".env created → MEDIA_DIR=$MEDIA_DIR"
}

# ─── Create admin account ─────────────────────────────────
create_admin() {
  log "Creating admin account & initializing schema…"
  cd "$SCRIPT_DIR"

  # Source .env vars
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a

  # Write a temp script in project dir (needs local modules)
  local TMPJS="$SCRIPT_DIR/.tmp-admin-setup.js"
  cat > "$TMPJS" <<'ENDJS'
const bcrypt = require('bcryptjs');
const db = require('./db');

(async () => {
  try {
    await db.initSchema();
    console.log('[encodium] Schema initialized');

    const email = process.env.ADMIN_EMAIL || 'admin@encodium.local';
    const pass  = process.env.ADMIN_PASS  || 'admin';
    const existing = await db.getUserByEmail(email);
    if (existing) {
      console.log('[encodium] Admin already exists: ' + email);
      process.exit(0);
    }
    const hash = await bcrypt.hash(pass, 12);
    await db.createUser('Admin', email, hash, 'admin');
    console.log('[encodium] Admin created: ' + email);
    process.exit(0);
  } catch (e) {
    console.error('[encodium] Admin creation error:', e.message);
    process.exit(1);
  }
})();
ENDJS

  node "$TMPJS"
  rm -f "$TMPJS"
  ok "Schema initialized, admin account ready (admin@encodium.local / admin)"
}

# ─── PM2 setup ─────────────────────────────────────────────
setup_pm2() {
  log "Setting up PM2 process manager…"

  # Install PM2 globally if not present
  if ! command -v pm2 &>/dev/null; then
    log "Installing PM2…"
    npm install -g pm2 2>&1 | tail -3
    ok "PM2 installed"
  fi

  # Ensure pm2 is on PATH (nvm installs global packages next to node)
  if ! command -v pm2 &>/dev/null; then
    local PM2_PATH="$(dirname "$NODE_BIN")/pm2"
    if [[ -x "$PM2_PATH" ]]; then
      export PATH="$(dirname "$NODE_BIN"):$PATH"
    else
      die "PM2 installed but not found on PATH"
    fi
  fi

  # Stop previous instance if running
  pm2 delete "$APP_NAME" 2>/dev/null || true

  # Kill anything already on our port (stale processes from previous install)
  local STALE_PID
  STALE_PID=$(sudo fuser "${APP_PORT}/tcp" 2>/dev/null | xargs) || true
  if [[ -n "$STALE_PID" ]]; then
    log "Killing stale process(es) on port $APP_PORT: $STALE_PID"
    sudo kill -9 $STALE_PID 2>/dev/null || true
    sleep 1
  fi

  # ecosystem.config.js is shipped in the repo (updated via git pull).
  # Only generate a fallback if the file is somehow missing.
  if [[ ! -f "$SCRIPT_DIR/ecosystem.config.js" ]]; then
    warn "ecosystem.config.js missing — generating default"
    cat > "$SCRIPT_DIR/ecosystem.config.js" <<'EOF'
const path = require('path');
const BASE = path.resolve(__dirname);

module.exports = {
  apps: [{
    name: 'encodium',
    script: path.join(BASE, 'server.js'),
    cwd: BASE,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    kill_timeout: 15000,
    env: {
      NODE_ENV: 'production',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: path.join(BASE, 'data/logs/error.log'),
    out_file: path.join(BASE, 'data/logs/out.log'),
    merge_logs: true,
  }],
};
EOF
  else
    ok "ecosystem.config.js present (managed by git)"
  fi

  # Start with PM2 (always uses the file from repo / git pull)
  pm2 start "$SCRIPT_DIR/ecosystem.config.js"

  # Wait a moment for the app to bind the port
  sleep 2

  # Verify it's running
  if pm2 pid "$APP_NAME" &>/dev/null && [[ "$(pm2 pid "$APP_NAME")" != "" ]]; then
    ok "PM2: Encodium is running (PID $(pm2 pid "$APP_NAME"))"
  else
    warn "PM2 process may not have started correctly — check: pm2 logs $APP_NAME"
  fi

  # Save PM2 process list
  pm2 save --force 2>/dev/null || pm2 save 2>/dev/null || true

  # Setup PM2 startup (auto-start on reboot)
  local STARTUP_CMD
  STARTUP_CMD=$(pm2 startup 2>/dev/null | grep "sudo" | head -1) || true
  if [[ -n "$STARTUP_CMD" ]]; then
    log "Running PM2 startup hook…"
    eval "$STARTUP_CMD" 2>/dev/null || warn "PM2 startup hook failed (non-critical in containers)"
  fi
}

# ─── Systemd service (fallback / additional) ──────────────
setup_systemd() {
  # Only attempt if systemctl is usable (skip in containers)
  if ! command -v systemctl &>/dev/null; then
    warn "systemctl not available — skipping systemd service"
    return 0
  fi

  # Check if systemd is actually running (PID 1)
  if [[ "$(cat /proc/1/comm 2>/dev/null)" != "systemd" ]]; then
    warn "Not a systemd system — skipping systemd service"
    return 0
  fi

  log "Creating systemd service…"

  local SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
  local RUN_USER
  RUN_USER="$(whoami)"

  sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Encodium — Video Encoding Platform
Documentation=https://github.com/HeartBtz/Encodium
After=network.target mariadb.service mysql.service
Wants=mariadb.service

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$SCRIPT_DIR
EnvironmentFile=$SCRIPT_DIR/.env
ExecStart=$NODE_BIN $SCRIPT_DIR/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$APP_NAME

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$SCRIPT_DIR/data ${MEDIA_DIR:-}
PrivateTmp=true

# Allow GPU access for hardware encoding
SupplementaryGroups=video render

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable "$APP_NAME" 2>/dev/null || true
  ok "Systemd: service '$APP_NAME' created and enabled"
  log "  Start: sudo systemctl start $APP_NAME"
  log "  Logs:  journalctl -u $APP_NAME -f"
}

# ─── Health check ──────────────────────────────────────────
health_check() {
  log "Running health check…"
  local MAX=15
  local i=0
  while (( i < MAX )); do
    if curl -sf -o /dev/null -w '%{http_code}' "http://localhost:${APP_PORT}/" 2>/dev/null | grep -qE '^(200|301|302)'; then
      ok "Health check passed — Encodium responds on port $APP_PORT"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  warn "Health check: Encodium not responding yet on port $APP_PORT"
  warn "  Check logs: pm2 logs $APP_NAME"
}

# ─── Main ──────────────────────────────────────────────────
main() {
  banner

  log "Starting fully autonomous installation…"
  echo ""

  # Phase 1: System dependencies
  preflight
  install_node
  install_mariadb
  install_ffmpeg
  echo ""

  # Phase 2: Application setup
  create_dirs
  install_deps
  setup_database
  create_env
  create_admin
  echo ""

  # Phase 3: Process management
  log "Setting up process management…"
  echo ""
  setup_pm2
  setup_systemd
  echo ""

  # Phase 4: Verify
  health_check

  echo ""
  echo -e "${GREEN}${BOLD}  ══════════════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}    ✓ Encodium installation complete!${NC}"
  echo -e "${GREEN}${BOLD}  ══════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  ${BOLD}URL${NC}      http://localhost:${APP_PORT}"
  echo -e "  ${BOLD}Login${NC}    admin@encodium.local / admin"
  echo ""
  echo -e "  ${CYAN}PM2 commands:${NC}"
  echo "    pm2 status              Show processes"
  echo "    pm2 logs $APP_NAME        Follow logs"
  echo "    pm2 restart $APP_NAME     Restart"
  echo "    pm2 stop $APP_NAME        Stop"
  echo ""
  if [[ "$(cat /proc/1/comm 2>/dev/null)" == "systemd" ]]; then
    echo -e "  ${CYAN}Systemd commands:${NC}"
    echo "    sudo systemctl status $APP_NAME"
    echo "    sudo systemctl restart $APP_NAME"
    echo "    journalctl -u $APP_NAME -f"
    echo ""
  fi
  echo -e "  ${CYAN}Docker alternative:${NC}"
  echo "    docker compose up -d"
  echo "    docker compose --profile gpu up -d   # NVIDIA GPU"
  echo ""
  echo -e "  ${YELLOW}⚠  Change admin password after first login!${NC}"
  echo -e "  ${YELLOW}⚠  DB_PASS is required — .env has been pre-configured.${NC}"
  echo -e "  ${YELLOW}⚠  Set JWT_SECRET in .env to persist sessions across restarts.${NC}"
  echo ""
}

main "$@"
