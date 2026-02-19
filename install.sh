#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
# Encodium — Installation script
# ═══════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

NC='\033[0m'; BOLD='\033[1m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RED='\033[0;31m'; YELLOW='\033[0;33m'

log()  { echo -e "${CYAN}[encodium]${NC} $*"; }
ok()   { echo -e "${GREEN}[  OK  ]${NC} $*"; }
warn() { echo -e "${YELLOW}[ WARN ]${NC} $*"; }
err()  { echo -e "${RED}[ERROR ]${NC} $*"; }

banner() {
  echo -e "${BOLD}${CYAN}"
  echo "  ╔══════════════════════════════════════╗"
  echo "  ║         Encodium Installer           ║"
  echo "  ║      Video Encoding Platform         ║"
  echo "  ╚══════════════════════════════════════╝"
  echo -e "${NC}"
}

# ─── Node.js via nvm ───────────────────────────────────────
install_node() {
  log "Checking Node.js…"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    source "$NVM_DIR/nvm.sh"
  fi

  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v)
    ok "Node.js $ver already installed"
  else
    log "Installing nvm + Node.js 20 LTS…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    source "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm alias default 20
    nvm use default
    ok "Node.js $(node -v) installed"
  fi
}

# ─── MariaDB ───────────────────────────────────────────────
install_mariadb() {
  log "Checking MariaDB…"
  if command -v mariadb &>/dev/null || command -v mysql &>/dev/null; then
    ok "MariaDB/MySQL client found"
  else
    log "Installing MariaDB…"
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq mariadb-server mariadb-client
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y mariadb-server mariadb
      sudo systemctl enable --now mariadb
    elif command -v pacman &>/dev/null; then
      sudo pacman -Sy --noconfirm mariadb
      sudo mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql
      sudo systemctl enable --now mariadb
    else
      err "Cannot auto-install MariaDB. Please install manually."
      return 1
    fi
    ok "MariaDB installed"
  fi

  # Ensure running
  if command -v systemctl &>/dev/null; then
    if ! systemctl is-active --quiet mariadb 2>/dev/null && ! systemctl is-active --quiet mysql 2>/dev/null; then
      sudo systemctl start mariadb 2>/dev/null || sudo systemctl start mysql 2>/dev/null || true
    fi
  fi
}

# ─── ffmpeg ────────────────────────────────────────────────
install_ffmpeg() {
  log "Checking ffmpeg…"
  if command -v ffmpeg &>/dev/null; then
    ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}') found"
  else
    log "Installing ffmpeg…"
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y -qq ffmpeg
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y ffmpeg
    elif command -v pacman &>/dev/null; then
      sudo pacman -Sy --noconfirm ffmpeg
    else
      err "Cannot auto-install ffmpeg. Please install manually."
      return 1
    fi
    ok "ffmpeg installed"
  fi
}

# ─── Database setup ────────────────────────────────────────
setup_database() {
  log "Setting up Encodium database…"

  local DB_NAME="${DB_NAME:-encodium}"
  local DB_USER="${DB_USER:-encodium}"
  local DB_PASS="${DB_PASS:-}"

  if [[ -z "$DB_PASS" ]]; then
    DB_PASS=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)
    log "Generated DB password"
  fi

  local MYSQL_CMD="mysql"
  if command -v mariadb &>/dev/null; then MYSQL_CMD="mariadb"; fi

  # Try root access
  local ROOT_ARGS=()
  if sudo $MYSQL_CMD -e "SELECT 1" &>/dev/null; then
    ROOT_ARGS=(sudo $MYSQL_CMD)
  elif $MYSQL_CMD -u root -e "SELECT 1" &>/dev/null; then
    ROOT_ARGS=($MYSQL_CMD -u root)
  else
    warn "Cannot access MariaDB as root. Please create the database manually:"
    echo "  CREATE DATABASE IF NOT EXISTS $DB_NAME;"
    echo "  CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '<password>';"
    echo "  GRANT ALL ON $DB_NAME.* TO '$DB_USER'@'localhost';"
    echo "  FLUSH PRIVILEGES;"
    return 0
  fi

  "${ROOT_ARGS[@]}" <<EOSQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
