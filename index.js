/**
 * 🤖 AutoPost Telegram Bot (Backend Server + API)
 *
 * Flow:
 * 1. Runs an Express HTTP server (health check, status APIs, ASIN DB, Telegram Webhook/Polling).
 * 2. Connects to Telegram (Polling for local dev, Webhook in production).
 * 3. Listens for incoming product deal messages, parses deals, scrapes metadata, deduplicates, and posts to Telegram.
 * 4. Exposes REST APIs for the Firebase Hosting Dashboard.
 */

require('dotenv').config();
const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { parseMessage, checkAndAddProductKey } = require('./utils');
const { scrapeProductData, extractProductKey } = require('./scraper');

// Express App Initialization
const app = express();
app.use(express.json());

// Enable CORS for Firebase Hosting dashboard
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const PORT = process.env.PORT || 3000;

// ── In-Memory Logging System ───────────────────────────────────────────────────
const LOGS_MAX_SIZE = 100;
const logBuffer = [];
let logIdCounter = 0;

function addLog(type, message, metadata = null) {
  logIdCounter++;
  const logEntry = {
    id: `log_${Date.now()}_${logIdCounter}`,
    type, // 'info', 'success', 'warning', 'error'
    message,
    metadata,
    timestamp: new Date().toISOString()
  };
  logBuffer.push(logEntry);
  if (logBuffer.length > LOGS_MAX_SIZE) {
    logBuffer.shift();
  }

  // Console output
  const consoleMsg = `[${type.toUpperCase()}] ${message}`;
  if (type === 'error') {
    console.error(consoleMsg, metadata ? JSON.stringify(metadata) : '');
  } else {
    console.log(consoleMsg, metadata ? JSON.stringify(metadata) : '');
  }
}

// ── Metrics Tracking ──────────────────────────────────────────────────────────
const metrics = {
  totalProcessed: 0,
  successfulScrapes: 0,
  failedScrapes: 0
};

// ── Crash Guards ───────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  addLog('error', `Unhandled Rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  addLog('error', `Uncaught Exception: ${err.message}`, { stack: err.stack });
});

// ── Telegram Bot Configuration ─────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const isProduction = !!(process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL);
let bot;

if (!BOT_TOKEN) {
  addLog('error', 'BOT_TOKEN is missing in .env');
  process.exit(1);
}

addLog('info', 'Initializing Telegram bot...');
if (isProduction) {
  bot = new TelegramBot(BOT_TOKEN, { polling: false });
  const serverUrl = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
  const webhookUrl = `${serverUrl}/telegram-webhook`;

  async function syncWebhook(url, retries = 5, delay = 2500) {
    try {
      const info = await bot.getWebHookInfo();
      if (info.url === url) {
        addLog('success', `Webhook is active and synced at: ${url}`);
        return;
      }
      await bot.setWebHook(url);
      addLog('success', `Webhook registered successfully at: ${url}`);
    } catch (err) {
      if (retries > 0 && err.message.includes('429')) {
        addLog('warning', `Telegram rate limited (429). Retrying in ${delay / 1000}s...`);
        setTimeout(() => syncWebhook(url, retries - 1, delay * 2), delay);
      } else {
        addLog('error', `Webhook setup failed: ${err.message}`);
      }
    }
  }

  syncWebhook(webhookUrl);
} else {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  addLog('info', 'Bot started in Polling mode (Local dev)');

  bot.on('polling_error', (error) => {
    addLog('warning', `Telegram connection warning (polling failed): ${error.message}`);
  });
}

// ── Security Middleware ────────────────────────────────────────────────────────
const checkAuth = (req, res, next) => {
  const apiKey = process.env.DASHBOARD_API_KEY;
  if (!apiKey) {
    return next(); // Protection disabled if DASHBOARD_API_KEY is not defined
  }

  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey === apiKey) {
    return next();
  }

  addLog('warning', `Unauthorized API access blocked from IP: ${req.ip}`);
  res.status(401).json({ error: 'Unauthorized. Invalid or missing API key.' });
};

// ── Express Endpoints ──────────────────────────────────────────────────────────

// 0. Root Endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'AutoPost Telegram Bot API Server',
    status: 'online',
    uptime: Math.floor(process.uptime()),
    mode: isProduction ? 'webhook' : 'polling'
  });
});

// 0b. Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    mode: isProduction ? 'webhook' : 'polling'
  });
});

// 0c. Telegram Webhook Endpoint
app.post('/telegram-webhook', (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (err) {
    addLog('error', `Webhook process update error: ${err.message}`);
  }
  res.sendStatus(200);
});

