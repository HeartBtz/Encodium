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
