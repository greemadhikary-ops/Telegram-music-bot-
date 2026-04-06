import { Bot, InputFile } from "grammy";
import ytdl from "@distube/ytdl-core";
import ytsr from "ytsr";
import { spawn } from "child_process";
import { existsSync, unlinkSync, mkdirSync, statSync } from "fs";
import { join } from "path";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TMP_DIR = process.env.TMP_DIR || "./tmp";
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

const bot = new Bot(BOT_TOKEN);

// ─── Helpers ──────────────────────────────────────────────────────

function isYTUrl(text: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)/.test(text);
}

function extractVideoId(url: string): string | null {
  const m = url.match(/(?:watch\?v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function cleanupFile(filePath: string) {
  try { unlinkSync(filePath); } catch {}
}

// ─── Search YouTube (direct search, no filters) ───────────────────

async function searchYouTube(query: string): Promise<{ title: string; url: string; duration: string; channel: string } | null> {
  try {
    console.log(`[Search] Query: "${query}"`);

    // Search directly without getFilters (which is broken)
    const results = await ytsr(query, {
      limit: 5,
      gl: "US",
      hl: "en",
    });

    // Find first video result
    const video = results.items.find((item: any) => item.type === "video") as any;

    if (!video || !video.url) {
      console.log("[Search] No video found in results");
      return null;
    }

    console.log(`[Search] Found: "${video.title}" -> ${video.url}`);
    return {
      title: video.title?.substring(0, 100) || "Unknown",
      url: video.url,
      duration: video.duration || "0:00",
      channel: video.author?.name || video.channel?.name || "Unknown",
    };
  } catch (err: any) {
    console.error("[Search] Error:", err.message);
    return null;
  }
}

// ─── Download audio via ytdl-core + ffmpeg ────────────────────────

function downloadAudio(videoId: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[Download] Starting for video: ${videoId}`);

    const stream = ytdl(videoId, {
      quality: "highestaudio",
      filter: "audioonly",
      highWaterMark: 1 << 25, // 32MB buffer
      requestOptions: {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      },
    });

    const ff = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-vn",
      "-acodec", "libmp3lame",
      "-ab", "128k",
      "-ar", "44100",
      "-y",
      outputPath,
    ]);

    stream.pipe(ff.stdin);

    let stderr = "";
    ff.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    ff.on("close", (code: number) => {
      if (code === 0) {
        console.log(`[Download] Done: ${outputPath}`);
        resolve();
      }
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`));
    });
    ff.on("error", (err) => reject(new Error(`ffmpeg error: ${err.message}`)));
    stream.on("error", (err) => reject(new Error(`ytdl stream error: ${err.message}`)));
  });
}

// ─── Get video info with retry ────────────────────────────────────

async function getVideoInfo(videoId: string): Promise<ytdl.videoInfo> {
  console.log(`[Info] Fetching info for: ${videoId}`);
  const info = await ytdl.getInfo(videoId, {
    requestOptions: {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    },
  });
  console.log(`[Info] Title: "${info.videoDetails.title}"`);
  return info;
}

// ─── Process & send audio (shared logic) ──────────────────────────

