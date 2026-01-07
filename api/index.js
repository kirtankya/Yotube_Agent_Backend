
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
const TEMP_DIR = os.tmpdir(); // Use system temp dir (works on Vercel/Linux and Windows)

// ===================== HELPER =====================
// ===================== YT-DLP BINARY PATH =====================
// Detect platform to set correct binary path
const isWindows = process.platform === 'win32';
const possibleBinPath = path.resolve('./yt-dlp' + (isWindows ? '.exe' : ''));

// Function to get the executable
const getYtDlpPath = () => {
    if (fs.existsSync(possibleBinPath)) return possibleBinPath;
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

// Execute the check limit
await ensureYtDlpBinary();

const ytDlpPath = getYtDlpPath();
console.log(`ℹ️ User determined yt-dlp path: ${ytDlpPath}`);

// Initialize yt-dlp-wrap
const ytDlpWrap = new YTDlpWrap(ytDlpPath);

// ===================== DIAGNOSTIC API =====================
app.get('/api/test', async (req, res) => {
    try {
        console.log('Testing yt-dlp binary execution...');
        // Let the wrapper return version
        const version = await ytDlpWrap.getVersion();
        res.json({
            status: 'ok',
            message: 'yt-dlp is working!',
            version: version,
            cwd: process.cwd(),
            ffmpeg: ffmpegPath
        });
    } catch (error) {
        console.error('Test Failed:', error);
        res.status(500).json({
            status: 'error',
            message: 'yt-dlp failed to run',
            details: error.message,
            cwd: process.cwd(),
            ffmpeg: ffmpegPath
        });
    }
});

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

// ===================== STREAM API (GET) =====================
app.get('/api/stream/:id', (req, res) => {
    const { id } = req.params;
    const job = downloadJobs.get(id);

    if (!job) {
        return res.status(404).send('Link expired or invalid');
    }

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
        '-o', '-',
        '--ffmpeg-location', ffmpegPath,
        '--no-warnings',
        '--no-part',
        '--concurrent-fragments', '4',
        url
    ];

    const stream = ytDlpWrap.execStream(args);
    stream.pipe(res);

    stream.on('error', (err) => {
        console.error('Stream error:', err);
    });

    stream.on('close', () => {
        console.log('🏁 Stream finished (stream closed)');
    });

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

    // Generate robust URL for all environments (Local, Vercel, Ngrok, Render)
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');

    // Ensure https if strictly on production/cloud (optional but safe)
    const finalProtocol = host.includes('localhost') ? protocol : 'https';

    const streamUrl = `${finalProtocol}://${host}/api/stream/${fileId}`;
    console.log(`🔗 Generated Link: ${streamUrl}`);

    // Return immediately
    res.json({
        status: 'tunnel',
        message: 'Download started! Your video is being processed.',
        url: streamUrl,
    });
});


// ===================== START SERVER =====================
// Only listen if run directly (Local dev / Render)
// Vercel handles the listening itself for serverless functions, but this check is safe
if (process.env.NODE_ENV !== 'test') { // just a check, or check if module is main
    app.listen(PORT, () => {
        console.log(`✅ Server running at http://localhost:${PORT}`);
        console.log(`   (Using yt-dlp-wrap engine)`);
    });
}

// Export for Vercel
export default app;
