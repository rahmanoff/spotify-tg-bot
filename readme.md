# 🎵 Spotify to Telegram Music Bot

A serverless Telegram bot powered by **Cloudflare Workers** that automatically tracks newly liked tracks in your **Spotify** library, analyzes artists using **Gemini LLM**, and sends rich, informative cards to Telegram.

---

## 🚀 Architecture & Tech Stack

- **Runtime:** [Cloudflare Workers](https://workers.cloudflare.com/) (Serverless edge computing, triggered via Cron Triggers).
- **State Management:** Cloudflare KV (prevents duplicate runs and stores the state of the last processed track).
- **External APIs:**
  - **Spotify Web API** (Fetches liked tracks, album details, and artist metadata).
  - **Google Gemini API (`gemini-3.8-flash`)** (Generates rich artist biographies, top tracks, and top albums).
  - **Telegram Bot API** (Sends formatted HTML info-cards).

---

## 📋 Telegram Card Format

For every newly liked track, the bot generates a message structured as follows:
1. **Track Title & Artists** (with a direct link to Spotify).
2. **Album Name** (or `single` if it's a standalone release) and **Release Year**.
3. **Artist Bios** (includes individual details for every artist in collaborations).
4. **Top Track** & **Top Album** for each artist.

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
crons = ["*/2 * * * *"] # Runs every 2 minutes

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

Create the `src/index.js` file and populate it with the core worker script. It handles Spotify library syncing, lock mechanisms against parallel executions, Gemini LLM analysis with fallback support, and Telegram formatting.

---

### 6. Deployment

Deploy your worker directly to Cloudflare's edge network:

```bash
npx wrangler deploy
```

---

## 🛠 Testing & Monitoring

1. **Initialize State (Optional):**
   If you want the bot to ignore past history and only react to *brand new* likes from the current moment forward, clear the state KV key:
   ```bash
   npx wrangler kv key delete --binding=KV "spotify_state" --remote
   ```

2. **Real-time Logs:**
   Monitor cron executions, API responses, and debugging details live:
   ```bash
   npx wrangler tail
   ```

3. **Verify:**
   Like any track in your Spotify app. Within 2 minutes, the worker will pick up the change, query Spotify and Gemini, and deliver the card straight to your Telegram chat!

---

## 📄 License
This project is open-source under the MIT License. Feel free to use and adapt it!