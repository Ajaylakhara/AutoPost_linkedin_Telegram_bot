/**
 * Entry point wrapper for Telegram Product Formatter Bot.
 * Automatically loads local environment variables from .env and starts the bot from the src/ folder.
 */

require('dotenv').config();
require('./src/index.js');

