/**
 * Scraper Module.
 * Fetches page HTML and extracts product details (Title, Image, UPC).
 *
 * FIX LOG:
 *  - Amazon blocks plain axios → added realistic browser headers + cookies
 *  - Image not found → built directly from ASIN using Amazon CDN pattern
 *  - UPC Not Found → added free UPCitemdb API lookup by product title/ASIN
 *  - Added multiple fallback layers for each field
 */

const axios = require('axios');
const cheerio = require('cheerio');
const urlModule = require('url');

// ─── Rotating User Agents (to reduce bot detection) ───────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Extract ASIN from Amazon URL ─────────────────────────────────────────────
function extractAsin(url) {
  if (!url) return null;
  const match = url.match(/(?:dp|gp\/product|ASIN|d)\/([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : null;
}

// ─── Build Amazon product image URL directly from ASIN ────────────────────────
// Amazon stores main product images with a predictable CDN pattern
function buildAmazonImageUrl(asin) {
  if (!asin) return null;
  return `https://images-na.ssl-images-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`;
}

// ─── Expand short/redirect URLs ───────────────────────────────────────────────
async function expandUrl(url, maxRedirects = 8) {
  if (maxRedirects <= 0 || !url) return url;
  try {
    const response = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      timeout: 8000,
      headers: {
        'User-Agent': getRandomUserAgent()
      }
    });

    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      let redirectUrl = response.headers.location;
      if (!redirectUrl.startsWith('http')) {
        redirectUrl = urlModule.resolve(url, redirectUrl);
      }
      return expandUrl(redirectUrl, maxRedirects - 1);
    }
    return url;
  } catch (err) {
    if (err.response && err.response.status >= 300 && err.response.status < 400 && err.response.headers.location) {
      let redirectUrl = err.response.headers.location;
      if (!redirectUrl.startsWith('http')) {
        redirectUrl = urlModule.resolve(url, redirectUrl);
      }
      return expandUrl(redirectUrl, maxRedirects - 1);
    }
    return url;
  }
}

// ─── Extract unique product key for deduplication ─────────────────────────────
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

// ─── UPCitemdb API Lookup (free, no key needed for search) ────────────────────
// Searches by product title/keywords to find matching UPC
async function lookupUpcByTitle(title) {
  if (!title || title === 'Product Title') return null;
  try {
    // Use the first ~5 words of the title as search query
    const query = title.split(' ').slice(0, 6).join(' ');
    const response = await axios.get('https://api.upcitemdb.com/prod/trial/search', {
      params: { s: query, type: 'product' },
      timeout: 6000,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/json'
      }
    });

    if (response.data && response.data.items && response.data.items.length > 0) {
      const item = response.data.items[0];
      if (item.upc) return item.upc;
      if (item.ean) return item.ean;
    }
  } catch (err) {
    console.log('   [UPC API] lookup failed:', err.message);
  }
  return null;
}

// ─── Scrape Amazon product page with realistic headers ────────────────────────
async function scrapeAmazon(expandedUrl, data) {
  const ua = getRandomUserAgent();
  const headers = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
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
  };

  const response = await axios.get(expandedUrl, {
    timeout: 12000,
    headers,
    maxRedirects: 5
  });

  const html = response.data;

  // Check if Amazon returned a robot/captcha page
  if (html.includes('api-services-support@amazon.com') || html.includes('Enter the characters you see below')) {
    console.log('   [Amazon] Bot detection triggered — using fallback data extraction only');
    return html; // Return whatever we got
  }

  return html;
}

// ─── Scrape Walmart product page ──────────────────────────────────────────────
async function scrapeWalmart(expandedUrl, data) {
  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.walmart.com/',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin'
  };

  const response = await axios.get(expandedUrl, {
    timeout: 12000,
    headers,
    maxRedirects: 5
  });

  return response.data;
}

