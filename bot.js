// copycat-scanner-verified.js
// Same copycat/scam detection as copycatchecker.js, but alerts are gated
// on a live paid-status check instead of a locally-stored premium flag.
// No delay. Unpaid/unverifiable users receive no alert data.

const  TelegramBot  = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    WS_URL: process.env.WS_URL || 'wss://pumpportal.fun/api/data',
    DATA_PATH: path.join(__dirname, 'data'),
    SOL_PRICE_USD: 80,
    STATUS_CHECK_BASE_URL: 'https://curveradarhook.vercel.app/check',
    STATUS_CHECK_TIMEOUT_MS: 5000,
    STATUS_CACHE_TTL_MS: 5 * 60 * 1000, // re-check a user at most every 5 min

    COPYCAT_THRESHOLDS: {
        nameSimilarity: 0.7,
        popularTokenList: [
            'DOGE', 'SHIB', 'PEPE', 'FLOKI', 'BONK', 'WIF',
            'POPCAT', 'MOODENG', 'GOAT', 'DOG', 'CAT',
            'SOL', 'BTC', 'ETH', 'SUI', 'APT', 'ARB',
            'FROG', 'MOON', 'ROCKET', 'GEM',
            'MAGA', 'TRUMP', 'BIDEN', 'KAMALA',
            'AI', 'AGENT', 'ORACLE', 'SMART'
        ],
        commonScamPatterns: [
            'claim', 'reward', 'airdrop', 'bonus', 'giveaway',
            'test', 'demo', 'sample', 'copy', 'clone',
            'v2', 'v3', 'new', 'real', 'official', 'genuine'
        ],
        maxCopycatChecks: 100,
        minMarketCapForAlert: 10,
        maxMarketCapForAlert: 500
    }
};

// Fill in your own upgrade copy — left blank intentionally.
const MESSAGING = {
    UPGRADE_PROMPT: 'Upgrade with @YourPaymentBot to receive alerts instantly.'
};

// ============================================
// JSON DATABASE (tokens/users only — no premium flag needed)
// ============================================
class Database {
    constructor() {
        this.ensureDirectories();
        this.loadData();
        this.saveInterval = setInterval(() => this.save(), 30000);
    }

    ensureDirectories() {
        if (!fs.existsSync(CONFIG.DATA_PATH)) fs.mkdirSync(CONFIG.DATA_PATH, { recursive: true });
    }

    getDataFile(filename) { return path.join(CONFIG.DATA_PATH, filename); }

    loadData() {
        this.tokens = this.loadJSON('copycat-tokens-verified.json', {});
        this.copycatAlerts = this.loadJSON('copycat-alerts-verified.json', []);
        this.users = this.loadJSON('copycat-users-verified.json', {});
        this.settings = this.loadJSON('copycat-settings-verified.json', {
            totalScanned: 0, totalCopycats: 0, totalAlerts: 0, groups: []
        });
    }

    loadJSON(filename, defaultData) {
        const filePath = this.getDataFile(filename);
        try {
            if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            console.error(`Failed to load ${filename}:`, error.message);
        }
        return JSON.parse(JSON.stringify(defaultData));
    }

    save() {
        try {
            this.saveJSON('copycat-tokens-verified.json', this.tokens);
            this.saveJSON('copycat-alerts-verified.json', this.copycatAlerts);
            this.saveJSON('copycat-users-verified.json', this.users);
            this.saveJSON('copycat-settings-verified.json', this.settings);
        } catch (error) {
            console.error('Failed to save data:', error.message);
        }
    }

    saveJSON(filename, data) {
        try { fs.writeFileSync(this.getDataFile(filename), JSON.stringify(data, null, 2)); }
        catch (error) { console.error(`Failed to save ${filename}:`, error.message); }
    }

    saveToken(tokenData) {
        this.tokens[tokenData.mint] = { ...tokenData, savedAt: Date.now() };
        this.settings.totalScanned++;
        this.save();
        return this.tokens[tokenData.mint];
    }

