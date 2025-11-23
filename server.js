require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuration Constants ---
const ORDER_WEBHOOK_SECRET = process.env.ORDER_WEBHOOK_SECRET || 'your_order_webhook_secret_here'; // ENV VAR!
const ESP32_SECRET = process.env.ESP32_SECRET || 'your_esp32_device_secret_here'; // ENV VAR!
const SESSION_SECRET = process.env.SESSION_SECRET || 'super_secret_session_key'; // ENV VAR!

const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json'); // Persist settings to file
const USERS_FILE = path.join(__dirname, 'data', 'users.json'); // User credentials file

// --- Initial Alarm Settings (will be loaded/saved from file) ---
let alarmSettings = {
    alarmEnabled: true,
    relays: {
        '1': { onTimeMs: 5000, delayMs: 0, pulseMs: 0, enabled: true },   // Added enabled
        '2': { onTimeMs: 5000, delayMs: 1000, pulseMs: 0, enabled: true }, // Added enabled
        '3': { onTimeMs: 5000, delayMs: 2000, pulseMs: 0, enabled: true }, // Added enabled
        '4': { onTimeMs: 5000, delayMs: 3000, pulseMs: 0, enabled: true }, // Added enabled
    },
    // State to be sent to ESP32 via WebSocket
    activeTrigger: null, // { source: 'order'|'test', timestamp: ms, relayConfig: {1:{onTimeMs, delayMs, pulseMs, enabled}, ...} }
    testRelay: {
        id: null, // Relay ID being tested (1-4)
        onTimeMs: 0, // Test duration
        pulseMs: 0,   // Test pulse duration
        timestamp: 0 // Timestamp when test started
    },
    // Current relay states derived from activeTrigger (for ESP32)
    currentRelayStates: { '1': false, '2': false, '3': false, '4': false },
    triggerActive: false // Indicates if an active trigger is running
};

// --- In-memory Users data ---
let users = [];

// --- WebSocket Server Setup ---
const wss = new WebSocket.Server({ noServer: true }); // Attach to http server later

// Store connected WebSocket clients
const connectedClients = new Set(); // Stores all authenticated clients (ESP32 and dashboard)

// Periodically check and update relay states based on activeTrigger
let intervalId = null;