// 1. Bot Health & Status API
app.get('/api/status', checkAuth, async (req, res) => {
  let webhookInfo = null;
  try {
    if (bot && typeof bot.getWebHookInfo === 'function') {
      webhookInfo = await bot.getWebHookInfo();
    }
  } catch (err) {
    webhookInfo = { error: err.message };
  }

  const envCheck = {
    BOT_TOKEN: !!process.env.BOT_TOKEN,
    PORT: !!process.env.PORT,
    DASHBOARD_API_KEY: !!process.env.DASHBOARD_API_KEY
  };

  const totalScrapes = metrics.successfulScrapes + metrics.failedScrapes;
  const successRate = totalScrapes > 0 ? Math.round((metrics.successfulScrapes / totalScrapes) * 100) : 100;

  res.json({
    status: 'online',
    mode: isProduction ? 'webhook' : 'polling',
    uptime: Math.floor(process.uptime()),
    webhook: webhookInfo,
    env: envCheck,
    metrics: {
      totalProcessed: metrics.totalProcessed,
      successfulScrapes: metrics.successfulScrapes,
      failedScrapes: metrics.failedScrapes,
      successRate
    }
  });
});

// 2. Logging List API
app.get('/api/logs', checkAuth, (req, res) => {
  res.json(logBuffer);
});

// 3. ASIN Database Read API
const DEDUPE_FILE = path.join(__dirname, 'crawled_asins.json');
app.get('/api/asins', checkAuth, (req, res) => {
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const content = fs.readFileSync(DEDUPE_FILE, 'utf8');
      const list = JSON.parse(content);
      return res.json(Array.isArray(list) ? list : []);
    }
    return res.json([]);
  } catch (err) {
    addLog('error', `Failed to read crawled_asins.json: ${err.message}`);
    res.status(500).json({ error: 'Failed to read ASIN database' });
  }
});

// 4. ASIN Database Delete Key API
app.delete('/api/asins/:key', checkAuth, (req, res) => {
  const keyToDelete = req.params.key;
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const content = fs.readFileSync(DEDUPE_FILE, 'utf8');
      let list = JSON.parse(content);
      if (Array.isArray(list)) {
        const index = list.indexOf(keyToDelete);
        if (index !== -1) {
          list.splice(index, 1);
          fs.writeFileSync(DEDUPE_FILE, JSON.stringify(list, null, 2), 'utf8');
          addLog('success', `Deleted product key "${keyToDelete}" from database`);
          return res.json({ success: true, message: `Key ${keyToDelete} deleted` });
        }
      }
      return res.status(404).json({ error: `Key ${keyToDelete} not found in database` });
    }
    return res.status(404).json({ error: 'Database file not found' });
  } catch (err) {
    addLog('error', `Failed to delete key "${keyToDelete}": ${err.message}`);
    res.status(500).json({ error: 'Failed to update database' });
  }
});

