// server.js
const express = require('express');
const abot= require("./bot");

var bot= new abot();
bot= bot.bot;
const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'Bot is running!',
        timestamp: new Date().toISOString()
    });
});

// Webhook endpoint
app.post('/webhook', async (req, res) => {
    try {
        if (!req.body || Object.keys(req.body).length === 0) {
            console.log('⚠️ Empty request body');
            return res.status(200).json({ status: 'ok' });
        }

        const update = req.body;
        console.log('📨 Webhook update received:', update.update_id);

        // Process the update
        await bot.processUpdate(update);
        console.log('✅ Update processed successfully');

        res.status(200).json({ status: 'ok' });
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        res.status(200).json({ status: 'error', error: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Bot server running on port ${PORT}`);
    console.log(`📡 Webhook endpoint: https://your-render-url.onrender.com/webhook`);
});
