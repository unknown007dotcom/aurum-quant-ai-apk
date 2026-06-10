// Mock global environment
global.window = { 
    addEventListener: (ev, cb) => { if(ev === 'DOMContentLoaded') setTimeout(cb, 10); },
    location: { hostname: 'localhost', port: '3000' },
    setInterval: () => {},
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    console: console,
    Notification: { permission: 'default', requestPermission: () => {} }
};
global.document = { 
    addEventListener: () => {}, 
    getElementById: (id) => ({ addEventListener: () => {}, setAttribute: () => {} }), 
    querySelector: (id) => ({ addEventListener: () => {}, setAttribute: () => {} }),
    documentElement: { setAttribute: () => {} },
    createElement: () => ({ setAttribute: () => {} })
};
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });

try {
    // Load app.js
    const fs = require('fs');
    const code = fs.readFileSync('./app.js', 'utf8');
    
    // Check for obvious syntax errors
    const vm = require('vm');
    const script = new vm.Script(code);
    console.log('Syntax Check passed');

    // Attempt execution
    const context = vm.createContext(global);
    vm.runInContext(code, context);
    console.log('App execution started without immediate crash');
} catch (e) {
    console.error('CRASH DETECTED:', e);
}