function calculateAndBroadcastRelayStates() {
    const now = Date.now();
    let updatedRelayStates = { '1': false, '2': false, '3': false, '4': false };
    let newTriggerActive = false;

    // Handle the main active trigger
    if (alarmSettings.alarmEnabled && alarmSettings.activeTrigger) { // Added alarmSettings.alarmEnabled check
        newTriggerActive = true;

        let allRelaysFinished = true; // Assume all finished until proven otherwise

        for (const relayId in alarmSettings.activeTrigger.relayConfig) {
            const config = alarmSettings.activeTrigger.relayConfig[relayId];

            // Only process relays that are individually enabled
            if (!config.enabled) {
                updatedRelayStates[relayId] = false;
                continue; // Skip disabled relays
            }

            const elapsed = now - alarmSettings.activeTrigger.timestamp;
            const effectiveEndTime = config.delayMs + config.onTimeMs;

            if (elapsed >= config.delayMs && elapsed < effectiveEndTime) {
                // Relay is within its active window
                if (config.pulseMs > 0) {
                    // Pulse mode is active
                    const pulseCycleTime = config.pulseMs * 2; // on + off duration
                    const timeInWindow = elapsed - config.delayMs;
                    if (timeInWindow % pulseCycleTime < config.pulseMs) {
                        updatedRelayStates[relayId] = true; // Pulse ON
                    } else {
                        updatedRelayStates[relayId] = false; // Pulse OFF
                    }
                } else {
                    // Solid ON mode
                    updatedRelayStates[relayId] = true;
                }
                allRelaysFinished = false; // At least one enabled relay is still active
            } else {
                updatedRelayStates[relayId] = false; // Relay should be OFF (either not started or finished)
            }
        }

        // Check if all *enabled* relays that were part of the trigger have finished
        const allEnabledTriggerRelaysFinished = Object.keys(alarmSettings.activeTrigger.relayConfig).every(relayId => {
            const config = alarmSettings.activeTrigger.relayConfig[relayId];
            if (!config.enabled) return true; // Disabled relays are considered "finished" immediately
            return now >= (alarmSettings.activeTrigger.timestamp + config.delayMs + config.onTimeMs);
        });

        if (allEnabledTriggerRelaysFinished) {
            newTriggerActive = false;
            updatedRelayStates = { '1': false, '2': false, '3': false, '4': false }; // Ensure all are off
            alarmSettings.activeTrigger = null; // Clear the trigger
            console.log('Active trigger completed and cleared.');
        }
    }

    // Handle test relay commands, which override activeTrigger for that specific relay
    // A test relay always implies a triggerActive state for its duration
    if (alarmSettings.testRelay.id !== null && alarmSettings.testRelay.onTimeMs > 0) {
        const testRelayId = String(alarmSettings.testRelay.id);
        const testStartTime = alarmSettings.testRelay.timestamp;
        const elapsedTest = now - testStartTime;
        const testEndTime = alarmSettings.testRelay.onTimeMs;
        const testPulseMs = alarmSettings.testRelay.pulseMs;

        if (elapsedTest < testEndTime) {
            if (testPulseMs > 0) {
                const pulseCycleTime = testPulseMs * 2;
                if (elapsedTest % pulseCycleTime < testPulseMs) {
                    updatedRelayStates[testRelayId] = true; // Pulse ON for test
                } else {
                    updatedRelayStates[testRelayId] = false; // Pulse OFF for test
                }
            } else {
                updatedRelayStates[testRelayId] = true; // Solid ON for test
            }
            newTriggerActive = true; // Test relay implies an "active" state
        } else {
            // Test relay finished
            alarmSettings.testRelay = { id: null, onTimeMs: 0, pulseMs: 0, timestamp: 0 };
            // Clear the specific relay's state to off if it was just testing and no other trigger is active
            if (!alarmSettings.activeTrigger) { // Check if main trigger is also inactive
                updatedRelayStates[testRelayId] = false;
            }
            saveSettings(); // Persist the cleared test state
        }
    }


    // Check if states have actually changed before broadcasting
    const relayStatesChanged = JSON.stringify(updatedRelayStates) !== JSON.stringify(alarmSettings.currentRelayStates);
    const triggerActiveChanged = newTriggerActive !== alarmSettings.triggerActive;

    if (relayStatesChanged || triggerActiveChanged || (alarmSettings.testRelay.id !== null && alarmSettings.testRelay.onTimeMs > 0)) {
        alarmSettings.currentRelayStates = updatedRelayStates;
        alarmSettings.triggerActive = newTriggerActive;
        // Save settings if activeTrigger was cleared or a testRelay finished
        if (!alarmSettings.activeTrigger && !newTriggerActive && !alarmSettings.testRelay.id) {
            saveSettings(); // Only save if system becomes completely idle
        }
        broadcastSettings(); // Broadcast the updated state
    }

    // Manage the interval: start if needed, stop if idle
    if (!alarmSettings.activeTrigger && alarmSettings.testRelay.id === null && intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        console.log('Stopped relay state update interval.');
    } else if ((alarmSettings.activeTrigger || alarmSettings.testRelay.id !== null) && !intervalId) {
        // If an active trigger starts and no interval is running, start it
        intervalId = setInterval(calculateAndBroadcastRelayStates, 100); // Check every 100ms
        console.log('Started relay state update interval.');
    }
}


// --- Broadcast function to send updated settings to all connected clients ---
function broadcastSettings() {
    const dataToSend = JSON.stringify({
        alarmEnabled: alarmSettings.alarmEnabled,
        triggerActive: alarmSettings.triggerActive,
        relays: alarmSettings.currentRelayStates, // ESP32 needs current states
        testRelay: alarmSettings.testRelay // ESP32 needs test relay command
    });

    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(dataToSend);
        }
    });

    // We no longer clear testRelay immediately here. It's now handled by calculateAndBroadcastRelayStates
    // based on its internal timer.
}


