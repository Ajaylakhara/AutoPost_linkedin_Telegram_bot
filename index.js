/**
 * Entry point wrapper for Telegram Product Formatter Bot.
 * Automatically loads local environment variables from .env and starts the bot from the src/ folder.
 */

require('dotenv').config();

// Require bot from src/index.js (this initializes it)
const { bot } = require('./src/index.js');

// Expose a basic HTTP server. Render's Free Web Service requires binding to a port.
const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/telegram-webhook') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        if (body) {
          const update = JSON.parse(body);
          bot.processUpdate(update);
        }
      } catch (err) {
        console.error('❌ Error processing webhook update:', err.message);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AutoPost LinkedIn Telegram Bot is Live!');
  }
}).listen(PORT, () => {
  console.log(`📡 Keep-alive web server listening on port ${PORT}`);
});