// ─── Parse HTML for product fields ────────────────────────────────────────────
function parseHtml(html, expandedUrl, data) {
  const $ = cheerio.load(html);

  // 1. JSON-LD Schema (most reliable source)
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const textContent = $(element).html();
      if (!textContent) return;
      const schema = JSON.parse(textContent.trim());
      const schemas = Array.isArray(schema) ? schema : [schema];

      for (const s of schemas) {
        if (s['@type'] === 'Product' || (Array.isArray(s['@type']) && s['@type'].includes('Product')) || s.name || s.image) {
          if (s.name && data.title === 'Product Title') {
            data.title = s.name.trim();
          }
          if (s.image && !data.imageUrl) {
            const img = Array.isArray(s.image) ? s.image[0] : s.image;
            if (img && typeof img === 'string') data.imageUrl = img;
            else if (img && typeof img === 'object' && img.url) data.imageUrl = img.url;
          }
          // Extract UPC/GTIN
          const gtin = s.gtin14 || s.gtin13 || s.gtin12 || s.gtin || s.upc || s.mpn;
          if (gtin && typeof gtin === 'string' && data.upc === 'Not Found') {
            const cleaned = gtin.replace(/\D/g, '');
            if (cleaned.length >= 8) data.upc = cleaned;
          }
        }
      }
    } catch (e) {
      // Skip malformed JSON-LD
    }
  });

  // 2. Walmart Next.js __NEXT_DATA__ JSON (very reliable for Walmart)
  if (expandedUrl.includes('walmart.com') && (data.upc === 'Not Found' || !data.imageUrl)) {
    try {
      const nextDataScript = $('#__NEXT_DATA__').html() || $('script#__NEXT_DATA__').html();
      if (nextDataScript) {
        const nextData = JSON.parse(nextDataScript);
        const product = nextData?.props?.pageProps?.initialData?.data?.product;
        if (product) {
          if (data.title === 'Product Title' && product.name) data.title = product.name;
          if (!data.imageUrl && product.imageInfo?.thumbnailUrl) data.imageUrl = product.imageInfo.thumbnailUrl;
          if (!data.imageUrl && product.imageInfo?.allImages?.[0]?.url) data.imageUrl = product.imageInfo.allImages[0].url;
          if (data.upc === 'Not Found' && product.upc) data.upc = product.upc;
        }
      }
    } catch (e) {
      // Skip malformed Next.js data
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

  // Clean common title suffixes
  if (data.title) {
    data.title = data.title
      .replace(/\s*-\s*Walmart\.com\s*$/i, '')
      .replace(/\s*:\s*Amazon\.com\s*(?::\s*.*)?$/i, '');
  }

  // 4. Image fallbacks
  if (!data.imageUrl) {
    // Amazon landing image
    const amzImgDynamic = $('#landingImage').attr('data-a-dynamic-image');
    if (amzImgDynamic) {
      try {
        const decoded = JSON.parse(amzImgDynamic);
        const urls = Object.keys(decoded);
        if (urls.length > 0) data.imageUrl = urls[0];
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

  // 5. UPC fallbacks from HTML text
  if (data.upc === 'Not Found') {
    // Look in Amazon product detail table
    const upcParent = $('span:contains("UPC"), th:contains("UPC"), td:contains("UPC"), .a-span3:contains("UPC")')
      .first()
      .closest('tr, li, .a-row')
      .text();

    const upcMatch = upcParent.match(/\b([0-9]{12})\b/);
    if (upcMatch) {
      data.upc = upcMatch[1];
    } else {
      // Raw HTML regex scan near the word "UPC"
      const upcIndex = html.search(/\bUPC\b/i);
      if (upcIndex !== -1) {
        const substring = html.substring(upcIndex, upcIndex + 300);
        const rawMatch = substring.match(/\b(\d{12,13})\b/);
        if (rawMatch) data.upc = rawMatch[1];
      }
    }
  }
}

// ─── Main Export: scrapeProductData ───────────────────────────────────────────
async function scrapeProductData(url) {
  const data = {
    title: 'Product Title',
    imageUrl: '',
    upc: 'Not Found'
  };

  if (!url) return data;

  try {
    const expandedUrl = await expandUrl(url);
    console.log(`   [Scraper] Expanded URL: ${expandedUrl}`);

    const isAmazon = expandedUrl.includes('amazon.com');
    const isWalmart = expandedUrl.includes('walmart.com');

    // ── STEP 1: Extract ASIN for Amazon (image CDN used as FINAL fallback) ─
    // NOTE: We do NOT pre-set imageUrl here. HTML scraping runs first so that
    // the real product image (og:image, landingImage) takes priority over the
    // generic ASIN CDN pattern which may return blank placeholder images.
    let asin = null;
    if (isAmazon) {
      asin = extractAsin(expandedUrl);
      if (asin) {
        console.log(`   [Scraper] ASIN detected: ${asin}`);
      }
    }

    // ── STEP 2: Scrape the product page HTML ─────────────────────────────────
    let html = '';
    try {
      if (isAmazon) {
        html = await scrapeAmazon(expandedUrl, data);
      } else if (isWalmart) {
        html = await scrapeWalmart(expandedUrl, data);
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
      console.log(`   [Scraper] HTTP fetch failed: ${httpErr.message} — using pre-built ASIN data`);
    }

    // ── STEP 3: Parse HTML if we got any ─────────────────────────────────────
    if (html) {
      parseHtml(html, expandedUrl, data);
    }

    // ── STEP 4: Amazon ASIN image CDN fallback (only if HTML found nothing) ─
    if (isAmazon && asin && !data.imageUrl) {
      const asinImageUrl = buildAmazonImageUrl(asin);
      // Validate the CDN URL returns a real image (not a blank placeholder)
      try {
        const headRes = await axios.head(asinImageUrl, { timeout: 5000 });
        const contentType = headRes.headers['content-type'] || '';
        const contentLength = parseInt(headRes.headers['content-length'] || '0', 10);
        if (contentType.includes('image') && contentLength > 2000) {
          data.imageUrl = asinImageUrl;
          console.log(`   [Scraper] ASIN CDN image validated OK (${contentLength} bytes)`);
        } else {
          console.log(`   [Scraper] ASIN CDN image rejected (type: ${contentType}, size: ${contentLength}) — no image`);
        }
      } catch (headErr) {
        console.log(`   [Scraper] ASIN CDN head check failed: ${headErr.message}`);
      }
    }

    // ── STEP 5: UPC Lookup via free API if still Not Found ───────────────────
    if (data.upc === 'Not Found') {
      console.log(`   [Scraper] UPC not found in HTML — trying UPCitemdb API...`);
      const apiUpc = await lookupUpcByTitle(data.title);
      if (apiUpc) {
        data.upc = apiUpc;
        console.log(`   [Scraper] UPC found via API: ${data.upc}`);
      } else {
        console.log(`   [Scraper] UPC API returned no result — keeping "Not Found"`);
      }
    }

  } catch (err) {
    console.error(`[Scraper Error] ${url}:`, err.message);
  }

  // Final safety checks
  if (!data.upc || data.upc.trim() === '') data.upc = 'Not Found';
  if (!data.title || data.title.trim() === '') data.title = 'Product';

  console.log(`   [Scraper] Final → Title: "${data.title.substring(0, 40)}..." | UPC: ${data.upc} | Image: ${data.imageUrl ? 'YES' : 'NO'}`);

  return data;
}

module.exports = {
  scrapeProductData,
  expandUrl,
  extractProductKey
};
