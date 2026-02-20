module.exports = {
  apps: [{
    name: 'encodium',
    script: '/home/coder/Encodium/server.js',
    cwd: '/home/coder/Encodium',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/home/coder/Encodium/data/logs/error.log',
    out_file: '/home/coder/Encodium/data/logs/out.log',
    merge_logs: true,
  }],
};
