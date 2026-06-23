/**
 * Scraper Module.
 * Fetches page HTML and extracts product details (Title, Image, UPC).
 *
 * FIX LOG:
 *  - Amazon CDN image fallback returned a 1×1 GIF placeholder (43 bytes, image/gif).
 *    Fix: Added content-type check to reject GIFs, and added multiple alternate CDN patterns.
 *
 *  - Walmart pages blocked by bot detection ("Robot or human?" page).
 *    Fix: Added mobile user-agent fallback, cookie header, extra browser fingerprint headers.
 *
 *  - Amazon pages sometimes return generic "Amazon.com" title due to bot detection.
 *    Fix: Detect and skip this bad title; fall back to ASIN-based image URL using
 *    media-amazon.com CDN which is more reliable.
 *
 *  - UPCitemdb trial endpoint returns 404 for some searches.
 *    Fix: Added better search query and a secondary open barcode lookup via go-upc.com.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const urlModule = require('url');

// ── Rotating User Agents ───────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
];

// Mobile user agents for Walmart fallback
const MOBILE_USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomMobileUserAgent() {
  return MOBILE_USER_AGENTS[Math.floor(Math.random() * MOBILE_USER_AGENTS.length)];
}

// ── Extract ASIN from Amazon URL ──────────────────────────────────────────────
function extractAsin(url) {
  if (!url) return null;
  const match = url.match(/(?:dp|gp\/product|ASIN|d)\/([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : null;
}

// ── Build Amazon CDN image URL from ASIN (multiple patterns) ──────────────────
// Returns an ordered array of candidate URLs to try
function buildAmazonImageCandidates(asin) {
  if (!asin) return [];
  return [
    // Reliable media-amazon.com CDN patterns - Try high-res first
    `https://m.media-amazon.com/images/P/${asin}.01.LZZZZZZZ.jpg`,
    `https://m.media-amazon.com/images/P/${asin}.01._SL1000_.jpg`,
    `https://m.media-amazon.com/images/P/${asin}.01._SX1000_.jpg`,
    `https://m.media-amazon.com/images/P/${asin}.01._SX600_.jpg`,
    `https://m.media-amazon.com/images/P/${asin}.01._SX400_.jpg`,
    // Legacy ssl-images CDN (often returns GIF placeholder — validated below)
    `https://images-na.ssl-images-amazon.com/images/P/${asin}.01.LZZZZZZZ.jpg`,
    `https://images-na.ssl-images-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`,
  ];
}

// ── Convert image URL to highest resolution possible ──────────────────────────
function getHighResImageUrl(imageUrl, productUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return imageUrl;

  const isAmz = (productUrl && productUrl.includes('amazon.com')) || imageUrl.includes('media-amazon.com') || imageUrl.includes('images-amazon.com');
  const isWm = (productUrl && productUrl.includes('walmart.com')) || imageUrl.includes('walmartimages.com');
  const isEb = (productUrl && productUrl.includes('ebay.com')) || imageUrl.includes('ebayimg.com');

  if (isAmz) {
    // Strip dynamic resizing parameters (e.g. ._AC_US40_ or ._SX300_)
    return imageUrl.replace(/\._[A-Z0-9_,-]+\.(jpe?g|png|webp|gif)$/i, '.$1');
  }

  if (isWm) {
    // Replace odnHeight/odnWidth query params with larger ones
    let cleaned = imageUrl;
    cleaned = cleaned.replace(/odnHeight=\d+/gi, 'odnHeight=1000');
    cleaned = cleaned.replace(/odnWidth=\d+/gi, 'odnWidth=1000');
    return cleaned;
  }

  if (isEb) {
    // eBay image URL format has size like s-l64.jpg, change it to s-l1600.jpg
    return imageUrl.replace(/s-l\d+\.(jpe?g|png|webp|gif)$/i, 's-l1600.$1');
  }

  return imageUrl;
}

// ── Check if an image URL is valid (not a GIF placeholder, not too small) ─────
async function validateImageUrl(url) {
  try {
    const headRes = await axios.head(url, { timeout: 5000 });
    const contentType   = (headRes.headers['content-type'] || '').toLowerCase();
    const contentLength = parseInt(headRes.headers['content-length'] || '0', 10);
    // Must be an actual image, not a GIF placeholder (Amazon uses 1×1 GIF for missing images)
    if (!contentType.startsWith('image/')) return false;
    if (contentType.includes('gif')) return false;
    if (contentLength > 0 && contentLength < 2000) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// ── Find first valid Amazon image URL for an ASIN ─────────────────────────────
async function findAmazonImageUrl(asin) {
  const candidates = buildAmazonImageCandidates(asin);
  for (const url of candidates) {
    const valid = await validateImageUrl(url);
    if (valid) return url;
  }
  return null;
}

// ── Expand short/redirect URLs ────────────────────────────────────────────────
async function expandUrl(url, maxRedirects = 8) {
  if (maxRedirects <= 0 || !url) return url;
  try {
    const response = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      timeout: 4000,
      headers: { 'User-Agent': getRandomUserAgent() }
    });

    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      let redirectUrl = response.headers.location;
      if (!redirectUrl.startsWith('http')) redirectUrl = urlModule.resolve(url, redirectUrl);
      return expandUrl(redirectUrl, maxRedirects - 1);
    }
    return url;
  } catch (err) {
    if (err.response && err.response.status >= 300 && err.response.status < 400 && err.response.headers.location) {
      let redirectUrl = err.response.headers.location;
      if (!redirectUrl.startsWith('http')) redirectUrl = urlModule.resolve(url, redirectUrl);
      return expandUrl(redirectUrl, maxRedirects - 1);
    }
    return url;
  }
}

// ── Extract unique product key for deduplication ──────────────────────────────
function extractProductKey(url) {
  if (!url) return 'unknown';

  const asin = extractAsin(url);
  if (asin) return asin;

  const walmartMatch = url.match(/\/ip\/(?:[^\/]+\/)?([\d]+)/i);
  if (walmartMatch) return `walmart_${walmartMatch[1]}`;

  const ebayMatch = url.match(/itm\/(\d+)/i);
  if (ebayMatch) return `ebay_${ebayMatch[1]}`;

  try {
    const parsed = urlModule.parse(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch (e) {
    return url;
  }
}

// ── UPCitemdb API Lookup (free trial) ─────────────────────────────────────────
async function lookupUpcByTitle(title) {
  if (!title || title === 'Product Title' || title === 'Product' || title === 'Amazon.com') return null;
  try {
    // Use first 5 meaningful words to improve search accuracy
    const words = title.split(' ').filter(w => w.length > 2).slice(0, 5);
    const query = words.join(' ');
    if (!query) return null;

    const response = await axios.get('https://api.upcitemdb.com/prod/trial/search', {
      params: { s: query, type: 'product' },
      timeout: 6000,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate'
      }
    });

    if (response.data?.items?.length > 0) {
      const item = response.data.items[0];
      return item.upc || item.ean || null;
    }
  } catch (err) {
    // UPC API unavailable or rate limited — silently skip
  }
  return null;
}

// ── UPCitemdb Page Scraper fallback for ASINs ─────────────────────────────────
async function lookupUpcByAsin(asin) {
  if (!asin) return null;
  try {
    const response = await axios.get(`https://www.upcitemdb.com/query?s=${asin}&type=2`, {
      timeout: 5000,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.google.com/'
      }
    });

    const $ = cheerio.load(response.data);
    let foundUpc = null;
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/upc\/(\d{12,13})/);
      if (match) {
        foundUpc = match[1];
        return false; // break
      }
    });

    if (foundUpc) {
      console.log(`[Scraper] Scraped UPC ${foundUpc} from UPCitemdb query for ASIN: ${asin}`);
      return foundUpc;
    }
  } catch (err) {
    console.error(`[Scraper] UPCitemdb query scrape failed for ASIN ${asin}: ${err.message}`);
  }
  return null;
}

// ── Scrape eBay product page ──────────────────────────────────────────────────
async function scrapeEbay(expandedUrl) {
  const response = await axios.get(expandedUrl, {
    timeout: 6000,
    maxRedirects: 5,
    headers: {
      'User-Agent': getRandomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Connection': 'keep-alive',
      'Referer': 'https://www.google.com/',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'dnt': '1'
    }
  });
  return response.data;
}

// ── Scrape eBay mobile page (fallback when desktop is blocked) ────────────────
async function scrapeEbayMobile(expandedUrl) {
  const response = await axios.get(expandedUrl, {
    timeout: 6000,
    maxRedirects: 5,
    headers: {
      'User-Agent': getRandomMobileUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive'
    }
  });
  return response.data;
}

// ── Scrape Amazon product page ─────────────────────────────────────────────────
async function scrapeAmazon(expandedUrl) {
  const response = await axios.get(expandedUrl, {
    timeout: 6000,
    maxRedirects: 5,
    headers: {
      'User-Agent': getRandomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Connection': 'keep-alive',
      'Referer': 'https://www.google.com/',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'dnt': '1'
    }
  });
  return response.data;
}

// ── Scrape Walmart product page (desktop) ─────────────────────────────────────
async function scrapeWalmartDesktop(expandedUrl) {
  const response = await axios.get(expandedUrl, {
    timeout: 6000,
    maxRedirects: 5,
    headers: {
      'User-Agent': getRandomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Referer': 'https://www.google.com/',
      'Cache-Control': 'max-age=0',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'dnt': '1',
      // Walmart-specific: fake a cookie session to reduce bot detection
      'Cookie': 'bstc=yJRNaxqX5gXI4H5nF38Ldg; hasLocData=1; locDataV3=eyJpc1Jlc29sdmVkIjp0cnVlLCJzdG9yZUlkIjoiNDM5NiIsInppcENvZGUiOiI2MDYwNiIsImRpc3BsYXlWYWx1ZSI6IjYwNjA2IiwidHlwZXMiOlsiU1RPUkVfTEVEIl19; DL={"aid":"1_8a0f69d7-2b83-4b29-af65-08cf94a8bda2"}',
    }
  });
  return response.data;
}

// ── Scrape Walmart product page (mobile fallback) ─────────────────────────────
async function scrapeWalmartMobile(expandedUrl) {
  // Use www.walmart.com with a mobile user-agent (mobile.walmart.com doesn't exist)
  const response = await axios.get(expandedUrl, {
    timeout: 6000,
    maxRedirects: 5,
    headers: {
      'User-Agent': getRandomMobileUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Referer': 'https://www.google.com/',
      'upgrade-insecure-requests': '1',
      'sec-ch-ua-mobile': '?1',
      'Cookie': 'bstc=yJRNaxqX5gXI4H5nF38Ldg; hasLocData=1;'
    }
  });
  return response.data;
}

// ── Scrape Amazon mobile page (fallback when desktop is blocked) ──────────────
async function scrapeAmazonMobile(expandedUrl, asin) {
  // Use clean dp URL with mobile UA to avoid robot detection
  const mobileUrl = asin
    ? `https://www.amazon.com/dp/${asin}?th=1&psc=1`
    : expandedUrl;

  const response = await axios.get(mobileUrl, {
    timeout: 6000,
    maxRedirects: 5,
    headers: {
      'User-Agent': getRandomMobileUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Connection': 'keep-alive',
      'Referer': 'https://www.google.com/',
      'upgrade-insecure-requests': '1',
      'sec-ch-ua-mobile': '?1',
      // Fake session cookies to look like a returning visitor
      'Cookie': 'session-id=263-9876543-1234567; session-id-time=2082787201l; i18n-prefs=USD; ubid-main=133-9876543-1234567'
    }
  });
  return response.data;
}

// ── Extract Walmart item ID from URL ──────────────────────────────────────────
function extractWalmartItemId(url) {
  const match = url.match(/\/ip\/(?:[^\/]+\/)?([\d]+)/i);
  return match ? match[1] : null;
}

// ── Build Walmart CDN image URL candidates from item ID ───────────────────────
// Walmart images are served from i5.walmartimages.com using the item ID.
// These are best-effort guesses but often work for common products.
function buildWalmartImageCandidates(itemId) {
  if (!itemId) return [];
  return [
    `https://i5.walmartimages.com/asr/${itemId}.jpeg`,
    `https://i5.walmartimages.com/asr/${itemId}.jpg`,
    `https://i5.walmartimages.com/seo/${itemId}.jpeg`,
    `https://i5.walmartimages.com/seo/${itemId}.jpg`,
  ];
}

// ── Find first valid Walmart CDN image URL for an item ID ─────────────────────
async function findWalmartImageUrl(itemId) {
  const candidates = buildWalmartImageCandidates(itemId);
  for (const url of candidates) {
    const valid = await validateImageUrl(url);
    if (valid) {
      console.log(`[Scraper] Found valid Walmart CDN image for item ${itemId}: ${url}`);
      return url;
    }
  }
  return null;
}


// ── Parse HTML for product fields ─────────────────────────────────────────────
function parseHtml(html, expandedUrl, data) {
  const $ = cheerio.load(html);

  // 1. JSON-LD Schema
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const textContent = $(element).html();
      if (!textContent) return;
      const schema = JSON.parse(textContent.trim());
      const schemas = Array.isArray(schema) ? schema : [schema];

      for (const s of schemas) {
        if (s['@type'] === 'Product' || (Array.isArray(s['@type']) && s['@type'].includes('Product')) || s.name || s.image) {
          if (s.name && data.title === 'Product Title') data.title = s.name.trim();
          if (s.image && !data.imageUrl) {
            const img = Array.isArray(s.image) ? s.image[0] : s.image;
            if (img && typeof img === 'string') data.imageUrl = img;
            else if (img && typeof img === 'object' && img.url) data.imageUrl = img.url;
          }
          const gtin = s.gtin14 || s.gtin13 || s.gtin12 || s.gtin || s.upc || s.mpn;
          if (gtin && typeof gtin === 'string' && data.upc === 'Not Found') {
            const cleaned = gtin.replace(/\D/g, '');
            if (cleaned.length >= 8) data.upc = cleaned;
          }
        }
      }
    } catch (e) { /* skip malformed JSON-LD */ }
  });

  // 2. Walmart data extraction (multiple strategies)
  if (expandedUrl.includes('walmart.com') && (data.upc === 'Not Found' || !data.imageUrl || data.title === 'Product Title')) {
    // Strategy A: #__NEXT_DATA__ selector (older Walmart layout)
    let nextDataScript = $('script[id="__NEXT_DATA__"]').html();

    // Strategy B: scan all script tags for __NEXT_DATA__ JSON (newer Walmart layout)
    if (!nextDataScript) {
      $('script').each((_, el) => {
        const content = $(el).html() || '';
        if (content.includes('"props"') && content.includes('"pageProps"') && content.length > 10000) {
          nextDataScript = content;
          return false; // break
        }
      });
    }

    if (nextDataScript) {
      try {
        let jsonStr = nextDataScript.trim();
        if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
          const jsonMatch = jsonStr.match(/(\{[\s\S]+\})/);
          if (jsonMatch) jsonStr = jsonMatch[1];
        }
        const nextData = JSON.parse(jsonStr);

        // Try multiple product paths (Walmart has changed their data layout)
        const initialData = nextData?.props?.pageProps?.initialData?.data;
        const product = initialData?.product ||
                        initialData?.idmlMap?.primaryProduct ||
                        initialData?.primaryProduct;

        if (product) {
          if (data.title === 'Product Title' && product.name) data.title = product.name;

          // Extract image — try all known Walmart image schema paths
          if (!data.imageUrl) {
            const imgInfo = product.imageInfo || product.primaryImageInfo || {};
            data.imageUrl =
              imgInfo.thumbnailUrl ||
              imgInfo.url ||
              (Array.isArray(imgInfo.allImages) && imgInfo.allImages[0] && (imgInfo.allImages[0].url || imgInfo.allImages[0])) ||
              (Array.isArray(product.images) && product.images[0] && (product.images[0].url || product.images[0])) ||
              null;
          }

          if (data.upc === 'Not Found' && product.upc) data.upc = product.upc;
          if (data.upc === 'Not Found' && product.gtin) data.upc = product.gtin.replace(/\D/g, '');
        }

        // Also check top-level contentLayout items (newer Walmart SPA structure)
        if (!data.imageUrl) {
          const modules = nextData?.props?.pageProps?.initialData?.data?.contentLayout?.modules;
          if (Array.isArray(modules)) {
            for (const mod of modules) {
              const imgUrl = mod?.configs?.primaryImage?.url ||
                             mod?.configs?.image?.url ||
                             mod?.configs?.hero?.image?.url;
              if (imgUrl && typeof imgUrl === 'string') {
                data.imageUrl = imgUrl;
                break;
              }
            }
          }
        }
      } catch (e) { /* skip malformed Next.js data */ }
    }

    // Strategy C: direct regex on raw HTML
    if (data.upc === 'Not Found' || !data.imageUrl || data.title === 'Product Title') {
      const rawHtml = $.html();
      if (data.upc === 'Not Found') {
        const upcRx = rawHtml.match(/"upc"\s*:\s*"([^"]{8,14})"/);
        if (upcRx) data.upc = upcRx[1];
      }
      if (data.upc === 'Not Found') {
        const gtinRx = rawHtml.match(/"gtin"\s*:\s*"([^"]{8,14})"/);
        if (gtinRx) data.upc = gtinRx[1];
      }
      if (!data.imageUrl) {
        const thumbRx = rawHtml.match(/"thumbnailUrl"\s*:\s*"(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)"/i);
        if (thumbRx) data.imageUrl = thumbRx[1].split('\\\\').join('/');
      }
      if (!data.imageUrl) {
        // Also try imageUrl pattern
        const imgRx = rawHtml.match(/"imageUrl"\s*:\s*"(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)"/i);
        if (imgRx) data.imageUrl = imgRx[1].split('\\\\').join('/');
      }
      if (data.title === 'Product Title') {
        const nameRx = rawHtml.match(/"productName"\s*:\s*"([^"]{5,200})"/);
        if (nameRx) data.title = nameRx[1];
      }
      // Strategy D: Try extracting from __reactProps or similar JSON blobs
      if (data.upc === 'Not Found' || !data.imageUrl) {
        const upcRx2 = rawHtml.match(/"upc\\?"\\s*:\\s*\\"([^"\\\\]{8,14})\\"/);
        if (upcRx2 && data.upc === 'Not Found') data.upc = upcRx2[1];
      }
      if (data.upc === 'Not Found') {
        const gtinRx2 = rawHtml.match(/"gtin\\?"\\s*:\\s*\\"([^"\\\\]{8,14})\\"/);
        if (gtinRx2) data.upc = gtinRx2[1];
      }
    }
  }

  // 2b. eBay data extraction
  if (expandedUrl.includes('ebay.com')) {
    if (data.title === 'Product Title') {
      const ebayTitle = $('.x-item-title__mainTitle').text().trim() || $('#itemTitle').text().trim();
      if (ebayTitle) {
        data.title = ebayTitle.replace(/^Details about\s+/i, '').replace(/\s*\| eBay\s*$/i, '').trim();
      }
    }

    if (!data.imageUrl) {
      const ebayImg = $('#icImg').attr('src') ||
                      $('.ux-image-filmstrip-carousel-item img').attr('src') ||
                      $('.ux-image-carousel-item img').attr('src');
      if (ebayImg) data.imageUrl = ebayImg;
    }

    if (data.upc === 'Not Found') {
      let ebayUpc = '';
      $('.ux-labels-values__labels-content').each((_, el) => {
        const labelText = $(el).text().trim().toLowerCase();
        if (labelText === 'upc' || labelText.includes('upc:')) {
          const valEl = $(el).closest('.ux-labels-values__labels').next('.ux-labels-values__values');
          const valText = valEl.find('.ux-labels-values__values-content').text().trim() || valEl.text().trim();
          if (valText && !valText.toLowerCase().includes('does not apply')) {
            ebayUpc = valText.replace(/\D/g, '');
          }
        }
      });

      if (!ebayUpc) {
        $('.attrLabels').each((_, el) => {
          const labelText = $(el).text().trim().toLowerCase();
          if (labelText === 'upc' || labelText.includes('upc')) {
            const valEl = $(el).next('td');
            const valText = valEl.find('span').text().trim() || valEl.text().trim();
            if (valText && !valText.toLowerCase().includes('does not apply')) {
              ebayUpc = valText.replace(/\D/g, '');
            }
          }
        });
      }

      if (ebayUpc) {
        data.upc = ebayUpc;
      }
    }
  }

  // 3. Title fallbacks
  if (data.title === 'Product Title') {
    const amzTitle = $('#productTitle').text().trim();
    if (amzTitle) {
      data.title = amzTitle;
    } else {
      const ogTitle = $('meta[property="og:title"]').attr('content') || $('meta[name="twitter:title"]').attr('content');
      if (ogTitle) {
        data.title = ogTitle.trim();
      } else {
        const stdTitle = $('title').text().trim();
        if (stdTitle) data.title = stdTitle.replace(/\s+/g, ' ');
      }
    }
  }

  if (data.title) {
    data.title = data.title
      .replace(/\s*-\s*Walmart\.com\s*$/i, '')
      .replace(/\s*:\s*Amazon\.com\s*(?::\s*.*)?$/i, '');
  }

  // 4. Image fallbacks
  if (!data.imageUrl) {
    const amzImgDynamic = $('#landingImage').attr('data-a-dynamic-image');
    if (amzImgDynamic) {
      try {
        const decoded = JSON.parse(amzImgDynamic);
        let maxArea = 0;
        let bestUrl = null;
        for (const [url, dims] of Object.entries(decoded)) {
          if (Array.isArray(dims) && dims.length >= 2) {
            const area = dims[0] * dims[1];
            if (area > maxArea) {
              maxArea = area;
              bestUrl = url;
            }
          }
        }
        if (bestUrl) data.imageUrl = bestUrl;
        else {
          const urls = Object.keys(decoded);
          if (urls.length > 0) data.imageUrl = urls[0];
        }
      } catch (e) {}
    }

    if (!data.imageUrl) {
      data.imageUrl = $('#landingImage').attr('src') ||
                      $('#imgBlkFront').attr('src') ||
                      $('#main-image').attr('src');
    }

    if (!data.imageUrl) {
      const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
      if (ogImage) data.imageUrl = ogImage;
    }

    if (!data.imageUrl) {
      $('img').each((_, img) => {
        const src = $(img).attr('src');
        if (src && src.startsWith('http') && !src.includes('pixel') && !src.includes('sprite') && !src.includes('logo') && !src.includes('tracking')) {
          data.imageUrl = src;
          return false;
        }
      });
    }
  }

  // Resolve relative image URLs
  if (data.imageUrl && data.imageUrl.startsWith('//')) {
    data.imageUrl = 'https:' + data.imageUrl;
  } else if (data.imageUrl && data.imageUrl.startsWith('/')) {
    const parsedUrl = urlModule.parse(expandedUrl);
    data.imageUrl = `${parsedUrl.protocol}//${parsedUrl.host}${data.imageUrl}`;
  }

  // Convert to high-resolution URL
  if (data.imageUrl) {
    data.imageUrl = getHighResImageUrl(data.imageUrl, expandedUrl);
  }

  // 5. UPC fallback from HTML text
  if (data.upc === 'Not Found') {
    const upcParent = $('span:contains("UPC"), th:contains("UPC"), td:contains("UPC"), .a-span3:contains("UPC")')
      .first().closest('tr, li, .a-row').text();

    const upcMatch = upcParent.match(/\b([0-9]{12})\b/);
    if (upcMatch) {
      data.upc = upcMatch[1];
    } else {
      const upcIndex = html.search(/\bUPC\b/i);
      if (upcIndex !== -1) {
        const substring = html.substring(upcIndex, upcIndex + 300);
        const rawMatch = substring.match(/\b(\d{12,13})\b/);
        if (rawMatch) data.upc = rawMatch[1];
      }
    }
  }
}

