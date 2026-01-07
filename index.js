
import express from 'express';
import cors from 'cors';
import https from 'https';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const YTDlpWrap = require('yt-dlp-wrap').default || require('yt-dlp-wrap');
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import os from 'os';
const app = express();
app.set('trust proxy', 1); // REQUIRED for Ngrok/Netlify to correctly generate download links
const PORT = process.env.PORT || 3000;

// ===================== PERMANENT CORS FIX (ALLOW ALL) =====================
const corsOptions = {
    origin: true, // "true" => Reflects the request origin (Allows ANY domain)
    credentials: true, // Allows cookies/headers
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'ngrok-skip-browser-warning']
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
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// ===================== INFO API =====================
app.get('/api/info', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    try {
        console.log(`🔍 Fetching info for: ${url}`);

        // Use yt-dlp-wrap to get metadata
        const output = await ytDlpWrap.getVideoInfo(url);

        // Parse formats
        // yt-dlp 'formats' list is extensive. We need to map to our frontend structure.
        const formats = output.formats || [];

        // 1. Video Formats (filter for mp4/webm with video)
        const videoFormats = formats
            .filter(f => f.vcodec !== 'none' && f.video_ext !== 'none')
            .map(f => ({
                itag: f.format_id, // yt-dlp uses format_id (string)
                qualityLabel: f.format_note || `${f.height}p`,
                container: f.ext,
                size: f.filesize || f.filesize_approx,
                hasAudio: f.acodec !== 'none',
                hasVideo: true,
                height: f.height,
                bitrate: f.tbr
            }))
            .sort((a, b) => (b.height || 0) - (a.height || 0));

        // Deduplicate video formats similar to before
        const uniqueVideoFormats = [];
        const seen = new Set();
        for (const f of videoFormats) {
            const key = `${f.qualityLabel}-${f.container}`;
            if (!seen.has(key)) {
                uniqueVideoFormats.push(f);
                seen.add(key);
            }
        }

        // 2. Audio Formats
        const audioFormats = formats
            .filter(f => f.acodec !== 'none' && f.vcodec === 'none')
            .map(f => ({
                itag: f.format_id,
                bitrate: f.gbr || f.abr, // Audio bitrate
                container: f.ext,
                size: f.filesize || f.filesize_approx,
                qualityLabel: `Audio (${Math.round(f.abr || 0)}kbps)`
            }))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        res.json({
            message: 'Video details fetched successfully!',
            title: output.title,
            thumbnail: output.thumbnail,
            videoFormats: uniqueVideoFormats,
            audioFormats: audioFormats
        });

    } catch (err) {
        console.error('❌ Info Error:', err.message);
        console.error('   STDERR:', err.stderr);
        console.error('   STDOUT:', err.stdout);
        res.status(500).json({ error: 'Failed to fetch video info. Server might be blocked or URL is invalid.' });
    }
});


// ===================== JOB STORE =====================
const downloadJobs = new Map();

// ===================== YT-DLP BINARY PATH =====================
// Detect platform to set correct binary path
const isWindows = process.platform === 'win32';
const possibleBinPath = path.resolve('./yt-dlp' + (isWindows ? '.exe' : ''));

// Function to get the executable
const getYtDlpPath = () => {
    // 1. Try local node_modules (for Vercel/Local)
    if (fs.existsSync(possibleBinPath)) {
        return possibleBinPath;
    }
    // 2. Fallback to just 'yt-dlp' if in PATH
    return 'yt-dlp';
};

// Ensure Binary Exists (Download if missing)
const ensureYtDlpBinary = async () => {
    if (!fs.existsSync(possibleBinPath)) {
        console.log('⚠️ yt-dlp binary not found locally. Downloading from GitHub...');
        try {
            await YTDlpWrap.downloadFromGithub(possibleBinPath);
            console.log('✅ yt-dlp binary downloaded successfully!');
            // Set executable permission on Linux/Mac
            if (!isWindows) {
                fs.chmodSync(possibleBinPath, '755');
            }
        } catch (err) {
            console.error('❌ Failed to download yt-dlp:', err);
        }
    } else {
        console.log('✅ yt-dlp binary found locally.');
    }
};

// Execute the check immediately
await ensureYtDlpBinary();

const ytDlpPath = getYtDlpPath();
console.log(`ℹ️ User determined yt-dlp path: ${ytDlpPath}`);

// Initialize yt-dlp-wrap with resolved binary path (or 'yt-dlp' to use PATH)
const ytDlpWrap = new YTDlpWrap(ytDlpPath);

// ===================== STREAM API (GET) =====================
app.get('/api/stream/:id', (req, res) => {
    const { id } = req.params;
    const job = downloadJobs.get(id);

    if (!job) {
        return res.status(404).send('Link expired or invalid');
    }

    // We do NOT delete the job immediately anymore. 
    // This allows browsers/download managers to make multiple connections or retries.
    // Cleanup is handled by the setTimeout during job creation.

    const { url, videoItag, audioItag, title } = job;
    const safeTitle = (title || 'video').replace(/[^a-z0-9\s-_]/gi, '').trim().replace(/\s+/g, '_');
    const filename = `${safeTitle || 'video'}.mp4`;

    // Headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');

    // Build format selector
    let formatSelector = videoItag;
    if (audioItag) {
        formatSelector = `${videoItag}+${audioItag}`;
    }

    console.log(`🚀 Starting Stream for [${title}]...`);

    // Spawn yt-dlp directly
    // usage: yt-dlp -f format -o - url
    const args = [
        '-f', formatSelector,
        '-o', '-',             // Output to stdout
        '--ffmpeg-location', ffmpegPath,
        '--no-warnings',
        '--no-part',           // Write directly to stdout, no .part files
        '--concurrent-fragments', '4',
        url
    ];

    const stream = ytDlpWrap.execStream(args);

    // Pipe to response
    stream.pipe(res);

    stream.on('error', (err) => {
        console.error('Stream error:', err);
    });

    stream.on('close', () => {
        console.log('🏁 Stream finished (stream closed)');
    });

    // If client disconnects, kill the yt-dlp process
    req.on('close', () => {
        try {
            if (stream && stream.ytDlpProcess && !stream.ytDlpProcess.killed) {
                console.log('❌ Client disconnected, killing download process.');
                stream.ytDlpProcess.kill();
            }
        } catch (e) {
            // ignore
        }
    });
});


// ===================== DOWNLOAD API (POST) =====================
app.post('/api/download', (req, res) => {
    const { url, videoItag, audioItag, title } = req.body;

    console.log(`📥 [${new Date().toISOString()}] Job Received: ${title}`);

    if (!url || !videoItag) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const fileId = uuid();

    // Store job in memory
    downloadJobs.set(fileId, {
        url,
        videoItag,
        audioItag: audioItag || null,
        title
    });

    // Auto-expire link after 5 minutes
    setTimeout(() => {
        if (downloadJobs.has(fileId)) {
            downloadJobs.delete(fileId);
        }
    }, 5 * 60 * 1000);

    const streamUrl = `${req.protocol}://${req.get('host')}/api/stream/${fileId}`;

    // Return immediately
    res.json({
        status: 'tunnel',
        message: 'Download started! Your video is being processed.',
        url: streamUrl,
    });
});


// ===================== START SERVER =====================
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
    console.log(`   (Using yt-dlp-wrap engine)`);
});
