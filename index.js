/**
 * 🤖 AutoPost Telegram Bot (Main Orchestrator with Status Dashboard)
 *
 * Flow:
 * 1. Runs an Express HTTP server (health check + Telegram webhooks + Web Dashboard APIs).
 * 2. Connects to Telegram using webhook (in production) or polling (local dev).
 * 3. Listens for incoming product deal messages.
 * 4. Parses deals using utils.js.
 * 5. Scrapes product details (title, image, UPC) using scraper.js with timeout.
 * 6. Formats deal messages.
 * 7. Automatically posts to Telegram — ALWAYS responds, even on scrape failure.
 * 8. Exposes APIs to monitor bot health, webhook config, recent logs, ASIN database, and sandbox testing.
 */

require('dotenv').config();
const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const { parseMessage } = require('./utils');
const { scrapeProductData } = require('./scraper');

// Express App Initialization
const app = express();
app.use(express.json());
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

  // Also output to console
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
const isProduction = !!process.env.RENDER_EXTERNAL_URL;
let bot;

if (!BOT_TOKEN) {
  addLog('error', 'BOT_TOKEN is missing in .env');
  process.exit(1);
}

addLog('info', 'Initializing Telegram bot...');
if (isProduction) {
  bot = new TelegramBot(BOT_TOKEN, { polling: false });
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/telegram-webhook`;
  bot.setWebHook(webhookUrl)
    .then(() => addLog('success', `Webhook registered successfully at: ${webhookUrl}`))
    .catch(err => addLog('error', `Webhook setup failed: ${err.message}`));
} else {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  addLog('info', 'Bot started in Polling mode (Local dev)');

  // Gracefully handle polling connection errors (e.g. network timeouts, blocked ISP connections)
  bot.on('polling_error', (error) => {
    addLog('warning', `Telegram connection warning (polling failed): ${error.message}`);
  });
}

// ── Security Middleware ────────────────────────────────────────────────────────
const checkAuth = (req, res, next) => {
  const apiKey = process.env.DASHBOARD_API_KEY;
  if (!apiKey) {
    return next(); // Passcode protection disabled if DASHBOARD_API_KEY is not defined
  }

  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey === apiKey) {
    return next();
  }

  addLog('warning', `Unauthorized API access blocked from IP: ${req.ip}`);
  res.status(401).json({ error: 'Unauthorized. Invalid or missing API key.' });
};



// ── Express Endpoints ──────────────────────────────────────────────────────────

// 0. Root Dashboard — fixes "Cannot GET /" shown in browser
app.get('/', (req, res) => {
  const uptime = Math.floor(process.uptime());
  const hours  = Math.floor(uptime / 3600);
  const mins   = Math.floor((uptime % 3600) / 60);
  const secs   = uptime % 60;
  const uptimeStr = `${hours}h ${mins}m ${secs}s`;
  const mode = isProduction ? '🌐 Webhook (Render)' : '💻 Polling (Local Dev)';
  const recentLogs = logBuffer.slice(-8).reverse();

  const logRows = recentLogs.map(l => {
    const color = l.type === 'error' ? '#ff6b6b' : l.type === 'warning' ? '#ffd93d' : l.type === 'success' ? '#6bcb77' : '#adb5bd';
    const time  = new Date(l.timestamp).toLocaleTimeString();
    return `<tr><td style="color:${color};padding:4px 8px;white-space:nowrap">${l.type.toUpperCase()}</td><td style="padding:4px 8px;color:#ccc;white-space:nowrap">${time}</td><td style="padding:4px 12px;color:#e0e0e0">${l.message}</td></tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>AutoPost Bot — Status</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f0f14;color:#e0e0e0;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:40px 16px}
    h1{font-size:2rem;font-weight:700;color:#fff;margin-bottom:4px}
    .sub{color:#888;font-size:.9rem;margin-bottom:32px}
    .cards{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;margin-bottom:32px}
    .card{background:#1a1a24;border:1px solid #2a2a3a;border-radius:12px;padding:20px 28px;min-width:160px;text-align:center}
    .card .val{font-size:1.8rem;font-weight:700;color:#6bcb77}
    .card .val.warn{color:#ffd93d}
    .card .val.info{color:#74b9ff}
    .card .lbl{font-size:.78rem;color:#888;margin-top:4px;text-transform:uppercase;letter-spacing:.05em}
    .badge{display:inline-block;background:#6bcb7722;color:#6bcb77;border:1px solid #6bcb7755;border-radius:20px;padding:4px 14px;font-size:.85rem;font-weight:600;margin-bottom:24px}
    table{border-collapse:collapse;width:100%;max-width:760px;background:#1a1a24;border:1px solid #2a2a3a;border-radius:12px;overflow:hidden}
    th{background:#22223a;padding:8px 12px;text-align:left;font-size:.75rem;color:#888;text-transform:uppercase;letter-spacing:.06em}
    td{border-top:1px solid #2a2a3a;font-size:.83rem}
    h2{color:#aaa;font-size:1rem;margin-bottom:12px;text-transform:uppercase;letter-spacing:.08em}
  </style>
</head>
<body>
  <h1>🤖 AutoPost Bot</h1>
  <p class="sub">Telegram Deal Formatter — Closeout Products</p>
  <span class="badge">● ONLINE</span>
  <div class="cards">
    <div class="card"><div class="val info">${uptimeStr}</div><div class="lbl">Uptime</div></div>
    <div class="card"><div class="val">${metrics.totalProcessed}</div><div class="lbl">Messages Processed</div></div>
    <div class="card"><div class="val">${metrics.successfulScrapes}</div><div class="lbl">Successful Scrapes</div></div>
    <div class="card"><div class="val warn">${metrics.failedScrapes}</div><div class="lbl">Failed Scrapes</div></div>
  </div>
  <p style="color:#666;font-size:.8rem;margin-bottom:20px">Mode: ${mode} &nbsp;|&nbsp; Auto-refreshes every 30s</p>
  <h2>Recent Activity</h2>
  <table>
    <thead><tr><th>Type</th><th>Time</th><th>Message</th></tr></thead>
    <tbody>${logRows || '<tr><td colspan="3" style="text-align:center;padding:16px;color:#555">No logs yet</td></tr>'}</tbody>
  </table>
</body>
</html>`);
});

// 0b. Health check endpoint (used by keep-alive ping)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), mode: isProduction ? 'webhook' : 'polling' });
});

app.post('/telegram-webhook', (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (err) {
    addLog('error', `Webhook process update error: ${err.message}`);
  }
  res.sendStatus(200);
});

// 1. Bot Health & Status
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
    RENDER_EXTERNAL_URL: !!process.env.RENDER_EXTERNAL_URL,
    DASHBOARD_API_KEY: !!process.env.DASHBOARD_API_KEY
  };

  const totalScrapes = metrics.successfulScrapes + metrics.failedScrapes;
  const successRate = totalScrapes > 0 ? Math.round((metrics.successfulScrapes / totalScrapes) * 100) : 100;

  res.json({
    status: isProduction && (!webhookInfo || webhookInfo.error || !webhookInfo.url) ? 'error' : 'online',
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

// 2. Logging List
app.get('/api/logs', checkAuth, (req, res) => {
  res.json(logBuffer);
});

// 3. ASIN Database Read
const DEDUPE_FILE = path.join(__dirname, 'crawled_asins.json');
app.get('/api/asins', checkAuth, (req, res) => {
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const content = fs.readFileSync(DEDUPE_FILE, 'utf8');
      const list = JSON.parse(content);
      return res.json(list);
    }
    return res.json([]);
  } catch (err) {
    addLog('error', `Failed to read crawled_asins.json: ${err.message}`);
    res.status(500).json({ error: 'Failed to read ASIN database' });
  }
});

// 4. ASIN Database Delete Key
app.delete('/api/asins/:key', checkAuth, (req, res) => {
  const keyToDelete = req.params.key;
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const content = fs.readFileSync(DEDUPE_FILE, 'utf8');
      let list = JSON.parse(content);
      const index = list.indexOf(keyToDelete);
      if (index !== -1) {
        list.splice(index, 1);
        fs.writeFileSync(DEDUPE_FILE, JSON.stringify(list, null, 2), 'utf8');
        addLog('success', `Deleted product key "${keyToDelete}" from database`);
        return res.json({ success: true, message: `Key ${keyToDelete} deleted` });
      } else {
        return res.status(404).json({ error: `Key ${keyToDelete} not found in database` });
      }
    }
    return res.status(404).json({ error: 'Database file not found' });
  } catch (err) {
    addLog('error', `Failed to delete key "${keyToDelete}": ${err.message}`);
    res.status(500).json({ error: 'Failed to update database' });
  }
});

// 5. Parser Playground Sandbox
app.post('/api/test-parse', checkAuth, async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Text field is required' });
  }

  addLog('info', `Interactive playground processing text trial...`);
  try {
    const products = parseMessage(text);
    if (!products || products.length === 0) {
      addLog('warning', `Playground parsing yielded 0 products`);
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



// Start Express Listener
app.listen(PORT, () => {
  addLog('success', `Dashboard Web Server running on port ${PORT}`);
});

// ── Telegram Command Helpers ───────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '👋 Welcome! Send me product deals and I will format and post them to Telegram.');
});

bot.onText(/\/test/, (msg) => {
  bot.sendMessage(msg.chat.id, `⚙️ Bot is operational.\nMode: ${isProduction ? 'Webhook (Render)' : 'Polling (Local)'}`);
});

// ── Scrape with Hard Timeout ───────────────────────────────────────────────────
// If scraping hangs, resolve with safe defaults after 22s so bot always replies.
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

// ── Main Message Listener ──────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  try {
    // Skip bot messages — prevents infinite loops
    if (msg.from && msg.from.is_bot) return;

    // Skip service/system messages (joins, pins, etc.)
    if (!msg.text && !msg.caption) return;

    const rawText = msg.text || msg.caption || '';

    // Ignore slash commands and very short inputs
    if (rawText.trim().startsWith('/') || rawText.trim().length < 5) return;

    metrics.totalProcessed++;
    addLog('info', `Received telegram deal message from ${msg.from?.username || msg.from?.first_name || 'Anonymous'}`);

    // 1. Parse product links from message
    const products = parseMessage(rawText);
    if (!products || products.length === 0) {
      addLog('warning', `No product links extracted from message`);
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
      const scraped = await scrapeWithTimeout(product.link);

      const isScrapeFailed = scraped.title === 'Product' || scraped.title === 'Product Title' || (scraped.upc === 'Not Found' && !scraped.imageUrl);
      if (isScrapeFailed) {
        metrics.failedScrapes++;
        addLog('warning', `Failed to scrape rich data (using fallbacks) for: ${product.link}`);
      } else {
        metrics.successfulScrapes++;
        addLog('success', `Scrape successful for "${scraped.title.substring(0, 40)}..."`);
      }

      const formattedTelegramPost =
        `UPC: ${scraped.upc}\n` +
        `Price: ${product.price}\n` +
        `Units: ${formatUnits(product.units)}\n` +
        `FOB: ${product.fob}\n` +
        `Exp: ${product.exp}\n` +
        `Link: ${product.link}`;

      const telegramOptions = { reply_to_message_id: msg.message_id };

      // 3. Send with image if available, fallback to text
      try {
        if (scraped.imageUrl) {
          await bot.sendPhoto(msg.chat.id, scraped.imageUrl, {
            caption: formattedTelegramPost,
            ...telegramOptions
          });
          addLog('success', `Sent photo deal card to Telegram successfully`);
        } else {
          await bot.sendMessage(msg.chat.id, formattedTelegramPost, telegramOptions);
          addLog('success', `Sent text-only deal card to Telegram successfully`);
        }
      } catch (tgErr) {
        addLog('warning', `Photo deal send failed, retrying text fallback: ${tgErr.message}`);
        try {
          await bot.sendMessage(msg.chat.id, formattedTelegramPost, telegramOptions);
          addLog('success', `Sent fallback text-only deal card to Telegram successfully`);
        } catch (fbErr) {
          addLog('error', `Text fallback failed completely: ${fbErr.message}`);
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

// ── Keep-alive ping (prevents Render free tier from sleeping) ──────────────────
// Ping every 4 minutes — well within Render's 15-minute inactivity sleep window
if (isProduction && process.env.RENDER_EXTERNAL_URL) {
  const pingUrl = `${process.env.RENDER_EXTERNAL_URL}/health`;
  setInterval(() => {
    https.get(pingUrl).on('error', (err) => {
      addLog('warning', `Keep-alive ping error: ${err.message}`);
    });
  }, 240000); // every 4 minutes
  addLog('info', `Keep-alive ping scheduled every 4 minutes → ${pingUrl}`);
}
