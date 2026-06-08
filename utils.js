/**
 * Parser Utility module for parsing product deals.
 *
 * FIX LOG:
 *  - Units showed "N/A" because parser only looked at text AFTER the URL.
 *    Format "3,600 Units Available\nFOB - NY\nhttps://..." has data BEFORE the URL.
 *    Fix: Now uses FULL message text for all field extraction, not block-after-URL.
 *  - Non-breaking spaces (\u00A0) in Telegram messages caused regex mismatches.
 *    Fix: Normalize all whitespace before parsing.
 *  - Added support for "X,XXX Units Available" format (number before "Units").
 */

const fs = require('fs');
const path = require('path');

const DEDUPE_FILE = path.join(__dirname, 'crawled_asins.json');

/**
 * Normalizes Telegram text: replaces non-breaking spaces, smart quotes,
 * and other special characters with standard ASCII equivalents.
 *
 * @param {string} text Raw Telegram message text.
 * @returns {string} Normalized text.
 */
function normalizeText(text) {
  return text
    .replace(/\u00A0/g, ' ')   // Non-breaking space → regular space
    .replace(/\u2019/g, "'")   // Right single quote
    .replace(/\u201C|\u201D/g, '"') // Smart double quotes
    .replace(/\r\n/g, '\n')    // Windows line endings
    .replace(/\r/g, '\n');     // Old Mac line endings
}

/**
 * Extracts price from a text block.
 * Supports: $3.95, $140, $3,499.00
 */
function extractPrice(text) {
  const match = text.match(/(\$[0-9,]+(?:\.[0-9]+)?)/);
  return match ? match[1] : 'Contact for Price';
}

/**
 * Extracts units from a text block.
 * Supports:
 *   "Units: 3600", "Units- 3600", "3,600 Units Available", "120 Units"
 */
function extractUnits(text) {
  // Format 1: "Units: 3600" or "Units - 3600"
  const prefixMatch = text.match(/Units?\s*[:\-]?\s*([\d,]+)/i);
  if (prefixMatch) return prefixMatch[1].replace(/,/g, '');

  // Format 2: "3,600 Units Available" or "120 Units"
  const suffixMatch = text.match(/([\d,]+)\s+Units?/i);
  if (suffixMatch) return suffixMatch[1].replace(/,/g, '');

  // Format 3: standalone number line (e.g. a line that is only digits)
  const lines = text.split('\n');
  for (const line of lines) {
    const clean = line.trim();
    if (/^[\d,]+$/.test(clean) && !clean.startsWith('$')) {
      return clean.replace(/,/g, '');
    }
  }

  return 'N/A';
}

/**
 * Extracts FOB location from a text block.
 * Supports: "FOB: NY", "FOB - NY", "FOB NY"
 */
function extractFob(text) {
  const match = text.match(/\bFOB\s*[:\-]?\s*([^\n\r,]+)/i);
  if (match) return match[1].trim();
  return 'N/A';
}

/**
 * Extracts expiry from a text block.
 * Supports: "Exp: 12/31", "Expiry: 2025-01-01"
 */
function extractExp(text) {
  const match = text.match(/\bExp(?:iry)?\s*[:\-]?\s*([^\n\r,]+)/i);
  if (match) return match[1].trim();
  return 'N/A';
}

/**
 * Parses details from a Telegram message containing one or more product deals.
 * Extracts details per product link found in the message.
 *
 * @param {string} text The raw Telegram message text.
 * @returns {Array<object>} An array of parsed product objects.
 */
function parseMessage(text) {
  if (!text || text.trim().length < 5) {
    return [];
  }

  // Normalize special characters that Telegram might use
  const normalizedText = normalizeText(text);

  // Find all URLs in the message
  const linkRegex = /(https?:\/\/[^\s]+)/g;
  const matches = [...normalizedText.matchAll(linkRegex)];

  if (matches.length === 0) {
    return [];
  }

  const products = [];

  for (let i = 0; i < matches.length; i++) {
    const currentMatch = matches[i];
    const link = currentMatch[0];

    // ── Build context block for this link ─────────────────────────────────────
    // Include text BEFORE and AFTER the URL (up to previous/next URL boundary).
    // This handles both formats:
    //   • Data before URL: "$3.95\n3600 Units\nhttps://..."
    //   • Data after URL:  "https://...\n$3.95\n3600 Units"
    const prevEnd = i === 0 ? 0 : matches[i - 1].index + matches[i - 1][0].length;
    const nextStart = i === matches.length - 1 ? normalizedText.length : matches[i + 1].index;

    // blockText includes everything around this URL
    const blockText = normalizedText.substring(prevEnd, nextStart);

    // Extract fields from the block (which may have data before OR after the URL)
    const price = extractPrice(blockText);
    const units = extractUnits(blockText);
    const fob = extractFob(blockText);
    const exp = extractExp(blockText);

    products.push({
      link,
      price,
      units,
      exp,
      fob
    });
  }

  return products;
}

/**
 * Checks if a product has already been posted.
 * Adds the key to crawled_asins.json if new.
 *
 * @param {string} key Unique identifier for the product.
 * @returns {boolean} True if new/added, false if duplicate.
 */
function checkAndAddProductKey(key) {
  if (!key || key === 'unknown') return true;

  let database = [];
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const content = fs.readFileSync(DEDUPE_FILE, 'utf8');
      database = JSON.parse(content);
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
  checkAndAddProductKey
};
