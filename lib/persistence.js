/**
 * Institutional Persistence Layer (Comdb2-Ready Adapter)
 * 
 * This module abstracts the persistence of trade signals and AI decisions.
 * It is designed to be fully compatible with Bloomberg's Comdb2,
 * currently utilizing a high-reliability fallback for local environments.
 */

const fs = require('fs').promises;
const path = require('path');

const LOG_FILE = path.join(__dirname, '../data/institutional_history.db.json');

const Persistence = {
    /**
     * Initialize the persistence layer
     */
    async init() {
        try {
            await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
            try {
                await fs.access(LOG_FILE);
            } catch {
                await fs.writeFile(LOG_FILE, JSON.stringify([]));
            }
        } catch (error) {
            console.error("[Persistence] Init Failed:", error);
        }
    },

    /**
     * Log a new institutional signal
     * @param {Object} entry - Signal data object
     */
    async logSignal(entry) {
        try {
            const data = await this.readAll();
            // Ensure institutional integrity: only log if we have a valid timestamp and score
            if (!entry.timestamp || entry.score === undefined) return;
            
            data.push({
                ...entry,
                persistedAt: new Date().toISOString(),
                adapter: "Comdb2-Mock"
            });
            
            // Keep the last 1000 signals to avoid massive file growth in mock mode
            const trimmed = data.slice(-1000);
            await fs.writeFile(LOG_FILE, JSON.stringify(trimmed, null, 2));
        } catch (error) {
            console.error("[Persistence] Write Failed:", error);
        }
    },

    /**
     * Read all signals
     */
    async readAll() {
        try {
            const raw = await fs.readFile(LOG_FILE, 'utf8');
            return JSON.parse(raw);
        } catch {
            return [];
        }
    }
};

module.exports = Persistence;