async function processAndSend(ctx: any, videoUrl: string, waitMsgId: number) {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    return await ctx.api.editMessageText(ctx.chat.id, waitMsgId, "❌ Invalid YouTube URL.");
  }

  let info: ytdl.videoInfo;
  try {
    info = await getVideoInfo(videoId);
  } catch (err: any) {
    console.error("[Info] Error:", err.message);
    return await ctx.api.editMessageText(ctx.chat.id, waitMsgId,
      "❌ Could not get video info.\n\nThe video may be:\n• Age-restricted\n• Private / Unlisted\n• Region-locked\n• Or YouTube has blocked the request.\n\nTry a different video or a direct YouTube link.");
  }

  const title = info.videoDetails.title.replace(/[<>:"/\\|?*]/g, "").substring(0, 100);
  const duration = parseInt(info.videoDetails.lengthSeconds);
  const durationStr = formatDuration(duration);

  if (duration > 600) {
    return await ctx.api.editMessageText(ctx.chat.id, waitMsgId,
      `⚠️ **"${title}"** is too long (${durationStr}).\nMax: 10 minutes.`, { parse_mode: "Markdown" });
  }

  await ctx.api.editMessageText(ctx.chat.id, waitMsgId,
    `📥 Downloading: **${title.substring(0, 60)}**\n⏱ ${durationStr}`, { parse_mode: "Markdown" });

  const outputPath = join(TMP_DIR, `${videoId}.mp3`);

  try {
    await downloadAudio(videoId, outputPath);
  } catch (err: any) {
    console.error("[Download] Error:", err.message);
    cleanupFile(outputPath);
    return await ctx.api.editMessageText(ctx.chat.id, waitMsgId,
      "❌ Download failed. Video may be restricted or ffmpeg is not installed.\n\nMake sure **ffmpeg** is installed: `sudo apt install ffmpeg`");
  }

  const fileSize = statSync(outputPath).size;
  if (fileSize > MAX_FILE_SIZE) {
    cleanupFile(outputPath);
    return await ctx.api.editMessageText(ctx.chat.id, waitMsgId,
      `❌ File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max: 50MB.`);
  }

  await ctx.api.deleteMessage(ctx.chat.id, waitMsgId);

  try {
    await ctx.replyWithAudio(new InputFile(outputPath, `${title}.mp3`), {
      title,
      performer: info.videoDetails.author.name,
      duration,
      caption: `🎵 **${title}**\n⏱ ${durationStr}\n🎤 ${info.videoDetails.author.name}`,
      parse_mode: "Markdown",
    });
    console.log(`[Send] Sent: "${title}" (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);
  } catch (err: any) {
    console.error("[Send] Error:", err.message);
    await ctx.reply("❌ Failed to send audio file. It may be too large for Telegram.");
  }

  cleanupFile(outputPath);
}

// ─── Command: /start ──────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await ctx.reply(
    "🎵 **YouTube Music Bot**\n\n" +
    "Send me a **YouTube link** or use **/play <search>** to get music!\n\n" +
    "📝 **Commands:**\n" +
    "  /play `<song name>` — Search & download\n" +
    "  /help — Show all commands",
    { parse_mode: "Markdown" }
  );
});

// ─── Command: /help ───────────────────────────────────────────────

bot.command("help", async (ctx) => {
  await ctx.reply(
    "🎵 **YouTube Music Bot — Help**\n\n" +
    "🔹 Send a **YouTube URL** directly to download audio\n" +
    "🔹 **/play `<song name>`** — Search YouTube & send audio\n" +
    "🔹 **/start** — Bot introduction\n\n" +
    "⚠️ Max duration: 10 minutes\n" +
    "⚠️ Max file size: 50MB",
    { parse_mode: "Markdown" }
  );
});

// ─── Command: /play ───────────────────────────────────────────────

bot.command("play", async (ctx) => {
  const query = ctx.message.text.replace(/\/play\s*/i, "").trim();
  if (!query) {
    return await ctx.reply("❌ Please provide a song name!\nExample: `/play Blinding Lights`", { parse_mode: "Markdown" });
  }

  const isUrl = isYTUrl(query);
  const waitMsg = await ctx.reply(isUrl ? "📥 Downloading audio..." : "🔍 Searching...");

  if (isUrl) {
    await processAndSend(ctx, query, waitMsg.message_id);
  } else {
    const result = await searchYouTube(query);
    if (!result || !result.url) {
      return await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id,
        "❌ No results found.\n\n💡 Try:\n• A more specific song name\n• Include the artist name\n• Or paste a YouTube URL directly");
    }
    await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id,
      `✅ Found: **${result.title.substring(0, 50)}**\n⏱ ${result.duration}\n🎤 ${result.channel}\n\n📥 Downloading...`, { parse_mode: "Markdown" });
    await processAndSend(ctx, result.url, waitMsg.message_id);
  }
});

// ─── Handle YouTube URLs directly ─────────────────────────────────

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  if (!isYTUrl(text)) return;

  const videoId = extractVideoId(text);
  if (!videoId) return;

  const waitMsg = await ctx.reply("📥 Downloading audio...");
  await processAndSend(ctx, text, waitMsg.message_id);
});

// ─── Start Bot ────────────────────────────────────────────────────

console.log("🎵 YouTube Music Bot starting...");
console.log(`[Config] TMP_DIR: ${TMP_DIR}`);
console.log(`[Config] MAX_FILE_SIZE: ${(MAX_FILE_SIZE / 1024 / 1024)}MB`);

bot.catch((err) => console.error("[Bot] Error:", err));

bot.start({
  onStart: (info) => console.log(`✅ Bot @${info.username} is running!`),
});
