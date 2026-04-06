import { Bot, InputFile } from "grammy";
import ytdl from "ytdl-core";
import ytsr from "ytsr";
import { spawn } from "child_process";
import { existsSync, unlinkSync, mkdirSync, statSync } from "fs";
import { join } from "path";

const BOT_TOKEN = process.env.BOT_TOKEN || "8617936912:AAHi-SDAaO1lkhWerCFW8W3QMRUhmO0TB4Y";
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

async function searchYouTube(query: string): Promise<{ title: string; url: string; duration: string; channel: string } | null> {
  try {
    const filters = await ytsr.getFilters(query);
    const filter = filters.get("Type")?.get("Video");
    if (!filter) return null;

    const results = await ytsr(filter.url, { limit: 1 });
    if (!results.items.length) return null;

    const v = results.items[0] as any;
    return {
      title: v.title?.substring(0, 100) || "Unknown",
      url: v.url || "",
      duration: v.duration || "0:00",
      channel: v.author?.name || "Unknown",
    };
  } catch (err: any) {
    console.error("Search error:", err.message);
    return null;
  }
}

function downloadAudio(videoId: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = ytdl(videoId, { quality: "highestaudio", filter: "audioonly" });
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
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`));
    });
    ff.on("error", reject);
    stream.on("error", reject);
  });
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

  let videoUrl: string;

  if (isUrl) {
    videoUrl = query;
  } else {
    const result = await searchYouTube(query);
    if (!result || !result.url) {
      return await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, "❌ No results found.");
    }
    videoUrl = result.url;
  }

  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    return await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, "❌ Invalid YouTube URL.");
  }

  try {
    const info = await ytdl.getInfo(videoId);
    const title = info.videoDetails.title.replace(/[<>:"/\\|?*]/g, "").substring(0, 100);
    const duration = parseInt(info.videoDetails.lengthSeconds);
    const durationStr = formatDuration(duration);

    if (duration > 600) {
      return await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id,
        `⚠️ **"${title}"** is too long (${durationStr}).\nMax: 10 minutes.`, { parse_mode: "Markdown" });
    }

    await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id,
      `📥 Downloading: **${title.substring(0, 60)}**\n⏱ ${durationStr}`, { parse_mode: "Markdown" });

    const outputPath = join(TMP_DIR, `${videoId}.mp3`);
    await downloadAudio(videoId, outputPath);

    const fileSize = statSync(outputPath).size;
    if (fileSize > MAX_FILE_SIZE) {
      cleanupFile(outputPath);
      return await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id,
        `❌ File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max: 50MB.`);
    }

    await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id);

    await ctx.replyWithAudio(new InputFile(outputPath, `${title}.mp3`), {
      title,
      performer: "YouTube Music",
      duration,
      caption: `🎵 **${title}**\n⏱ ${durationStr}`,
      parse_mode: "Markdown",
    });

    cleanupFile(outputPath);
  } catch (err: any) {
    console.error("Play error:", err.message);
    try {
      await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id,
        "❌ Failed to download. Video may be restricted or unavailable.");
    } catch {}
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

  try {
    const info = await ytdl.getInfo(videoId);
    const title = info.videoDetails.title.replace(/[<>:"/\\|?*]/g, "").substring(0, 100);
    const duration = parseInt(info.videoDetails.lengthSeconds);
    const durationStr = formatDuration(duration);

    if (duration > 600) {
      return await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id,
        `⚠️ Video is too long (${durationStr}). Max: 10 minutes.`);
    }

    await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id,
      `📥 Downloading: **${title.substring(0, 60)}**\n⏱ ${durationStr}`, { parse_mode: "Markdown" });

    const outputPath = join(TMP_DIR, `${videoId}.mp3`);
    await downloadAudio(videoId, outputPath);

    const fileSize = statSync(outputPath).size;
    if (fileSize > MAX_FILE_SIZE) {
      cleanupFile(outputPath);
      return await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id,
        `❌ File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max: 50MB.`);
    }

    await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id);

    await ctx.replyWithAudio(new InputFile(outputPath, `${title}.mp3`), {
      title,
      performer: "YouTube Music",
      duration,
      caption: `🎵 **${title}**\n⏱ ${durationStr}`,
      parse_mode: "Markdown",
    });

    cleanupFile(outputPath);
  } catch (err: any) {
    console.error("URL handler error:", err.message);
    try {
      await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id,
        "❌ Failed to download. Video may be restricted or unavailable.");
    } catch {}
  }
});

// ─── Start Bot ────────────────────────────────────────────────────

console.log("🎵 YouTube Music Bot starting...");
bot.catch((err) => console.error("Bot error:", err));

bot.start({
  onStart: (info) => console.log(`✅ Bot @${info.username} is running!`),
});
  