    getToken(mint) { return this.tokens[mint] || null; }
    getRecentTokens(limit = 100) {
        return Object.values(this.tokens).sort((a, b) => b.savedAt - a.savedAt).slice(0, limit);
    }

    saveCopycatAlert(alertData) {
        const alert = { id: this.copycatAlerts.length + 1, ...alertData, timestamp: Date.now() };
        this.copycatAlerts.push(alert);
        this.settings.totalCopycats++;
        this.save();
        return alert;
    }

    getCopycatAlerts(limit = 10) { return this.copycatAlerts.slice(-limit).reverse(); }
    getCopycatAlert(mint) { return this.copycatAlerts.find(a => a.mint === mint) || null; }

    getUser(userId) { return this.users[userId] || null; }
    createUser(userId, username) {
        if (!this.users[userId]) {
            this.users[userId] = { userId, username: username || null, joinedAt: Date.now(), lastActive: Date.now() };
            this.save();
        }
        return this.users[userId];
    }
    updateUserActivity(userId) {
        if (this.users[userId]) { this.users[userId].lastActive = Date.now(); this.save(); }
    }
    getAllUserIds() { return Object.keys(this.users).map(id => parseInt(id)); }

    cleanup() {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const oldTokens = Object.keys(this.tokens).filter(k => this.tokens[k].savedAt < sevenDaysAgo);
        if (oldTokens.length > 0) { oldTokens.forEach(k => delete this.tokens[k]); this.save(); }
    }
}

// ============================================
// LOGGER
// ============================================
class Logger {
    log(message, level = 'INFO') { console.log(`[${new Date().toISOString()}] [${level}] ${message}`); }
    info(m) { this.log(m, 'INFO'); }
    error(m) { this.log(m, 'ERROR'); }
    warn(m) { this.log(m, 'WARN'); }
}
const logger = new Logger();

// ============================================
// PAID-STATUS CHECK
// ============================================
class PaidStatusChecker {
    constructor() { this.cache = new Map(); }

    async isPaid(userId) {
        const cached = this.cache.get(userId);
        if (cached && (Date.now() - cached.checkedAt) < CONFIG.STATUS_CACHE_TTL_MS) return cached.paid;

        const paid = await this._fetchStatus(userId);
        this.cache.set(userId, { paid, checkedAt: Date.now() });
        return paid;
    }

    async _fetchStatus(userId) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.STATUS_CHECK_TIMEOUT_MS);
        try {
            const res = await fetch(`${CONFIG.STATUS_CHECK_BASE_URL}/${userId}`, { signal: controller.signal });
            if (!res.ok) { logger.error(`Status check HTTP ${res.status} for user ${userId}`); return false; }
            const json = await res.json();
            return json && json.paid === true;
        } catch (error) {
            logger.error(`Status check failed for user ${userId}: ${error.message}`);
            return false; // fail closed
        } finally {
            clearTimeout(timeout);
        }
    }
}

// ============================================
// COPYCAT SCANNER (identical logic to original)
// ============================================
class CopycatScanner {
    constructor() {
        this.popularTokens = CONFIG.COPYCAT_THRESHOLDS.popularTokenList.map(t => t.toUpperCase());
        this.scamPatterns = CONFIG.COPYCAT_THRESHOLDS.commonScamPatterns;
        this.similarityThreshold = CONFIG.COPYCAT_THRESHOLDS.nameSimilarity;
        this.recentTokens = [];
    }

