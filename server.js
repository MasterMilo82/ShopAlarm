require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuration Constants ---
const ORDER_WEBHOOK_SECRET = process.env.ORDER_WEBHOOK_SECRET || 'your_order_webhook_secret_here'; // ENV VAR!
const ESP32_SECRET = process.env.ESP32_SECRET || 'your_esp32_device_secret_here'; // ENV VAR!

const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json'); // Persist settings to file
const USERS_FILE = path.join(__dirname, 'data', 'users.json'); // User credentials file

// --- Initial Alarm Settings (will be loaded/saved from file) ---
let alarmSettings = {
    alarmEnabled: true,
    relays: {
        '1': { onTimeMs: 5000, delayMs: 0 },
        '2': { onTimeMs: 5000, delayMs: 1000 },
        '3': { onTimeMs: 5000, delayMs: 2000 },
        '4': { onTimeMs: 5000, delayMs: 3000 },
    },
    // State to be sent to ESP32 on its next poll
    activeTrigger: null, // { source: 'order'|'test', timestamp: ms, relayStates: {1:true, 2:false,...} }
    testRelay: {
        id: null, // Relay ID being tested (1-4)
        onTimeMs: 500 // Test duration
    }
};

// --- In-memory Users data ---
let users = [];

// --- Load settings from file ---
function loadSettings() {
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const loaded = JSON.parse(data);
            // Merge loaded settings to preserve new properties from code changes
            alarmSettings = { ...alarmSettings, ...loaded };
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
    secret: process.env.SESSION_SECRET || 'super_secret_session_key', // ENV VAR!
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

// --- Dashboard Login Routes ---
app.get('/', (req, res) => {
    if(req.session.isAuthenticated) {
        return res.redirect('/dashboard');
    }else{
        return res.redirect('/login');
    }
});

app.get('/dashboard', (req, res) => {
    if(!req.session.isAuthenticated) {
        return res.redirect('/login');
    }

    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/login', (req, res) => {
    if(req.session.isAuthenticated) {
        return res.redirect('/dashboard');
    }

    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    // Find user in the loaded users array
    const user = users.find(u => u.username === username);

    // Compare plain-text password (DANGER ZONE!)
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

    if (alarmSettings.alarmEnabled) {
        alarmSettings.activeTrigger = {
            source: 'order',
            timestamp: Date.now(),
            relayConfig: alarmSettings.relays
        };
        saveSettings(); // Save state
        console.log('Alarm trigger activated for Order event.');
        res.status(200).send('Alarm triggered via API.');
    } else {
        console.log('Alarm is disabled, not triggering for Order event.');
        res.status(200).send('Alarm is disabled, trigger ignored.');
    }
});

// ESP32 polling endpoint for current configuration and commands
app.get('/api/data', (req, res) => {
    console.log('ESP32 polling request from IP:', req.ip);

    const esp32Secret = req.query.secret;
    if (esp32Secret !== ESP32_SECRET) {
        console.warn('Unauthorized ESP32 data request from IP:', req.ip);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const now = Date.now();
    let relayStates = {};
    let isActive = false;
    let newTestRelay = { id: null, onTimeMs: 0 };

    // Handle test relay command
    if (alarmSettings.testRelay.id !== null) {
        newTestRelay = { ...alarmSettings.testRelay }; // Send current test state
        // Clear test relay immediately after sending it once to ESP32
        alarmSettings.testRelay.id = null;
        alarmSettings.testRelay.onTimeMs = 0;
        saveSettings(); // Persist the cleared test state
    }

    if (alarmSettings.activeTrigger) {
        isActive = true; // Indicates there's an ongoing trigger

        for (const relayId in alarmSettings.activeTrigger.relayConfig) {
            const config = alarmSettings.activeTrigger.relayConfig[relayId];
            const elapsed = now - alarmSettings.activeTrigger.timestamp;

            if (elapsed >= config.delayMs && elapsed < (config.delayMs + config.onTimeMs)) {
                relayStates[relayId] = true; // Relay should be ON
            } else {
                relayStates[relayId] = false; // Relay should be OFF
            }
        }

        // Check if all relays have completed their onTime
        const allRelaysFinished = Object.keys(alarmSettings.activeTrigger.relayConfig).every(relayId => {
            const config = alarmSettings.activeTrigger.relayConfig[relayId];
            return now >= (alarmSettings.activeTrigger.timestamp + config.delayMs + config.onTimeMs);
        });

        if (allRelaysFinished) {
            isActive = false;
            relayStates = { '1': false, '2': false, '3': false, '4': false }; // Ensure all are off
            alarmSettings.activeTrigger = null; // Clear the trigger
            saveSettings(); // Persist the cleared trigger state
            console.log('Active trigger completed and cleared.');
        }
    } else {
        // No active trigger, ensure all relays are off
        relayStates = { '1': false, '2': false, '3': false, '4': false };
    }

    res.json({
        alarmEnabled: alarmSettings.alarmEnabled,
        triggerActive: isActive,
        relays: relayStates, // {1:true, 2:false, 3:false, 4:true}
        testRelay: newTestRelay // {id: 1, onTimeMs: 500} or {id: null, onTimeMs: 0}
    });
});

// Get/Update dashboard settings
app.get('/api/dashboard/settings', isAuthenticated, (req, res) => {
    // Only return configurable parts to the dashboard
    res.json({
        alarmEnabled: alarmSettings.alarmEnabled,
        relays: alarmSettings.relays
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
    }

    alarmSettings.alarmEnabled = alarmEnabled;
    alarmSettings.relays = relays;
    saveSettings();

    console.log('Dashboard settings updated:', { alarmEnabled, relays });
    res.json({ message: 'Settings updated successfully!', settings: { alarmEnabled, relays } });
});

// Command to test a specific relay from dashboard
app.post('/api/dashboard/commands/test-relay/:id', isAuthenticated, (req, res) => {
    const relayId = req.params.id;
    if (!['1', '2', '3', '4'].includes(relayId)) {
        return res.status(400).send('Invalid relay ID.');
    }

    // Set the test command for the ESP32 to pick up
    alarmSettings.testRelay = {
        id: parseInt(relayId, 10),
        onTimeMs: 500 // Fixed 500ms test duration
    };
    saveSettings(); // Persist this temporary test state

    console.log(`Test command sent for relay ${relayId}.`);
    res.status(200).send(`Test alarm command sent for relay ${relayId}!`);
});

// Command to deactivate any current active alarm
app.post('/api/dashboard/commands/deactivate-alarm', isAuthenticated, (req, res) => {
    if (alarmSettings.activeTrigger || alarmSettings.testRelay.id !== null) {
        alarmSettings.activeTrigger = null;
        alarmSettings.testRelay = { id: null, onTimeMs: 0 }; // Clear any test
        saveSettings();
        console.log('Deactivate alarm command issued from dashboard. Active trigger cleared.');
        res.status(200).send('Active alarm cleared!');
    } else {
        res.status(200).send('No active alarm to deactivate.');
    }
});

// Initialize and start server
loadSettings(); // Load settings on startup
loadUsers(); // Load users on startup
app.listen(PORT, () => {
    console.log(`Cloud service running on port ${PORT}`);
    console.log(`Dashboard available at http://localhost:${PORT}/ (login required)`);
    console.log(`Order Webhook URL: http://localhost:${PORT}/webhook/order`);
    console.log(`ESP32 Polling URL: http://localhost:${PORT}/api/data?secret=${ESP32_SECRET}`);
});