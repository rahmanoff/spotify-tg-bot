# 🎵 Spotify to Telegram Music Bot

A serverless Telegram bot powered by **Cloudflare Workers** that automatically tracks newly liked tracks in your **Spotify** library, analyzes artists using **Gemini LLM**, and sends interactive cards with inline buttons to Telegram.

---

## 🚀 Architecture & Tech Stack

- **Runtime:** [Cloudflare Workers](https://workers.cloudflare.com/) (Serverless edge computing, triggered daily via Cron Triggers and handles Telegram webhook callbacks via `fetch`).
- **State Management:** Cloudflare KV (prevents duplicate runs, stores the state of the last processed track, and temporarily caches dynamic artist track data).
- **External APIs:**
  - **Spotify Web API** (Fetches liked tracks, album details, cover arts, and artist metadata/genres).
  - **Google Gemini API (`gemini-3.5-flash-lite`)** (Generates rich artist biographies, top tracks, and top albums).
  - **Telegram Bot API** (Sends formatted HTML info-cards with interactive inline keyboards).

---

## 📋 Telegram Card & Interaction Format

1. **Main Track Message:** 
   - Sent automatically once a day (scheduled at 17:00 Kyiv time / 15:00 UTC).
   - Includes the track cover art (photo), track title, artists, album name, release year, and a direct link to Spotify.
   - Features an interactive **«📖 Детальніше про артистів»** inline button.
2. **Detailed Artist Cards:**
   - Triggered when the user clicks the inline button.
   - Sends individual full-sized cards for each artist featuring their personal account photo, music genres, detailed biography, top track, and top album.

---

## ⚙️ Step-by-Step Deployment Guide

### 1. Prerequisites
- [Node.js](https://nodejs.org/) installed on your machine.
- A free [Cloudflare](https://dash.cloudflare.com/) account.
- A Telegram bot created via [@BotFather](https://t.me/BotFather).
- A [Google AI Studio](https://aistudio.google.com/) API Key for Gemini.
- A Spotify Developer App to obtain your `Client ID`, `Client Secret`, and a `Refresh Token` with `user-library-read` permissions.

---

### 2. Project Setup

Clone or create your project directory and install dependencies:

```bash
npm install
```

Create a `wrangler.toml` configuration file in the root directory:

```toml
name = "spotify-tg-bot"
main = "src/index.js"
compatibility_date = "2026-10-28"

[triggers]
crons = ["0 15 * * *"] # Runs once a day at 17:00 Kyiv time (15:00 UTC)

[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_NAMESPACE_ID"
```

---

### 3. Setting Up Cloudflare KV

Create a KV namespace in your Cloudflare account (or via Wrangler):

```bash
npx wrangler kv namespace create "KV"
```
Copy the returned `id` and paste it into your `wrangler.toml` under `[[kv_namespaces]]`.

---

### 4. Configuring Secrets in Cloudflare

Store your secure tokens safely using Wrangler secrets:

```bash
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_CHAT_ID
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put SPOTIFY_REFRESH_TOKEN
npx wrangler secret put GEMINI_API_KEY
```

---

### 5. Worker Source Code (`src/index.js`)

Create the `src/index.js` file and populate it with the core worker script. It handles Spotify library syncing, daily cron scheduling, Telegram webhook callbacks for inline buttons, Gemini LLM analysis using `gemini-3.5-flash-lite`, and interactive HTML card rendering.

---

### 6. Deployment & Webhook Setup

1. Deploy your worker directly to Cloudflare's edge network:
   ```bash
   npx wrangler deploy
   ```
2. Set your Telegram webhook so button clicks route correctly to your worker:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>"
   ```

---

## 🛠 Testing & Monitoring

1. **Initialize State (Optional):**
   If you want the bot to ignore past history and only react to *brand new* likes from the current moment forward, clear the state KV key:
   ```bash
   npx wrangler kv key delete --binding=KV "spotify_state" --remote
   ```

2. **Real-time Logs:**
   Monitor cron executions, webhook callback queries, API responses, and debugging details live:
   ```bash
   npx wrangler tail
   ```

3. **Verify:**
   Like any track in your Spotify app. The worker will pick up the change during its scheduled run (or test manually), deliver the main card with the interactive button to your Telegram chat, and load full artist details on demand!

---

## 📄 License
This project is open-source under the MIT License. Feel free to use and adapt it!