    scanToken(data) {
        if (data.txType !== 'create') return null;

        const symbol = (data.symbol || '').toUpperCase();
        const name = (data.name || '').toLowerCase();
        const mint = data.mint;
        const marketCapSol = data.marketCapSol || 27.958;

        if (marketCapSol < CONFIG.COPYCAT_THRESHOLDS.minMarketCapForAlert) return null;
        if (marketCapSol > CONFIG.COPYCAT_THRESHOLDS.maxMarketCapForAlert) return null;

        const copycatMatches = [];
        const scamIndicators = [];

        for (const popular of this.popularTokens) {
            if (symbol === popular) {
                copycatMatches.push({ type: 'symbol', original: popular, description: `Exact symbol match: ${popular}` });
            }
            const nameLower = name.toLowerCase();
            const popularLower = popular.toLowerCase();
            if (nameLower.includes(popularLower) || popularLower.includes(nameLower)) {
                const similarity = this.calculateSimilarity(nameLower, popularLower);
                if (similarity >= this.similarityThreshold) {
                    copycatMatches.push({ type: 'name', original: popular, description: `Name similar to ${popular} (${Math.round(similarity * 100)}%)` });
                }
            }
            const variationPatterns = ['v2', 'v3', '2', '3', 'new', 'real', 'official', 'genuine'];
            for (const pattern of variationPatterns) {
                if (symbol.includes(popular + pattern) || symbol.includes(pattern + popular)) {
                    copycatMatches.push({ type: 'variation', original: popular, description: `Variation of ${popular}: ${symbol}` });
                }
            }
        }

        for (const recent of this.recentTokens) {
            if (recent.mint === mint) continue;
            if (symbol === (recent.symbol || '').toUpperCase()) {
                copycatMatches.push({ type: 'duplicate_symbol', original: recent.symbol, description: `Duplicate symbol: ${recent.symbol} (recent token)` });
            }
            if (name && recent.name && name === recent.name.toLowerCase()) {
                copycatMatches.push({ type: 'duplicate_name', original: recent.name, description: `Duplicate name: ${recent.name} (recent token)` });
            }
        }

        for (const pattern of this.scamPatterns) {
            if (name.includes(pattern) || symbol.toLowerCase().includes(pattern)) {
                scamIndicators.push({ pattern, description: `Contains scam pattern: "${pattern}"` });
            }
        }

        const numericSuffixMatch = symbol.match(/^([A-Z]+)(\d+)$/);
        if (numericSuffixMatch) {
            const baseSymbol = numericSuffixMatch[1];
            const number = parseInt(numericSuffixMatch[2]);
            if (number > 1 && this.popularTokens.includes(baseSymbol)) {
                copycatMatches.push({ type: 'numeric_suffix', original: baseSymbol, description: `Numeric suffix: ${baseSymbol}${number}` });
            }
        }

        for (const pattern of ['official', 'genuine', 'real', 'authentic']) {
            if (name.includes(pattern) || symbol.toLowerCase().includes(pattern)) {
                scamIndicators.push({ pattern, description: `Claims to be "${pattern}" - likely scam` });
            }
        }

        const isCopycat = copycatMatches.length > 0;
        const hasScamIndicators = scamIndicators.length > 0;

        let severity = 'info', emoji = 'ℹ️';
        if (isCopycat && hasScamIndicators) { severity = 'critical'; emoji = '🔴'; }
        else if (isCopycat && copycatMatches.some(m => m.type === 'symbol' || m.type === 'duplicate_symbol')) { severity = 'high'; emoji = '🟠'; }
        else if (isCopycat) { severity = 'medium'; emoji = '🟡'; }
        else if (hasScamIndicators) { severity = 'warning'; emoji = '⚠️'; }

        this.recentTokens.push({ mint, symbol: data.symbol || 'UNKNOWN', name: data.name || 'Unknown', timestamp: Date.now() });
        if (this.recentTokens.length > CONFIG.COPYCAT_THRESHOLDS.maxCopycatChecks) {
            this.recentTokens = this.recentTokens.slice(-CONFIG.COPYCAT_THRESHOLDS.maxCopycatChecks);
        }

        return {
            mint, symbol: data.symbol || 'UNKNOWN', name: data.name || 'Unknown',
            creator: data.traderPublicKey, marketCapSol,
            isCopycat, hasScamIndicators, severity, emoji,
            copycatMatches, scamIndicators,
            isMayhemMode: data.isMayhemMode || false,
            isCashbackEnabled: data.isCashbackEnabled || false,
            initialBuySol: data.initialBuy / 1e6,
            timestamp: Date.now()
        };
    }

