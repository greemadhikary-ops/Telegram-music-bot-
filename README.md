# 🎵 Telegram YouTube Music Bot

A simple Telegram bot that downloads YouTube audio and sends it as MP3 files.

## Features

- 🎵 Send a YouTube URL → get audio back as MP3
- 🔍 `/play <song name>` → search YouTube & download
- ⚡ Fast conversion using ffmpeg
- 🎨 Beautiful formatted responses with song info

## Requirements

- [Node.js 18+](https://nodejs.org) or [Bun](https://bun.sh)
- [ffmpeg](https://ffmpeg.org) installed on your system

## Setup

### 1. Get a Bot Token

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow the prompts to name your bot
4. Copy the **bot token**

### 2. Install ffmpeg

```bash
# Ubuntu/Debian
sudo apt install ffmpeg

# CentOS/RHEL
sudo yum install ffmpeg

# macOS
brew install ffmpeg
```

### 3. Install Dependencies

```bash
cd telegram-music-bot
bun install
```

### 4. Configure

```bash
cp .env.example .env
```

Edit `.env` and add your bot token:
```
BOT_TOKEN=your_bot_token_here
```

### 5. Run

```bash
bun run dev      # Development (auto-restart)
bun run start    # Production
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Bot introduction |
| `/help` | Show all commands |
| `/play <query>` | Search YouTube & send audio |
| *YouTube URL* | Send a URL directly to download |

## Deploy

You can host this bot for free on:

- **[Railway](https://railway.app)** — Easy deploy with GitHub
- **[Render](https://render.com)** — Free tier available
- **[Koyeb](https://koyeb.com)** — Free serverless deployment
- **Any VPS** — Just run `bun run start`

## Limits

- Max video duration: 10 minutes
- Max file size: 50MB (Telegram limit)

## License

MIT
