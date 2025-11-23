document.addEventListener('DOMContentLoaded', () => {
    const alarmEnabledCheckbox = document.getElementById('alarm-enabled');
    const relaysContainer = document.getElementById('relays-container');
    const saveButton = document.getElementById('save-button');
    const deactivateButton = document.getElementById('deactivate-button');
    const statusMessage = document.getElementById('status-message');

    async function showStatus(message, isError = false) {
        statusMessage.textContent = message;
        statusMessage.className = `status-message ${isError ? 'error' : 'success'}`;
        statusMessage.style.display = 'block';
        await new Promise(resolve => setTimeout(resolve, 3000)); // Show for 3 seconds
        statusMessage.style.display = 'none';
    }

    // Function to render relay settings
    function renderRelaySettings(settings) {
        relaysContainer.innerHTML = ''; // Clear previous
        for (let i = 1; i <= 4; i++) {
            // Default if not found or new properties
            // Added 'enabled' property, defaulting to true
            const relay = settings.relays[i] || { onTimeMs: 5000, delayMs: 0, pulseMs: 0, enabled: true };

            const relayCard = document.createElement('div');
            relayCard.className = 'relay-card';
            relayCard.innerHTML = `
                <h2>Relay ${i}</h2>
                <div class="setting-group checkbox-group">
                    <input type="checkbox" id="relay-${i}-enabled" data-relay-id="${i}" data-setting="enabled" ${relay.enabled ? 'checked' : ''}>
                    <label for="relay-${i}-enabled">Enable Relay ${i}</label>
                </div>
                <div class="setting-group">
                    <label for="relay-${i}-on-time">On Duration (ms):</label>
                    <input type="number" id="relay-${i}-on-time" data-relay-id="${i}" data-setting="onTimeMs" min="100" max="600000" value="${relay.onTimeMs}">
                </div>
                <div class="setting-group">
                    <label for="relay-${i}-delay-time">Delay Before On (ms):</label>
                    <input type="number" id="relay-${i}-delay-time" data-relay-id="${i}" data-setting="delayMs" min="0" max="600000" value="${relay.delayMs}">
                </div>
                <div class="setting-group pulse-group">
                    <label for="relay-${i}-pulse-ms">Pulse Frequency (ms):</label>
                    <input type="number" id="relay-${i}-pulse-ms" data-relay-id="${i}" data-setting="pulseMs" min="0" max="5000" value="${relay.pulseMs}">
                    <span>(0 for off)</span>
                </div>
                <button class="btn secondary test-button" data-relay-id="${i}">Test Relay ${i} (500ms)</button>
            `;
            relaysContainer.appendChild(relayCard);
        }

        // Add event listeners for test buttons after rendering
        document.querySelectorAll('.test-button').forEach(button => {
            button.addEventListener('click', (event) => testRelay(event.target.dataset.relayId));
        });
    }

    async function loadSettings() {
        try {
            const response = await fetch('/api/dashboard/settings');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const settings = await response.json();
            alarmEnabledCheckbox.checked = settings.alarmEnabled;
            renderRelaySettings(settings);
        } catch (error) {
            console.error('Error loading settings:', error);
            showStatus('Failed to load settings.', true);
        }
    }

    async function saveSettings() {
        try {
            const updatedRelays = {};
            for (let i = 1; i <= 4; i++) {
                const onTimeInput = document.getElementById(`relay-${i}-on-time`);
                const delayTimeInput = document.getElementById(`relay-${i}-delay-time`);
                const pulseMsInput = document.getElementById(`relay-${i}-pulse-ms`);
                const enabledCheckbox = document.getElementById(`relay-${i}-enabled`); // New

                updatedRelays[i] = {
                    onTimeMs: parseInt(onTimeInput.value, 10),
                    delayMs: parseInt(delayTimeInput.value, 10),
                    pulseMs: parseInt(pulseMsInput.value, 10),
                    enabled: enabledCheckbox.checked // New
                };
            }

            const settings = {
                alarmEnabled: alarmEnabledCheckbox.checked,
                relays: updatedRelays
            };

            const response = await fetch('/api/dashboard/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
            }
            showStatus('Settings saved successfully!');
            await loadSettings(); // Reload to ensure sync and re-render
        } catch (error) {
            console.error('Error saving settings:', error);
            showStatus(`Failed to save settings: ${error.message}`, true);
        }
    }

    async function testRelay(relayId) {
        try {
            // Check if the individual relay is enabled before testing
            const enabledCheckbox = document.getElementById(`relay-${relayId}-enabled`);
            if (!enabledCheckbox.checked) {
                showStatus(`Relay ${relayId} is disabled and cannot be tested. Please enable it first.`, true);
                return;
            }

            const response = await fetch(`/api/dashboard/commands/test-relay/${relayId}`, { method: 'POST' });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
            }
            showStatus(`Test command sent for Relay ${relayId}!`);
        } catch (error) {
            console.error(`Error sending test relay ${relayId} command:`, error);
            showStatus(`Failed to send test command for Relay ${relayId}: ${error.message}`, true);
        }
    }

    async function deactivateAlarm() {
        try {
            const response = await fetch('/api/dashboard/commands/deactivate-alarm', { method: 'POST' });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
            }
            showStatus('Deactivate all active alarms command sent!');
        } catch (error) {
            console.error('Error sending deactivate command:', error);
            showStatus(`Failed to deactivate alarms: ${error.message}`, true);
        }
    }

    // Event Listeners
    saveButton.addEventListener('click', saveSettings);
    deactivateButton.addEventListener('click', deactivateAlarm);

    // Initial load
    loadSettings();
});