    calculateSimilarity(str1, str2) {
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        if (longer.length === 0) return 1.0;
        const distance = this.levenshteinDistance(longer, shorter);
        return (longer.length - distance) / longer.length;
    }

    levenshteinDistance(str1, str2) {
        const matrix = [];
        for (let i = 0; i <= str2.length; i++) matrix[i] = [i];
        for (let j = 0; j <= str1.length; j++) matrix[0][j] = j;
        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                matrix[i][j] = str2[i - 1] === str1[j - 1]
                    ? matrix[i - 1][j - 1]
                    : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
            }
        }
        return matrix[str2.length][str1.length];
    }
}

// ============================================
// ALERT FORMATTER — "cool" verified-premium styling
// ============================================
class AlertFormatter {
    static formatVerifiedAlert(scanResult) {
        const solPrice = CONFIG.SOL_PRICE_USD;
        const marketCapUsd = (scanResult.marketCapSol * solPrice).toFixed(0);
        const initialBuyUsd = (scanResult.initialBuySol * solPrice).toFixed(0);

        let msg = `╭──────────────────────╮\n`;
        msg += `  ${scanResult.emoji} *VERIFIED COPYCAT SCAN* ${scanResult.emoji}\n`;
        msg += `╰──────────────────────╯\n\n`;
        msg += `📊 *${scanResult.name}* — $${scanResult.symbol}\n`;
        msg += `🔗 \`${scanResult.mint}\`\n\n`;

        msg += `🧭 *Risk Level:* ${scanResult.severity.toUpperCase()}\n`;
        msg += `${scanResult.isCopycat ? '🎯' : '✅'} Copycat: ${scanResult.isCopycat ? 'YES' : 'NO'}\n`;
        msg += `${scanResult.hasScamIndicators ? '🚨' : '✅'} Scam Indicators: ${scanResult.hasScamIndicators ? 'YES' : 'NO'}\n\n`;

        msg += `💰 *Market Data*\n`;
        msg += `   Market Cap: ${scanResult.marketCapSol.toFixed(1)} SOL ($${marketCapUsd})\n`;
        msg += `   Initial Buy: ${scanResult.initialBuySol.toFixed(2)} SOL ($${initialBuyUsd})\n\n`;

        if (scanResult.copycatMatches.length > 0) {
            msg += `🔍 *Matches:*\n`;
            const seen = new Set();
            const uniqueMatches = scanResult.copycatMatches.filter(m => !seen.has(m.original) && seen.add(m.original));
            uniqueMatches.slice(0, 5).forEach(m => { msg += `   • ${m.description}\n`; });
            msg += `\n`;
        }

        if (scanResult.scamIndicators.length > 0) {
            msg += `🚨 *Scam Indicators:*\n`;
            scanResult.scamIndicators.slice(0, 5).forEach(i => { msg += `   • ${i.description}\n`; });
            msg += `\n`;
        }

        const recs = {
            critical: '⛔ *DO NOT BUY* — high-risk copycat with scam indicators.',
            high: '⚠️ *AVOID* — clear copycat with exact symbol match.',
            medium: '💡 *CAUTION* — appears to be a copycat, verify legitimacy.',
            warning: '💡 *INVESTIGATE* — scam indicators detected.',
            info: '✅ *CLEAR* — no copycat or scam indicators detected.'
        };
        msg += `${recs[scanResult.severity]}\n`;
        msg += `\n🔗 https://pump.fun/${scanResult.mint}`;
        msg += `\n\n⚡ _Verified premium — zero delay._`;

        return msg;
    }

