/**
 * Entry point wrapper for Telegram Product Formatter Bot.
 * Automatically loads local environment variables from .env and starts the bot from the src/ folder.
 */

require('dotenv').config();

// Expose a basic HTTP server. Render's Free Web Service requires binding to a port.
const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('AutoPost LinkedIn Telegram Bot is Live!');
}).listen(PORT, () => {
  console.log(`📡 Keep-alive web server listening on port ${PORT}`);
});

require('./src/index.js');


