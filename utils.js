/**
 * Parser Utility module for parsing product deals.
 *
 * FIX LOG:
 *  - Multi-link messages: Product 2 was getting Product 1's price/units.
 *    Root cause: blockText for URL[i] started from END of URL[i-1], picking
 *    up price/units text between the two URLs.
 *    Fix: Block for URL[i] now starts at URL[i]'s own position, not after URL[i-1].
 *
 *  - FOB / Exp at end of message (after all URLs) showed N/A for all products.
 *    Fix: Global FOB/Exp extracted from full message text and used as fallback
 *    when a product's own block doesn't contain those fields.
 *
 *  - Non-breaking spaces (\u00A0) caused regex mismatches → normalize first.
 *  - "3,600 Units Available" suffix format added.
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
 * Extracts price from text.
 * Supports: $3.95, $140, $3,499.00
 * Returns null if not found (so caller can distinguish "not found" from default).
 */
function extractPrice(text) {
  const match = text.match(/(\$[0-9,]+(?:\.[0-9]+)?)/);
  return match ? match[1] : null;
}

/**
 * Extracts unit count from text.
 * Supports:
 *   "Units: 3600", "Units - 3600", "3,600 Units Available", "120 Units"
 * Returns null if not found.
 */
function extractUnits(text) {
  // Format 1: "Units: 3600" or "Units - 3600" (label before number)
  const prefixMatch = text.match(/Units?\s*[:\-]?\s*([\d,]+)/i);
  if (prefixMatch) return prefixMatch[1].replace(/,/g, '');

  // Format 2: "3,600 Units Available" or "120 Units" (number before label)
  const suffixMatch = text.match(/([\d,]+)\s+Units?/i);
  if (suffixMatch) return suffixMatch[1].replace(/,/g, '');

  // Format 3: Standalone number-only line (not a price)
  const lines = text.split('\n');
  for (const line of lines) {
    const clean = line.trim();
    if (/^[\d,]+$/.test(clean)) {
      return clean.replace(/,/g, '');
    }
  }

  return null;
}

/**
 * Extracts FOB location from text.
 * Supports: "FOB: NY", "FOB - NY", "FOB NY"
 * Returns null if not found.
 */
function extractFob(text) {
  const match = text.match(/\bFOB\s*[:\-]?\s*([^\n\r,]+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Extracts expiry date from text.
 * Supports: "Exp: 12/31", "Exp 07/27", "Expiry: 2025-01-01"
 * Returns null if not found.
 */
function extractExp(text) {
  const match = text.match(/\bExp(?:iry)?\s*[:\-]?\s*([^\n\r,]+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Parses a Telegram message that may contain one or more product deal links.
 *
 * Each URL's associated block = text from that URL up to the next URL.
 * This ensures each product gets its OWN price/units, not a neighboring one.
 * FOB and Exp are pulled from the full message as a global fallback, since
 * they often appear once at the bottom and apply to all products.
 *
 * @param {string} text The raw Telegram message text.
 * @returns {Array<object>} Parsed product objects.
 */
function parseMessage(text) {
  if (!text || text.trim().length < 5) {
    return [];
  }

  // Normalize special Telegram characters
  const normalizedText = normalizeText(text);

  // Find all URLs
  const linkRegex = /(https?:\/\/[^\s]+)/g;
  const matches = [...normalizedText.matchAll(linkRegex)];

  if (matches.length === 0) {
    return [];
  }

  // ── Extract GLOBAL fallbacks from the ENTIRE message ─────────────────────
  // These apply when a product's own text block doesn't have FOB / Exp / Price / Units
  const globalPrice = extractPrice(normalizedText);
  const globalFob   = extractFob(normalizedText);
  const globalExp   = extractExp(normalizedText);
  const globalUnits = extractUnits(normalizedText);

  const products = [];

  for (let i = 0; i < matches.length; i++) {
    const link = matches[i][0];

    // ── Build this product's block ──────────────────────────────────────────
    // IMPORTANT: Block starts at the CURRENT URL's position (not end of prev URL).
    // This guarantees each product's $price and units are read from its own section.
    //
    // Example message:
    //   https://url1       ← URL1 position
    //   $1.50              ← belongs to product 1
    //   8,064 Units
    //
    //   https://url2       ← URL2 position
    //   $6.50              ← belongs to product 2
    //   2,400 Units
    //
    //   Exp 07/27          ← global (no URL prefix)
    //   FOB - IL           ← global (no URL prefix)
    //
    // blockText for URL1 = "https://url1\n$1.50\n8,064 Units\n\n"
    // blockText for URL2 = "https://url2\n$6.50\n2,400 Units\n\nExp 07/27\nFOB - IL"

    const blockStart = matches[i].index;
    const blockEnd   = i < matches.length - 1 ? matches[i + 1].index : normalizedText.length;
    const blockText  = normalizedText.substring(blockStart, blockEnd);

    // Extract from block first, fall back to global if not found
    const price = extractPrice(blockText) || globalPrice || 'Contact for Price';
    const units = extractUnits(blockText) || globalUnits || 'N/A';
    const fob   = extractFob(blockText)   || globalFob   || 'N/A';
    const exp   = extractExp(blockText)   || globalExp   || 'N/A';

    products.push({ link, price, units, fob, exp });
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