// --- Load settings from file ---
function loadSettings() {
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const loaded = JSON.parse(data);
            // Merge loaded settings to preserve new properties from code changes
            // Ensure pulseMs and enabled are present, defaulting if not in loaded file
            for (const key in alarmSettings.relays) {
                if (loaded.relays && loaded.relays[key]) {
                    loaded.relays[key].pulseMs = loaded.relays[key].pulseMs !== undefined ? loaded.relays[key].pulseMs : 0;
                    loaded.relays[key].enabled = loaded.relays[key].enabled !== undefined ? loaded.relays[key].enabled : true; // Default to true
                }
            }
            alarmSettings = { ...alarmSettings, ...loaded };

            // Ensure testRelay structure is consistent (especially pulseMs, timestamp)
            alarmSettings.testRelay = {
                id: alarmSettings.testRelay.id || null,
                onTimeMs: alarmSettings.testRelay.onTimeMs || 0,
                pulseMs: alarmSettings.testRelay.pulseMs !== undefined ? alarmSettings.testRelay.pulseMs : 0,
                timestamp: alarmSettings.testRelay.timestamp || 0
            };

            console.log('Settings loaded:', alarmSettings);
        } catch (error) {
            console.error('Error loading settings file:', error);
        }
    } else {
        console.log('Settings file not found, using default settings.');
        saveSettings(); // Create it with defaults
    }
}

// --- Save settings to file ---
function saveSettings() {
    try {
        fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); // Ensure data folder exists
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(alarmSettings, null, 2), 'utf8');
    } catch (error) {
        console.error('Error saving settings file:', error);
    }
}

// --- Load users from file ---
function loadUsers() {
    if (fs.existsSync(USERS_FILE)) {
        try {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            users = JSON.parse(data);
            console.log('Users loaded:', users.map(u => u.username)); // Log usernames, not passwords
        } catch (error) {
            console.error('Error loading users file:', error);
            users = []; // Reset users if file is corrupted
        }
    } else {
        console.error('Users file not found at:', USERS_FILE);
        console.error('Please create data/users.json with at least one user.');
        // Optionally create a default user here, but it's better to require manual creation for security
        users = [];
    }
}

// --- Express Middleware ---
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production' } // Use secure cookies in production (HTTPS)
}));

// --- Authentication Middleware ---
function isAuthenticated(req, res, next) {
    if (req.session.isAuthenticated) {
        return next();
    }
    res.redirect('/login');
}

// --- Serve Static Dashboard Files ---
app.use(express.static(path.join(__dirname, 'assets')));
app.use('/views', express.static(path.join(__dirname, 'views'))); // Allow assets to access view files for WS client


// --- Dashboard Login Routes ---
app.get('/', (req, res) => {
    if (req.session.isAuthenticated) {
        return res.redirect('/dashboard');
    } else {
        return res.redirect('/login');
    }
});

