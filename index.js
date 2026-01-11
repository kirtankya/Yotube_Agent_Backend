import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import yt_dlp from "yt-dlp-exec";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import os from "os";
const app = express();
app.set("trust proxy", 1); // REQUIRED for Ngrok/Netlify to correctly generate download links
const PORT = process.env.PORT || 3000;

// ===================== PERMANENT CORS FIX (ALLOW ALL) =====================
const corsOptions = {
  origin: true, // "true" => Reflects the request origin (Allows ANY domain)
  credentials: true, // Allows cookies/headers
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
    "ngrok-skip-browser-warning",
  ],
};

app.use(cors(corsOptions));

// FIX: Use Regex /(.*)/ instead of '*' to prevent "path-to-regexp" crash
app.options(/(.*)/, cors(corsOptions));

app.use(express.json());

// ===================== TEMP DIR =====================
// ===================== TEMP DIR =====================
const TEMP_DIR = os.tmpdir(); // Use system temp dir (works on Vercel/Linux and Windows)
// No need to ensure exists, system temp always exists

// ===================== HELPER =====================
const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// ===================== INFO API =====================
app.get("/api/info", async (req, res) => {
  const { url } = req.query;

  if (!url || (!url.includes("youtube.com") && !url.includes("youtu.be"))) {
    return res.status(400).json({ error: "Invalid YouTube URL" });
  }

  try {
    const info = await yt_dlp(url, {
      dumpJson: true,
      noWarnings: true,
      userAgent: "Mozilla/5.0",
      referer: "https://www.youtube.com/",
    });

    const formats = info.formats || [];

    const videoFormats = formats
      .filter((f) => f.vcodec !== "none")
      .map((f) => ({
        itag: f.format_id,
        qualityLabel: f.format_note || `${f.height}p`,
        container: f.ext,
        height: f.height,
        hasAudio: f.acodec !== "none",
        size: f.filesize || f.filesize_approx,
      }))
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    const audioFormats = formats
      .filter((f) => f.vcodec === "none" && f.acodec !== "none")
      .map((f) => ({
        itag: f.format_id,
        container: f.ext,
        bitrate: f.abr,
        qualityLabel: `Audio ${Math.round(f.abr || 0)} kbps`,
        size: f.filesize || f.filesize_approx,
      }))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      videoFormats,
      audioFormats,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch video info" });
  }
});

// ===================== JOB STORE =====================
const downloadJobs = new Map();

// ===================== YT-DLP BINARY PATH =====================
// Detect platform to set correct binary path
const isWindows = process.platform === "win32";
const possibleBinPath = path.resolve(
  "./node_modules/yt-dlp-exec/bin/yt-dlp" + (isWindows ? ".exe" : "")
);

// Function to get the executable
const getYtDlpPath = () => {
  // 1. Try local node_modules (for Vercel/Local)
  if (fs.existsSync(possibleBinPath)) {
    return possibleBinPath;
  }
  // 2. Fallback to just 'yt-dlp' if in PATH
  return "yt-dlp";
};

const ytDlpPath = getYtDlpPath();
console.log(`ℹ️ User determined yt-dlp path: ${ytDlpPath}`);

// ===================== STREAM API (GET) =====================
app.get("/api/stream/:id", (req, res) => {
  const job = downloadJobs.get(req.params.id);
  if (!job) return res.status(404).send("Expired");

  const { url, videoItag, audioItag, title } = job;

  const safeTitle = (title || "video")
    .replace(/[^a-z0-9-_ ]/gi, "")
    .replace(/\s+/g, "_");

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeTitle}.mp4"`
  );
  res.setHeader("Content-Type", "video/mp4");

  const format = audioItag ? `${videoItag}+${audioItag}` : videoItag;

  const args = [
    "-f",
    format,
    "--merge-output-format",
    "mp4",
    "-o",
    "-",
    "--no-part",
    "--no-warnings",
    "-N",
    "4",
    url,
  ];

  const child = spawn("yt-dlp", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.pipe(res);

  child.stderr.on("data", () => {});

  req.on("close", () => {
    if (!child.killed) child.kill("SIGKILL");
  });
});

// ===================== DOWNLOAD API (POST) =====================
app.post("/api/download", (req, res) => {
  const { url, videoItag, audioItag, title } = req.body;

  if (!url || !videoItag) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  const id = uuid();

  downloadJobs.set(id, {
    url,
    videoItag,
    audioItag,
    title,
  });

  setTimeout(() => downloadJobs.delete(id), 5 * 60 * 1000);

  res.json({
    url: `${req.protocol}://${req.get("host")}/api/stream/${id}`,
  });
});

// ===================== START SERVER =====================
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`   (Using yt-dlp-exec engine)`);
});
