module.exports = {
    apps: [{
        name: 'stellar-veil',
        script: 'server.js',
        cwd: 'C:\\Users\\4_2\\Desktop\\projects\\side-project\\stellar-veil',
        watch: false,
        autorestart: true,
        max_restarts: 10,
        env: {
            NODE_ENV: 'production',
        },
    }],
};