    static formatCopycatSummary(alerts) {
        if (alerts.length === 0) return '📭 No copycats detected yet.';
        let message = '📊 *Copycat Detection Summary*\n\n';
        alerts.forEach((alert, i) => {
            const emoji = alert.severity === 'critical' ? '🔴' : alert.severity === 'high' ? '🟠' : alert.severity === 'medium' ? '🟡' : '⚠️';
            message += `${i + 1}. ${emoji} *${alert.symbol}* - ${alert.severity.toUpperCase()}\n`;
            message += `   ${new Date(alert.timestamp).toLocaleString()}\n\n`;
        });
        return message;
    }
}

// ============================================
// TELEGRAM BOT
// ============================================
class VerifiedCopycatScannerBot {
    constructor() {
        this.db = new Database();
        this.scanner = new CopycatScanner();
        this.statusChecker = new PaidStatusChecker();
        this.bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true, allowed_updates: ['message', 'my_chat_member'] });
        this.ws = null;
        this.isShuttingDown = false;
        this.processedTokens = new Set();

        this.initBotCommands();
        this.initWebSocket();
        this.startCleanup();
        logger.info('🔍 Verified Copycat Scanner Bot initialized');
    }

    initWebSocket() { this.connectWebSocket(); }

    connectWebSocket() {
        if (this.ws) this.ws.terminate();
        this.ws = new WebSocket(CONFIG.WS_URL);

        this.ws.on('open', () => {
            logger.info('✅ WebSocket connected');
            this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
        });

        this.ws.on('message', async (data) => {
            try {
                const parsed = JSON.parse(data.toString());
                if (parsed.txType !== 'create') return;
                if (this.processedTokens.has(parsed.mint)) return;
                this.processedTokens.add(parsed.mint);

                const scanResult = this.scanner.scanToken(parsed);
                if (!scanResult) return;

                this.db.saveToken(scanResult);

                if (scanResult.isCopycat || scanResult.hasScamIndicators) {
                    await this.dispatchAlert(scanResult);
                }

                logger.info(`🔍 Scanned: ${scanResult.symbol} - Copycat: ${scanResult.isCopycat} - Severity: ${scanResult.severity}`);
            } catch (error) {
                logger.error(`WebSocket error: ${error.message}`);
            }
        });

        this.ws.on('error', (error) => logger.error(`WebSocket error: ${error.message}`));
        this.ws.on('close', () => {
            if (!this.isShuttingDown) {
                logger.warn('WebSocket closed, reconnecting...');
                setTimeout(() => this.connectWebSocket(), 5000);
            }
        });
    }

    // Checks paid status per user at dispatch time; only confirmed-paid
    // users get the alert. No fallback message to unpaid users here —
    // that keeps this feed strictly instant + verified, per spec.
    async dispatchAlert(scanResult) {
        this.db.saveCopycatAlert(scanResult);
        const message = AlertFormatter.formatVerifiedAlert(scanResult);
        const allUserIds = this.db.getAllUserIds();
        allUserIds.push(["-1004354223210","-1003930000284"]); // Add your group ID here if you want to send alerts to a group  

        let sentCount = 0;
        for (const userId of allUserIds) {
            try {
                const paid = await this.statusChecker.isPaid(userId);
                if (!paid) continue;
                await this.bot.sendMessage(userId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
                sentCount++;
            } catch (error) {
                logger.error(`Failed to send to ${userId}: ${error.message}`);
            }
        }
        this.settings_totalAlerts = (this.settings_totalAlerts || 0) + 1;
        logger.info(`✅ Verified alert sent: ${scanResult.symbol} to ${sentCount} paid users`);
    }

    startCleanup() { setInterval(() => this.db.cleanup(), 60 * 60 * 1000); }

    initBotCommands() {
        this.bot.onText(/\/start/, async (msg) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            this.db.createUser(userId, msg.from.username);
            this.db.updateUserActivity(userId);

            const paid = await this.statusChecker.isPaid(userId);
            this.bot.sendMessage(chatId, `
🔍 *Verified Copycat Scanner*

I detect tokens that copy popular coins or show scam patterns, with zero-delay alerts for verified users.

⚡ *Your Status:* ${paid ? '✅ VERIFIED' : '🔒 NOT VERIFIED'}

📋 *Commands:*
/start - Welcome
/status - Check verification status
/check [mint] - Check token for copycat
/recent - Recent copycat detections
/stats - Bot statistics
/help - Help menu
${paid ? '' : `\n${MESSAGING.UPGRADE_PROMPT}`}
            `, { parse_mode: 'Markdown' });
        });

        this.bot.onText(/\/status/, async (msg) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            const paid = await this.statusChecker.isPaid(userId);
            this.bot.sendMessage(chatId, paid ? '✅ Verified — instant alerts active.' : `🔒 Not verified.\n${MESSAGING.UPGRADE_PROMPT}`);
        });

        this.bot.onText(/\/check (.+)/, (msg, match) => {
            const chatId = msg.chat.id;
            const mint = match[1].trim();
            const token = this.db.getToken(mint);

            if (!token) {
                this.bot.sendMessage(chatId, '❌ Token not found. It may not have been scanned yet.');
                return;
            }

            const alert = this.db.getCopycatAlert(mint);
            if (alert) {
                this.bot.sendMessage(chatId, AlertFormatter.formatVerifiedAlert(alert), { parse_mode: 'Markdown', disable_web_page_preview: true });
            } else {
                this.bot.sendMessage(chatId, `✅ No copycat activity detected.\n\n📊 *${token.symbol}* (${token.name})\n• Market Cap: ${token.marketCapSol.toFixed(1)} SOL`, { parse_mode: 'Markdown' });
            }
        });

        this.bot.onText(/\/recent/, (msg) => {
            const alerts = this.db.getCopycatAlerts(10);
            this.bot.sendMessage(msg.chat.id, AlertFormatter.formatCopycatSummary(alerts), { parse_mode: 'Markdown' });
        });

        this.bot.onText(/\/stats/, (msg) => {
            const totalUsers = Object.keys(this.db.users).length;
            const totalScanned = this.db.settings.totalScanned || 0;
            const totalCopycats = this.db.settings.totalCopycats || 0;
            this.bot.sendMessage(msg.chat.id, `
📊 *Verified Copycat Scanner Stats*

👥 Users: ${totalUsers}
🔍 Tokens Scanned: ${totalScanned}
🎯 Copycats Found: ${totalCopycats}

🕒 Monitoring in real-time, verified instant delivery!
            `, { parse_mode: 'Markdown' });
        });

        this.bot.onText(/\/help/, (msg) => {
            this.bot.sendMessage(msg.chat.id, `
🔧 *Commands*
/start - Welcome
/status - Verification status
/check [mint] - Check a token
/recent - Recent detections
/stats - Bot stats
/help - This menu

💡 Alerts are sent instantly to verified users only — no delay, no queueing.
            `, { parse_mode: 'Markdown' });
        });

        this.bot.on('message', (msg) => {
            if (msg.from && msg.from.id) this.db.updateUserActivity(msg.from.id);
        });

        this.bot.on('polling_error', (error) => logger.error(`Polling error: ${error.message}`));
    }

    async shutdown() {
        this.isShuttingDown = true;
        if (this.ws) this.ws.terminate();
        clearInterval(this.db.saveInterval);
        this.bot.stopPolling();
        process.exit(0);
    }
}

// ============================================
// START
// ============================================
//process.on('SIGINT', () => global.verifiedCopycatBot && global.verifiedCopycatBot.shutdown());
//process.on('SIGTERM', () => global.verifiedCopycatBot && global.verifiedCopycatBot.shutdown());

module.exports = VerifiedCopycatScannerBot;
//global.verifiedCopycatBot = bot;
logger.info('✅ Verified Copycat Scanner Bot is running!');