app.get('/dashboard', (req, res) => {
    if (!req.session.isAuthenticated) {
        return res.redirect('/login');
    }

    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/login', (req, res) => {
    if (req.session.isAuthenticated) {
        return res.redirect('/dashboard');
    }

    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    // Find user in the loaded users array
    const user = users.find(u => u.username === username);

    // Compare plain-text password (DANGER ZONE!) - Consider hashing in production!
    if (user && user.password === password) {
        req.session.isAuthenticated = true;
        res.redirect('/');
    } else {
        res.redirect('/login?error=Invalid credentials');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// --- API Endpoints ---

// Order Webhook endpoint
app.post('/webhook/order', (req, res) => {
    const orderSecret = req.query.secret;
    if (orderSecret !== ORDER_WEBHOOK_SECRET) {
        console.warn('Unauthorized order webhook attempt from IP:', req.ip);
        return res.status(401).send('Unauthorized');
    }

    console.log('Order webhook received!');

    // The main alarmEnabled toggle now controls whether any relay is triggered by an order
    if (alarmSettings.alarmEnabled) {
        // Use the currently configured relay settings (including 'enabled' property)
        alarmSettings.activeTrigger = {
            source: 'order',
            timestamp: Date.now(),
            relayConfig: JSON.parse(JSON.stringify(alarmSettings.relays)) // Deep copy of current configs
        };
        // Trigger calculation and broadcast immediately
        calculateAndBroadcastRelayStates();
        console.log('Alarm trigger activated for Order event.');
        res.status(200).send('Alarm triggered via API.');
    } else {
        console.log('Main alarm is disabled, not triggering for Order event.');
        res.status(200).send('Main alarm is disabled, trigger ignored.');
    }
});

// Get dashboard settings (for initial load)
app.get('/api/dashboard/settings', isAuthenticated, (req, res) => {
    // Only return configurable parts to the dashboard and current states
    res.json({
        alarmEnabled: alarmSettings.alarmEnabled,
        relays: alarmSettings.relays, // Configuration
        currentRelayStates: alarmSettings.currentRelayStates, // Live states
        triggerActive: alarmSettings.triggerActive
    });
});

app.post('/api/dashboard/settings', isAuthenticated, (req, res) => {
    const { alarmEnabled, relays } = req.body;

    // Basic validation
    if (typeof alarmEnabled !== 'boolean') {
        return res.status(400).send('Invalid alarm enabled status.');
    }
    if (typeof relays !== 'object' || Object.keys(relays).length !== 4) {
        return res.status(400).send('Invalid relays configuration.');
    }
    for (const id in relays) {
        const relay = relays[id];
        if (typeof relay.onTimeMs !== 'number' || relay.onTimeMs < 100 || relay.onTimeMs > 600000) { // 100ms to 10 min
            return res.status(400).send(`Invalid onTimeMs for relay ${id}.`);
        }
        if (typeof relay.delayMs !== 'number' || relay.delayMs < 0 || relay.delayMs > 600000) { // 0ms to 10 min
            return res.status(400).send(`Invalid delayMs for relay ${id}.`);
        }
        // Validation for pulseMs
        if (typeof relay.pulseMs !== 'number' || relay.pulseMs < 0 || relay.pulseMs > 5000) { // 0ms to 5 seconds
            return res.status(400).send(`Invalid pulseMs for relay ${id}. Must be between 0 and 5000.`);
        }
        // New validation for enabled
        if (typeof relay.enabled !== 'boolean') {
            return res.status(400).send(`Invalid enabled status for relay ${id}.`);
        }
    }

    alarmSettings.alarmEnabled = alarmEnabled;
    // Only update relay configuration, not live states here
    alarmSettings.relays = relays;
    saveSettings();

    // Trigger calculation and broadcast for updated settings
    calculateAndBroadcastRelayStates();

    console.log('Dashboard settings updated:', { alarmEnabled, relays });
    res.json({ message: 'Settings updated successfully!', settings: { alarmEnabled, relays } });
});

// Command to test a specific relay from dashboard
app.post('/api/dashboard/commands/test-relay/:id', isAuthenticated, (req, res) => {
    const relayId = req.params.id;
    if (!['1', '2', '3', '4'].includes(relayId)) {
        return res.status(400).send('Invalid relay ID.');
    }

    const currentRelayConfig = alarmSettings.relays[relayId];

    // Check if the individual relay is enabled before testing
    if (!currentRelayConfig.enabled) {
        return res.status(400).send(`Relay ${relayId} is disabled and cannot be tested.`);
    }

    // Set the test command for the ESP32 to pick up
    // Use the configured pulseMs for the test relay
    alarmSettings.testRelay = {
        id: parseInt(relayId, 10),
        onTimeMs: 500, // Fixed 500ms test duration
        pulseMs: currentRelayConfig.pulseMs, // Use configured pulse for test
        timestamp: Date.now() // Start test now
    };
    calculateAndBroadcastRelayStates(); // Broadcast the updated state with testRelay command

    console.log(`Test command sent for relay ${relayId}.`);
    res.status(200).send(`Test alarm command sent for relay ${relayId}!`);
});

// Command to deactivate any current active alarm
app.post('/api/dashboard/commands/deactivate-alarm', isAuthenticated, (req, res) => {
    if (alarmSettings.activeTrigger || alarmSettings.testRelay.id !== null || alarmSettings.triggerActive) {
        alarmSettings.activeTrigger = null;
        alarmSettings.testRelay = { id: null, onTimeMs: 0, pulseMs: 0, timestamp: 0 }; // Clear any test
        // Trigger calculation and broadcast to update state and clear interval if needed
        calculateAndBroadcastRelayStates();
        console.log('Deactivate alarm command issued from dashboard. Active trigger cleared.');
        res.status(200).send('Active alarm cleared!');
    } else {
        res.status(200).send('No active alarm to deactivate.');
    }
});


// --- WebSocket Server Connection Handling ---
const httpServer = app.listen(PORT, () => {
    console.log(`Cloud service running on port ${PORT}`);
    console.log(`Dashboard available at http://localhost:${PORT}/ (login required)`);
    console.log(`Order Webhook URL: http://localhost:${PORT}/webhook/order?secret=${ORDER_WEBHOOK_SECRET}`);
    console.log(`ESP32 WebSocket URL: ws://localhost:${PORT}/ws/esp32?secret=${ESP32_SECRET}`);
    console.log(`Dashboard WebSocket URL: ws://localhost:${PORT}/ws/dashboard`);
});

httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    const searchParams = new URL(request.url, `http://${request.headers.host}`).searchParams;

    if (pathname === '/ws/esp32') {
        const esp32Secret = searchParams.get('secret');
        if (esp32Secret === ESP32_SECRET) {
            wss.handleUpgrade(request, socket, head, ws => {
                wss.emit('connection', ws, request);
            });
        } else {
            console.warn('Unauthorized ESP32 WebSocket connection attempt from IP:', request.socket.remoteAddress);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
        }
    } else if (pathname === '/ws/dashboard') {
        // For dashboard, rely on the HTTP session for authentication
        // This is a simplified approach. In a real app, you might use a token
        // passed from the dashboard.html after initial login.
        // For now, we'll allow connection and assume the dashboard HTML
        // is only served to authenticated users.
        wss.handleUpgrade(request, socket, head, ws => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});


wss.on('connection', (ws, request) => {
    const clientType = request.url.includes('/ws/esp32') ? 'ESP32' : 'Dashboard';
    console.log(`${clientType} client connected from IP: ${request.socket.remoteAddress}`);
    connectedClients.add(ws);

    // Send current state immediately upon connection
    const dataToSend = JSON.stringify({
        alarmEnabled: alarmSettings.alarmEnabled,
        triggerActive: alarmSettings.triggerActive,
        relays: alarmSettings.currentRelayStates,
        testRelay: alarmSettings.testRelay
    });
    ws.send(dataToSend);

    ws.on('message', message => {
        console.log(`Received message from ${clientType}: ${message}`);
        // For this application, clients primarily receive.
        // If ESP32 needs to send status back, handle it here.
    });

    ws.on('close', () => {
        console.log(`${clientType} client disconnected from IP: ${request.socket.remoteAddress}`);
        connectedClients.delete(ws);
    });

    ws.on('error', error => {
        console.error(`${clientType} WebSocket error:`, error);
        connectedClients.delete(ws);
    });
});

// Ping clients to keep connections alive and detect dead ones
setInterval(() => {
    connectedClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    });
}, 30000); // Ping every 30 seconds

// Initialize and start server
loadSettings(); // Load settings on startup
loadUsers(); // Load users on startup
calculateAndBroadcastRelayStates(); // Initial broadcast and start interval if needed