const Store = require('electron-store');

module.exports = new Store({
    schema: {
        pulsoidToken: { type: 'string', default: '' },
        discordRpcEnabled: { type: 'boolean', default: false },
        realtimeEnabled: { type: 'boolean', default: true },
        updateIntervalMs: { type: 'number', default: 5000 }
    }
});