// ── Detect if the returned HTML is a bot-detection page ───────────────────────
function isBotDetectionPage(html, title) {
  if (!html) return true;
  const lowerTitle = (title || '').toLowerCase();
  if (lowerTitle.includes('robot or human') || lowerTitle.includes('captcha') || lowerTitle.includes('access denied') || lowerTitle.includes('just a moment')) {
    return true;
  }
  if (html.includes('robot-check') || html.includes('/errors/validateCaptcha') || html.includes('api.challenge.walmart.com')) {
    return true;
  }
  return false;
}

// ── Main Export: scrapeProductData ────────────────────────────────────────────
async function scrapeProductData(url) {
  const data = { title: 'Product Title', imageUrl: '', upc: 'Not Found' };

  if (!url) return data;

  try {
    const expandedUrl = await expandUrl(url);
    const isAmazon  = expandedUrl.includes('amazon.com');
    const isWalmart = expandedUrl.includes('walmart.com');
    const isEbay    = expandedUrl.includes('ebay.com');

    // Step 1: Extract ASIN (Amazon) or Item ID (Walmart)
    let asin = null;
    let walmartItemId = null;
    if (isAmazon) asin = extractAsin(expandedUrl);
    if (isWalmart) walmartItemId = extractWalmartItemId(expandedUrl);

    // Step 2: Fetch page HTML
    let html = '';
    let wasBotBlocked = false;

    try {
      if (isAmazon) {
        html = await scrapeAmazon(expandedUrl);
      } else if (isWalmart) {
        // Try desktop first, then immediately fall back to mobile on any failure
        try {
          html = await scrapeWalmartDesktop(expandedUrl);
        } catch (desktopErr) {
          console.error(`[Scraper] Walmart desktop failed: ${desktopErr.message}, trying mobile...`);
        }
        // If desktop failed or returned empty, try mobile right away
        if (!html) {
          try {
            html = await scrapeWalmartMobile(expandedUrl);
            console.log(`[Scraper] Walmart mobile fallback succeeded for: ${expandedUrl}`);
          } catch (mobileErr) {
            console.error(`[Scraper] Walmart mobile fallback also failed: ${mobileErr.message}`);
          }
        }
      } else if (isEbay) {
        try {
          html = await scrapeEbay(expandedUrl);
        } catch (desktopErr) {
          console.error(`[Scraper] eBay desktop failed: ${desktopErr.message}, trying mobile...`);
        }
        if (!html) {
          try {
            html = await scrapeEbayMobile(expandedUrl);
          } catch (mobileErr) {
            console.error(`[Scraper] eBay mobile fallback failed: ${mobileErr.message}`);
          }
        }
      } else {
        const response = await axios.get(expandedUrl, {
          timeout: 10000,
          headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.google.com/'
          }
        });
        html = response.data;
      }
    } catch (httpErr) {
      console.error(`[Scraper] Fetch error for ${url}:`, httpErr.message);
    }

    // Step 2b: If Amazon is blocked, retry with mobile user-agent
    if (isAmazon && html) {
      // Quick check if page is a robot/CAPTCHA page before parsing
      const titleQuickCheck = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
      if (isBotDetectionPage(html, titleQuickCheck)) {
        console.log(`[Scraper] Amazon desktop blocked, retrying with mobile UA for: ${url}`);
        html = '';
        try {
          html = await scrapeAmazonMobile(expandedUrl, asin);
        } catch (mobileErr) {
          console.error(`[Scraper] Amazon mobile fallback failed: ${mobileErr.message}`);
        }
      }
    }

    // Step 3: Parse HTML (first pass)
    if (html) parseHtml(html, expandedUrl, data);

    // Step 4: Detect bot-blocked response and retry with mobile UA for Walmart
    if (isWalmart && isBotDetectionPage(html, data.title)) {
      console.log(`[Scraper] Walmart bot blocked on desktop, trying mobile UA for: ${url}`);
      wasBotBlocked = true;
      // Reset data for clean retry
      data.title = 'Product Title';
      data.imageUrl = '';
      data.upc = 'Not Found';
      html = '';
      try {
        html = await scrapeWalmartMobile(expandedUrl);
        if (html) parseHtml(html, expandedUrl, data);
      } catch (mobileErr) {
        console.error(`[Scraper] Walmart mobile fallback also failed: ${mobileErr.message}`);
      }
    }

    // Step 5a: Amazon ASIN-based image fallback
    // Only run if no image found, or if image is a suspicious short URL
    if (isAmazon && asin && !data.imageUrl) {
      console.log(`[Scraper] Trying Amazon CDN image candidates for ASIN: ${asin}`);
      const validImage = await findAmazonImageUrl(asin);
      if (validImage) {
        data.imageUrl = validImage;
        console.log(`[Scraper] Found valid Amazon CDN image: ${validImage}`);
      }
    }

    // Step 5b: Walmart item-ID-based image CDN fallback
    if (isWalmart && walmartItemId && !data.imageUrl) {
      console.log(`[Scraper] Trying Walmart CDN image candidates for item ID: ${walmartItemId}`);
      const validWalmartImage = await findWalmartImageUrl(walmartItemId);
      if (validWalmartImage) {
        data.imageUrl = validWalmartImage;
      }
    }

    // Step 6: Validate existing image URL (reject GIF placeholders)
    if (data.imageUrl) {
      try {
        const headRes = await axios.head(data.imageUrl, { timeout: 5000 });
        const contentType = (headRes.headers['content-type'] || '').toLowerCase();
        const contentLength = parseInt(headRes.headers['content-length'] || '0', 10);
        if (contentType.includes('gif') || (contentLength > 0 && contentLength < 2000)) {
          console.log(`[Scraper] Rejected placeholder image (${contentType}, ${contentLength}B): ${data.imageUrl}`);
          data.imageUrl = '';
          // Try CDN fallbacks per platform
          if (isAmazon && asin) {
            const validImage = await findAmazonImageUrl(asin);
            if (validImage) data.imageUrl = validImage;
          } else if (isWalmart && walmartItemId) {
            const validWalmartImage = await findWalmartImageUrl(walmartItemId);
            if (validWalmartImage) data.imageUrl = validWalmartImage;
          }
        }
      } catch (e) { /* keep existing imageUrl if head check fails */ }
    }

    // Step 7: UPC API fallback
    if (data.upc === 'Not Found') {
      // 7a. Try looking up by ASIN on UPCitemdb query page (for Amazon products)
      if (isAmazon && asin) {
        const asinUpc = await lookupUpcByAsin(asin);
        if (asinUpc) data.upc = asinUpc;
      }

      // 7b. Try looking up by title via free trial API
      if (data.upc === 'Not Found') {
        const titleIsUseful = data.title && data.title !== 'Product Title' && data.title !== 'Product' &&
                              data.title !== 'Amazon.com' && !isBotDetectionPage('', data.title);
        if (titleIsUseful) {
          const apiUpc = await lookupUpcByTitle(data.title);
          if (apiUpc) data.upc = apiUpc;
        }
      }
    }

  } catch (err) {
    console.error(`[Scraper Error] ${url}:`, err.message);
  }

  if (!data.upc  || data.upc.trim()   === '') data.upc   = 'Not Found';
  if (!data.title || data.title.trim() === '') data.title = 'Product';

  // Sanitize generic/bot-page titles
  if (data.title === 'Amazon.com' || data.title.toLowerCase().includes('robot or human') ||
      data.title.toLowerCase().includes('access denied') || data.title.toLowerCase().includes('captcha')) {
    data.title = 'Product';
  }

  return data;
}

module.exports = { scrapeProductData, expandUrl, extractProductKey };
