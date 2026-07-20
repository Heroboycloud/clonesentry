// set-webhook.js
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config()
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
}

const bot = new TelegramBot(token);

// Replace with your Render URL after deployment
const WEBHOOK_URL = 'https://clonesentry.onrender.com/webhook';

async function setupWebhook() {
    try {
        console.log('🔧 Setting webhook...');
        
        // Delete existing webhook
        await bot.deleteWebHook();
        console.log('✅ Webhook deleted');
        
        // Set new webhook
        const result = await bot.setWebHook(WEBHOOK_URL, {
            allowed_updates: ['message'],
            max_connections: 100
        });
        
        console.log('✅ Webhook set:', result);
        console.log('📡 URL:', WEBHOOK_URL);
        
        // Verify
        const info = await bot.getWebHookInfo();
        console.log('📊 Webhook info:', info.url);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

setupWebhook();
