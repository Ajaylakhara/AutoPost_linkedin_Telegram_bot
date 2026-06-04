# 🤖 AutoPost LinkedIn & Telegram Bot

An advanced Node.js automation bot that receives, splits, parses, scrapes, and deduplicates closeout and liquidation deals from retail product URLs (e.g., Amazon, eBay), generating premium, channel-ready formatted deal cards automatically.

---

## ⚡ Key Features

- 📦 **Multi-Product Processing**: Splits single Telegram messages containing multiple distinct deals into individual, clean deal posts automatically.
- 🔗 **Smart Link Expansion**: Automatically expands shortened URLs (like `a.co` or redirects) to fetch the full target URL.
- 🕷️ **Metadata Web Scraping**: Fetches target product pages dynamically to extract the true **Product Title**, **Product Images**, and the actual **UPC/Barcode** from the page HTML.
- 🆔 **UPC Management**: Identifies and extracts real UPCs from Amazon detail pages, falling back to a generated structured UPC if unavailable.
- 🛡️ **Post Deduplication**: Prevents duplicate postings in your channel by computing unique product keys (such as ASINs or eBay IDs) and registering them in a local deduplication file.
- 🎨 **Premium Formatting**: Generates clean, emoji-rich post templates showing UPC, Price, Units, Expiry Dates, and titles.
- 📸 **Smart Image Fallbacks**: Prioritizes scraped high-resolution product images, falls back to user-uploaded photos, and gracefully degrades to text-only if no images are found.

---

## 📂 Project Architecture

```
.
├── src/
│   ├── config.js         # Configuration settings & file paths
│   ├── parser.js         # Message splitters & text extraction algorithms
│   ├── scraper.js        # Dynamic HTTP fetcher, title & image scrapers
│   ├── dedupe.js         # Local duplicate check via key lists
│   ├── urlHelper.js      # URL expander & ASIN/product key decoders
│   ├── formatter.js      # Post layouts & mock UPC generator
│   └── index.js          # Telegram Event Listener (entrypoint)
├── package.json          # Node dependencies and metadata
└── README.md             # Project documentation
```

---

## 🚀 Getting Started

### 1. Prerequisites
Ensure you have [Node.js](https://nodejs.org/) (v16 or higher) installed on your system.

### 2. Installation
Clone the repository and install the dependencies:
```bash
git clone https://github.com/Ajaylakhara/AutoPost_linkedin_Telegram_bot.git
cd AutoPost_linkedin_Telegram_bot
npm install
```

### 3. Setup Bot Token
To connect to the Telegram API, obtain a token from [@BotFather](https://t.me/BotFather).

For security, the bot loads the token from your environment variables. 

#### On Windows (PowerShell):
```powershell
$env:BOT_TOKEN="your_telegram_bot_token_here"
```

#### On macOS / Linux:
```bash
export BOT_TOKEN="your_telegram_bot_token_here"
```

### 4. Running the Bot
Start the listener:
```bash
npm start
```

Once running, add the bot to your channel/group, or send it direct messages. It will automatically process and format your deals in real time!
