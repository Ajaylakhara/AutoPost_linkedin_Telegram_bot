/**
 * 🤖 AutoPost Telegram Bot (Unified Serverless Backend + APIs)
 *
 * Runs as:
 * - Firebase HTTPS Cloud Function (Production)
 * - Express HTTP Server (Local Dev via `npm start`)
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { parseMessage } = require('./utils');
const { scrapeProductData, extractProductKey } = require('./scraper');
const db = require('./db');

// Express App Initialization
const app = express();
app.use(express.json());

// Enable CORS
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

// Environment & Deployment Detection
const isCloudFunction = !!(process.env.FUNCTION_TARGET || process.env.K_SERVICE || process.env.FIREBASE_CONFIG);
const isProduction = isCloudFunction || !!process.env.WEBHOOK_URL;

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
let bot;

if (!BOT_TOKEN) {
  addLog('error', 'BOT_TOKEN is missing in environment variables');
}

if (BOT_TOKEN) {
  if (isProduction) {
    bot = new TelegramBot(BOT_TOKEN, { polling: false });
    addLog('info', 'Telegram bot initialized in Webhook mode (Firebase Live)');
  } else {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    addLog('info', 'Telegram bot started in Polling mode (Local dev)');

    bot.on('polling_error', (error) => {
      addLog('warning', `Telegram connection warning (polling): ${error.message}`);
    });
  }
}

// ── Security Middleware ────────────────────────────────────────────────────────
const checkAuth = (req, res, next) => {
  const apiKey = process.env.DASHBOARD_API_KEY;
  if (!apiKey) {
    return next();
  }

  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey === apiKey) {
    return next();
  }

  addLog('warning', `Unauthorized API access blocked from IP: ${req.ip}`);
  res.status(401).json({ error: 'Unauthorized. Invalid or missing API key.' });
};

// ── Endpoints ──────────────────────────────────────────────────────────────────

// 0b. Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    mode: isProduction ? 'webhook (firebase)' : 'polling (local)',
    db: db.getDbStatus()
  });
});

// 0c. Telegram Webhook Endpoint
app.post('/telegram-webhook', (req, res) => {
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (webhookSecret) {
    const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (receivedSecret !== webhookSecret) {
      addLog('warning', `Rejected webhook update: invalid secret token header from ${req.ip}`);
      return res.status(403).send('Forbidden');
    }
  }

  if (!bot) {
    addLog('error', 'Webhook received but Telegram bot is not initialized');
    return res.status(500).send('Bot not initialized');
  }

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
    DASHBOARD_API_KEY: !!process.env.DASHBOARD_API_KEY,
    TELEGRAM_WEBHOOK_SECRET: !!process.env.TELEGRAM_WEBHOOK_SECRET
  };

  const totalScrapes = metrics.successfulScrapes + metrics.failedScrapes;
  const successRate = totalScrapes > 0 ? Math.round((metrics.successfulScrapes / totalScrapes) * 100) : 100;

  res.json({
    status: 'online',
    mode: isProduction ? 'webhook (firebase)' : 'polling (local)',
    uptime: Math.floor(process.uptime()),
    webhook: webhookInfo,
    db: db.getDbStatus(),
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
app.get('/api/asins', checkAuth, async (req, res) => {
  try {
    const list = await db.getAllKeys();
    res.json(list);
  } catch (err) {
    addLog('error', `Failed to read ASIN database: ${err.message}`);
    res.status(500).json({ error: 'Failed to read ASIN database' });
  }
});

// 4. ASIN Database Delete Key API
app.delete('/api/asins/:key', checkAuth, async (req, res) => {
  const keyToDelete = req.params.key;
  try {
    const deleted = await db.deleteKey(keyToDelete);
    if (deleted) {
      addLog('success', `Deleted product key "${keyToDelete}" from database`);
      return res.json({ success: true, message: `Key ${keyToDelete} deleted` });
    } else {
      return res.status(404).json({ error: `Key ${keyToDelete} not found in database` });
    }
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

// ── Telegram Command Helpers ───────────────────────────────────────────────────
if (bot) {
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '👋 Welcome! Send me product deals and I will format and post them to Telegram.');
  });

  bot.onText(/\/test/, (msg) => {
    bot.sendMessage(msg.chat.id, `⚙️ Bot is operational.\nMode: ${isProduction ? 'Webhook (Firebase)' : 'Polling (Local)'}`);
  });
}

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
if (bot) {
  bot.on('message', async (msg) => {
    try {
      if (msg.from && msg.from.is_bot) return;
      if (!msg.text && !msg.caption) return;

      const rawText = msg.text || msg.caption || '';
      if (rawText.trim().startsWith('/') || rawText.trim().length < 5) return;

      metrics.totalProcessed++;
      addLog('info', `Received telegram deal message from ${msg.from?.username || msg.from?.first_name || 'Anonymous'}`);

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

      addLog('info', `Extracted ${products.length} product link(s). Processing...`);

      for (const product of products) {
        const productKey = extractProductKey(product.link);

        // Atomic Deduplication Check via Firestore / Local fallback
        const isNew = await db.checkAndAddProductKey(productKey, {
          asin: productKey,
          price: product.price,
          units: product.units
        });

        if (!isNew) {
          addLog('info', `[Dedupe] Skipping already processed deal: ${productKey}`);
          continue;
        }

        const scraped = await scrapeWithTimeout(product.link);

        const isScrapeFailed = scraped.title === 'Product' || scraped.title === 'Product Title' || (scraped.upc === 'Not Found' && !scraped.imageUrl);
        if (isScrapeFailed) {
          metrics.failedScrapes++;
          addLog('warning', `Failed to scrape rich data for: ${product.link}`);
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
}

// ── Execution: Local Server vs Firebase HTTPS Cloud Function ──────────────────
if (require.main === module && !isCloudFunction) {
  app.listen(PORT, () => {
    addLog('success', `Dashboard Web Server running locally on port ${PORT}`);
  });
}

// Export Firebase Cloud Function (v2 HTTPS)
let botFunction;
try {
  const { onRequest } = require('firebase-functions/v2/https');
  botFunction = onRequest(
    {
      timeoutSeconds: 60,
      memory: '512MiB',
      region: 'us-central1'
    },
    app
  );
} catch (e) {
  botFunction = app;
}

module.exports = { app, bot: botFunction };