// 5. Parser Playground Sandbox API
app.post('/api/test-parse', checkAuth, async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Text field is required' });
  }

  addLog('info', 'Interactive playground processing text trial...');
  try {
    const products = parseMessage(text);
    if (!products || products.length === 0) {
      addLog('warning', 'Playground parsing yielded 0 products');
      return res.json({ products: [], message: 'No product links found.' });
    }

    const results = [];
    for (const product of products) {
      addLog('info', `Playground scraping link: ${product.link}`);
      const scraped = await scrapeWithTimeout(product.link);
      results.push({
        parsed: product,
        scraped: scraped
      });
    }

    addLog('success', `Playground completed. Parsed and scraped ${results.length} deal(s).`);
    res.json({ products: results });
  } catch (err) {
    addLog('error', `Playground processing error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Start Express Server
app.listen(PORT, () => {
  addLog('success', `Bot API Server running on port ${PORT}`);
});

// ── Telegram Command Helpers ───────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '👋 Welcome! Send me product deals and I will format and post them to Telegram.');
});

bot.onText(/\/test/, (msg) => {
  bot.sendMessage(msg.chat.id, `⚙️ Bot is operational.\nMode: ${isProduction ? 'Webhook' : 'Polling (Local)'}`);
});

// ── Scrape with Hard Timeout ───────────────────────────────────────────────────
const SCRAPE_TIMEOUT_MS = 22000;

async function scrapeWithTimeout(url) {
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => {
      addLog('warning', `Scraper timeout limit reached for URL: ${url}`);
      resolve({ title: 'Product', imageUrl: '', upc: 'Not Found' });
    }, SCRAPE_TIMEOUT_MS)
  );
  return Promise.race([scrapeProductData(url), timeoutPromise]);
}

// ── Format unit numbers with comma separators ──────────────────────────────────
function formatUnits(units) {
  if (!units || units === 'N/A') return units;
  const num = parseInt(units.toString().replace(/,/g, ''), 10);
  if (isNaN(num)) return units;
  return num.toLocaleString('en-US');
}

// ── Helper: Download image buffer to bypass Telegram CDN crawler blocks ────────
async function downloadImageBuffer(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.google.com/'
      }
    });
    if (response.status === 200 && response.data && response.data.byteLength > 1000) {
      return Buffer.from(response.data);
    }
  } catch (err) {
    addLog('warning', `Image buffer download warning for ${imageUrl.substring(0, 40)}...: ${err.message}`);
  }
  return null;
}

// ── Main Message Listener ──────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  try {
    // Skip bot messages
    if (msg.from && msg.from.is_bot) return;

    // Skip service/system messages
    if (!msg.text && !msg.caption) return;

    const rawText = msg.text || msg.caption || '';

    // Ignore slash commands and very short inputs
    if (rawText.trim().startsWith('/') || rawText.trim().length < 5) return;

    metrics.totalProcessed++;
    addLog('info', `Received telegram deal message from ${msg.from?.username || msg.from?.first_name || 'Anonymous'}`);

    // 1. Parse product links from message
    const products = parseMessage(rawText);
    if (!products || products.length === 0) {
      addLog('warning', 'No product links extracted from message');
      try {
        await bot.sendMessage(
          msg.chat.id,
          '⚠️ No product links found. Please include an Amazon, Walmart, or eBay URL.',
          { reply_to_message_id: msg.message_id }
        );
      } catch (tgErr) {
        addLog('error', `Failed to send link warning message: ${tgErr.message}`);
      }
      return;
    }

    addLog('info', `Extracted ${products.length} product link(s). Scraping metadata...`);

    // 2. Process each product link
    for (const product of products) {
      const productKey = extractProductKey(product.link);
      const isNew = checkAndAddProductKey(productKey);
      if (!isNew) {
        addLog('info', `[Dedupe] Skipping duplicate deal: ${productKey}`);
        continue;
      }

      const scraped = await scrapeWithTimeout(product.link);

      const isScrapeFailed = scraped.title === 'Product' || scraped.title === 'Product Title' || (scraped.upc === 'Not Found' && !scraped.imageUrl);
      if (isScrapeFailed) {
        metrics.failedScrapes++;
        addLog('warning', `Failed to scrape rich data (using fallbacks) for: ${product.link}`);
      } else {
        metrics.successfulScrapes++;
        addLog('success', `Scrape successful for "${scraped.title.substring(0, 40)}..."`);
      }

      const postLines = [];
      if (scraped.upc && scraped.upc !== 'Not Found')                     postLines.push(`UPC: ${scraped.upc}`);
      if (product.price && product.price !== 'N/A')                       postLines.push(`Price: ${product.price}`);
      if (product.units && product.units !== 'N/A')                       postLines.push(`Units: ${formatUnits(product.units)}`);
      if (product.fob && product.fob !== 'N/A' && product.fob !== 'null') postLines.push(`FOB: ${product.fob}`);
      if (product.exp && product.exp !== 'N/A' && product.exp !== 'null') postLines.push(`Exp: ${product.exp}`);
      postLines.push(`Link: ${product.link}`);
      const formattedTelegramPost = postLines.join('\n');

      const telegramOptions = { reply_to_message_id: msg.message_id };

      // 3. Send with image if available (using buffer upload to prevent crawler blocks)
      let photoSent = false;
      if (scraped.imageUrl) {
        try {
          const imgBuffer = await downloadImageBuffer(scraped.imageUrl);
          if (imgBuffer) {
            await bot.sendPhoto(msg.chat.id, imgBuffer, {
              caption: formattedTelegramPost,
              ...telegramOptions
            }, {
              filename: 'product.jpg',
              contentType: 'image/jpeg'
            });
            photoSent = true;
            addLog('success', 'Sent photo deal card (via buffer) to Telegram successfully');
          } else {
            await bot.sendPhoto(msg.chat.id, scraped.imageUrl, {
              caption: formattedTelegramPost,
              ...telegramOptions
            });
            photoSent = true;
            addLog('success', 'Sent photo deal card (via URL) to Telegram successfully');
          }
        } catch (photoErr) {
          addLog('warning', `Photo deal send failed (${photoErr.message}), falling back to text`);
        }
      }

      if (!photoSent) {
        try {
          await bot.sendMessage(msg.chat.id, formattedTelegramPost, telegramOptions);
          addLog('success', 'Sent text-only deal card to Telegram successfully');
        } catch (textErr) {
          addLog('error', `Text send failed: ${textErr.message}`);
        }
      }
    }

  } catch (err) {
    addLog('error', `Fatal message handler error: ${err.message}`, { stack: err.stack });
    try {
      await bot.sendMessage(
        msg.chat.id,
        `❌ Error: ${err.message}`,
        { reply_to_message_id: msg.message_id }
      );
    } catch (tgErr) {
      addLog('error', `Failed to send incident alert to Telegram: ${tgErr.message}`);
    }
  }
});

module.exports = app;