EOSQL
  ok "Database '$DB_NAME' ready, user '$DB_USER' created"

  # Export for .env creation
  export SETUP_DB_NAME="$DB_NAME"
  export SETUP_DB_USER="$DB_USER"
  export SETUP_DB_PASS="$DB_PASS"
}

# ─── .env file ─────────────────────────────────────────────
create_env() {
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    warn ".env already exists, skipping"
    return 0
  fi

  log "Creating .env…"

  local JWT_SECRET
  JWT_SECRET=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)

  local MEDIA_DIR="${MEDIA_DIR:-$HOME/Videos}"
  local ENCODE_DIR="${ENCODE_DIR:-$SCRIPT_DIR/data/encoded}"

  cat > "$SCRIPT_DIR/.env" <<EOF
# Encodium Configuration
DB_HOST=localhost
DB_PORT=3306
DB_USER=${SETUP_DB_USER:-encodium}
DB_PASS=${SETUP_DB_PASS:-changeme}
DB_NAME=${SETUP_DB_NAME:-encodium}

JWT_SECRET=$JWT_SECRET
PORT=3001

# Directories
MEDIA_DIR=$MEDIA_DIR
ENCODE_DIR=$ENCODE_DIR
MAX_WORKERS=2
EOF

  chmod 600 "$SCRIPT_DIR/.env"
  ok ".env created (edit MEDIA_DIR and ENCODE_DIR as needed)"
}

# ─── npm install ───────────────────────────────────────────
install_deps() {
  log "Installing Node.js dependencies…"
  cd "$SCRIPT_DIR"
  npm install --production 2>&1 | tail -3
  ok "Dependencies installed"
}

# ─── Create admin account ─────────────────────────────────
create_admin() {
  log "Creating admin account…"
  cd "$SCRIPT_DIR"

  # Source .env
  set -a; source "$SCRIPT_DIR/.env"; set +a

  node -e "
    const bcrypt = require('bcryptjs');
    const mysql  = require('mysql2/promise');
    (async () => {
      const pool = mysql.createPool({
        host: process.env.DB_HOST, port: process.env.DB_PORT,
        user: process.env.DB_USER, password: process.env.DB_PASS,
        database: process.env.DB_NAME,
      });
      const db = require('./db');
      await db.initSchema();
      const email = process.env.ADMIN_EMAIL || 'admin@encodium.local';
      const pass  = process.env.ADMIN_PASS  || 'admin';
      const existing = await db.getUserByEmail(email);
      if (existing) { console.log('Admin already exists'); process.exit(0); }
      const hash = await bcrypt.hash(pass, 12);
      await db.createUser('Admin', email, hash, 'admin');
      console.log('Admin created: ' + email);
      process.exit(0);
    })().catch(e => { console.error(e.message); process.exit(1); });
  "
  ok "Admin account ready (admin@encodium.local / admin)"
}

# ─── Directories ───────────────────────────────────────────
create_dirs() {
  mkdir -p "$SCRIPT_DIR/data/thumbs" "$SCRIPT_DIR/data/encoded"
  ok "Data directories created"
}

# ─── Main ──────────────────────────────────────────────────
main() {
  banner
  install_node
  install_mariadb
  install_ffmpeg
  create_dirs
  install_deps
  setup_database
  create_env
  create_admin

  echo ""
  echo -e "${GREEN}${BOLD}  ✓ Encodium installation complete!${NC}"
  echo ""
  echo "  Start the server:"
  echo "    cd $SCRIPT_DIR && node server.js"
  echo ""
  echo "  Or with PM2:"
  echo "    pm2 start server.js --name encodium"
  echo ""
  echo "  Default login: admin@encodium.local / admin"
  echo "  Running on: http://localhost:${PORT:-3001}"
  echo ""
}

main "$@"
