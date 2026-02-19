module.exports = {
  apps: [{
    name: 'encodium',
    script: '/home/coder/encodium/server.js',
    cwd: '/home/coder/encodium',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
