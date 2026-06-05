# 🤖 Telegram to LinkedIn Auto Posting Bot (FREE)

A fully automated Node.js system that receives, parses, scrapes, and deduplicates closeout and liquidation deals from Telegram and automatically publishes them to both Telegram and LinkedIn.

---

## ⚡ Key Features

- 📦 **Multi-Product Parsing**: Splits single Telegram messages containing multiple distinct deals into individual, clean posts.
- 🕷️ **Metadata Web Scraping**: Fetches target product pages (Amazon + Walmart) dynamically to extract the **Product Title**, **Product Images**, and the **UPC/Barcode** from page JSON-LD schemas.
- 🛡️ **Deduplication Check**: Prevents duplicate postings to your channels by checking product keys against a local JSON database.
- 🎨 **LinkedIn API AutoPosting**: Exposes automated OAuth 2.0 refresh flow to post deals directly to a personal feed or organization page on LinkedIn.
- ☁️ **Render-Ready Deployment**: Includes built-in Express server with keep-alive ping support (via UptimeRobot) for 100% free hosting.

---

## 📂 Project Architecture

All source code files are situated at the root directory of the project:
- **`utils.js`**: Deals parsing algorithm (`parseMessage`) and deduplication checking.
- **`scraper.js`**: HTML fetcher, title & image scraper (with JSON-LD support for Amazon/Walmart).
- **`linkedin.js`**: LinkedIn API Integration, handling OAuth refresh tokens and publishing posts.
- **`index.js`**: Telegram event listener, main orchestrator, and Express HTTP server.

---

## 🚀 Getting Started

### 1. Prerequisites
Ensure you have [Node.js](https://nodejs.org/) installed.

### 2. Installation
Install project dependencies:
```bash
npm install
```

### 3. Environment Setup (`.env`)
Create a `.env` file in the root directory and add the following keys:

```env
# Telegram Configuration
BOT_TOKEN=your_telegram_bot_token_here
PORT=3000

# LinkedIn Configuration (Get these from LinkedIn Developer Portal)
LINKEDIN_CLIENT_ID=your_client_id_here
LINKEDIN_CLIENT_SECRET=your_client_secret_here
LINKEDIN_REFRESH_TOKEN=your_oauth_refresh_token_here
LINKEDIN_AUTHOR_URN=urn:li:person:YOUR_MEMBER_ID
```
*Note: Use `urn:li:person:YOUR_MEMBER_ID` for personal profiles, or `urn:li:organization:YOUR_PAGE_ID` for company pages.*

### 4. Running the Bot
Start the bot listener locally:
```bash
npm start
```

---

## 🛠️ LinkedIn Developer Setup Guide

1. Go to the [LinkedIn Developer Portal](https://www.linkedin.com/developers/) and click **Create app**.
2. Go to the **Products** tab and request access to:
   - **Share on LinkedIn** (for personal feed posts, scope: `w_member_social`).
   - **Community Management API** (for company page posts, scope: `w_organization_social`).
3. Under the **Auth** tab:
   - Save your **Client ID** and **Client Secret**.
   - Add a Redirect URL: `http://localhost:8080/callback` (or similar).
4. Generate a Refresh Token:
   - You can generate a 365-day refresh token using standard OAuth 2.0 Authorization Code flow tools (like Postman or a simple redirect in browser).
   - Place your refresh token into `.env` as `LINKEDIN_REFRESH_TOKEN`.
   - Put your member ID (e.g. from `https://api.linkedin.com/v2/userinfo`) into `.env` as `LINKEDIN_AUTHOR_URN`.

---

## ☁️ Deployment on Render (FREE)

1. Connect your GitHub repository to [Render](https://render.com) and create a **Web Service** (FREE tier).
2. Set the build command to `npm install` and start command to `npm start`.
3. Add your environment variables (from `.env`) to the Render settings.
4. To prevent your free Render instance from sleeping, register the service on **UptimeRobot** (pinging the base URL `https://your-app-name.onrender.com/` every 5 minutes).
