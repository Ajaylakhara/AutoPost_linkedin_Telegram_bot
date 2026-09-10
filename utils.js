/**
 * Parser Utility module for parsing product deals.
 *
 * Features:
 *  - URL & ASIN extraction
 *  - Regex extraction for Price, Units, FOB, Exp date
 *  - Normalizes text & Unicode non-breaking spaces
 *  - Deduplication check with local crawled_asins.json
 */

const fs = require('fs');
const path = require('path');

const DEDUPE_FILE = path.join(__dirname, 'crawled_asins.json');

/**
 * Normalizes Telegram text — replaces non-breaking spaces, smart quotes,
 * and Windows line endings with standard ASCII equivalents.
 */
function normalizeText(text) {
  return text
    .replace(/\u00A0/g, ' ')        // Non-breaking space → regular space
    .replace(/\u2019/g, "'")         // Right single quote
    .replace(/\u201C|\u201D/g, '"')  // Smart double quotes
    .replace(/\r\n/g, '\n')          // Windows CRLF
    .replace(/\r/g, '\n');           // Old Mac CR
}

/**
 * Extracts price from text ($3.95, $140, $3,499.00).
 */
function extractPrice(text) {
  const match = text.match(/(\$[0-9,]+(?:\.[0-9]+)?)/);
  return match ? match[1] : null;
}

/**
 * Extracts unit count from text ("Units: 3600", "3,600 Units Available", "12k units", etc.).
 */
function expandK(str) {
  const m = str.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*[kK]$/);
  if (m) return String(Math.round(parseFloat(m[1]) * 1000));
  return str.replace(/,/g, '');
}

function extractUnits(text) {
  // Format 1: "Units: 3600" or "Units - 3600"
  const prefixMatch = text.match(/Units?\s*[:\-]?\s*([\d,]+(?:\.\d+)?[kK]?)/i);
  if (prefixMatch) return expandK(prefixMatch[1]);

  // Format 2: "3,600 Units Available"
  const suffixMatch = text.match(/([\d,]+(?:\.\d+)?[kK]?)\s+Units?/i);
  if (suffixMatch) return expandK(suffixMatch[1]);

  // Format 3: Standalone number-only line
  const lines = text.split('\n');
  for (const line of lines) {
    const clean = line.trim();
    if (/^[\d,]+(?:\.\d+)?[kK]?$/.test(clean) && !clean.startsWith('$')) {
      return expandK(clean);
    }
  }

  return null;
}

/**
 * Extracts FOB location from text.
 */
function extractFob(text) {
  const match = text.match(/\bFOB\s*[:\-]?\s*([^\n\r,]+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Extracts expiry date from text.
 */
function extractExp(text) {
  const match = text.match(/\bExp(?:iry)?\s*[:\-]?\s*([^\n\r,]+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Parses a Telegram message that may contain one or more product deal links.
 */
function parseMessage(text) {
  if (!text || text.trim().length < 5) {
    return [];
  }

  const normalizedText = normalizeText(text);
  const linkRegex = /(https?:\/\/[^\s]+)/g;
  const matches = [...normalizedText.matchAll(linkRegex)];

  if (matches.length === 0) {
    return [];
  }

  const globalPrice = extractPrice(normalizedText);
  const globalFob   = extractFob(normalizedText);
  const globalExp   = extractExp(normalizedText);
  const globalUnits = extractUnits(normalizedText);

  const products = [];

  for (let i = 0; i < matches.length; i++) {
    const link = matches[i][0];
    const blockStart = matches[i].index;
    const blockEnd   = i < matches.length - 1 ? matches[i + 1].index : normalizedText.length;
    const blockText  = normalizedText.substring(blockStart, blockEnd);

    const price = extractPrice(blockText) || globalPrice || null;
    const units = extractUnits(blockText) || globalUnits || null;
    const fob   = extractFob(blockText)   || globalFob   || null;
    const exp   = extractExp(blockText)   || globalExp   || null;

    products.push({ link, price, units, fob, exp });
  }

  return products;
}

/**
 * Checks if a product key has already been crawled/posted.
 * Adds key to crawled_asins.json if new.
 */
function checkAndAddProductKey(key) {
  if (!key || key === 'unknown') return true;

  let database = [];
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const content = fs.readFileSync(DEDUPE_FILE, 'utf8');
      database = JSON.parse(content);
      if (!Array.isArray(database)) database = [];
    }
  } catch (e) {
    console.error('[Dedupe Read Error]', e.message);
  }

  if (database.includes(key)) {
    return false;
  }

  database.push(key);
  try {
    fs.writeFileSync(DEDUPE_FILE, JSON.stringify(database, null, 2), 'utf8');
  } catch (e) {
    console.error('[Dedupe Write Error]', e.message);
  }

  return true;
}

module.exports = {
  parseMessage,
  checkAndAddProductKey,
  normalizeText,
  extractPrice,
  extractUnits,
  extractFob,
  extractExp
};
