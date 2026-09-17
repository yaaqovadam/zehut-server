const express = require("express");
const cors = require("cors");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const ytDlp = require("yt-dlp-exec");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

app.post("/processAndDeployVideo", async (req, res) => {
  const { url, start, end, title, docId } = req.body;
  if (!url || !docId || !title) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const startSec = parseInt(start) || 0;
  const endSec = parseInt(end) || 15;
  const fileName = `${docId}.mp4`;
  
  const rawFilePath = path.join(os.tmpdir(), `raw_${docId}.mp4`);
  const finalFilePath = path.join(os.tmpdir(), fileName);
  const thumbFilePath = path.join(os.tmpdir(), `${docId}.jpg`);

  try {
    console.log(`Processing ${url} [${startSec}s - ${endSec}s]...`);

    // STEP 1: THE HEIST (Stripped of postprocessorArgs so it doesn't crash on cuts)
    await ytDlp(url, {
      downloadSections: `*${startSec}-${endSec}`,
      format: "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      mergeOutputFormat: "mp4",
      extractorArgs: "youtube:player_client=android",
      rmCacheDir: true,
      proxy: "http://werzukfu-rotate:6e0rz03xvqbj@p.webshare.io:80",
      output: rawFilePath,
      noWarnings: true,
      forceOverwrites: true,
    });

    // 🎯 Bulletproof check: If the file doesn't exist or is an empty shell (< 1000 bytes)
    if (!fs.existsSync(rawFilePath) || fs.statSync(rawFilePath).size < 1000) {
      throw new Error("YouTube blocking or download failed: Resulting file is empty or corrupted.");
    }

    console.log("Generating thumbnail...");
    execSync(`ffmpeg -y -i "${rawFilePath}" -vframes 1 "${thumbFilePath}"`, { stdio: 'inherit' });

    // STEP 2: THE CHOP SHOP (Where all the Baseline & setsar=1 Apple magic actually happens)
    console.log("Checking video dimensions...");
    const dimensions = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${rawFilePath}"`).toString().trim();
    const [vidWidth, vidHeight] = dimensions.split('x').map(Number);
    
    if (vidWidth >= vidHeight) {
      console.log(`Video is Landscape. Applying blur, setsar=1, and Baseline profile...`);
      execSync(`ffmpeg -y -i "${rawFilePath}" -filter_complex "[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=12:12[bg];[0:v]scale=720:1280:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[outv]" -map "[outv]" -map 0:a:0? -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.0 -crf 30 -preset fast -r 30 -c:a aac -b:a 64k -ac 1 -movflags +faststart "${finalFilePath}"`, { stdio: 'inherit' });
    } else {
      console.log(`Video is Portrait. Compressing directly with setsar=1 and Baseline profile...`);
      execSync(`ffmpeg -y -i "${rawFilePath}" -vf "scale=720:-2,setsar=1" -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.0 -crf 30 -preset fast -r 30 -c:a aac -b:a 64k -ac 1 -movflags +faststart "${finalFilePath}"`, { stdio: 'inherit' });
    }

    console.log("Uploading JPG to Cloudflare R2...");
    await s3.send(
      new PutObjectCommand({
        Bucket: "zehut-media",
        Key: `${docId}.jpg`,
        Body: fs.createReadStream(thumbFilePath),
        ContentType: "image/jpeg",
      })
    );

    console.log("Uploading MP4 to Cloudflare R2...");
    await s3.send(
      new PutObjectCommand({
        Bucket: "zehut-media",
        Key: fileName,
        Body: fs.createReadStream(finalFilePath),
        ContentType: "video/mp4",
      })
    );

    console.log("Uploading HTML to Cloudflare R2...");
    const htmlFileName = `${docId}.html`;
    const exactLink = `https://gamfeiglintzadak.co.il/${htmlFileName}`;
    const thumbUrl = `https://pub-142306085f2b48bda4045cd9efdd0d28.r2.dev/${docId}.jpg`;

    const htmlContent = `<!DOCTYPE html>
<html lang="he">
<head>
<base href="/">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${title}</title>
<meta itemprop="image" content="${thumbUrl}">
<meta name="video-id" content="${docId}">
<meta property="og:type" content="website">
<meta property="og:url" content="${exactLink}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="צפו לפני הכל כדי להבין את התמונה המלאה.">
<meta property="og:image" content="${thumbUrl}">
<meta property="og:image:secure_url" content="${thumbUrl}">
<meta property="og:image:type" content="image/jpeg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:url" content="${exactLink}">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="צפו לפני הכל כדי להבין את התמונה המלאה.">
<meta name="twitter:image" content="${thumbUrl}">
<style>body, html { margin: 0; padding: 0; width: 100vw; height: 100vh; background-color: #ffffff; overflow: hidden; }</style>
</head>
<body>
<script>
if ('serviceWorker' in navigator) { navigator.serviceWorker.getRegistrations().then(function(registrations) { for(let registration of registrations) { registration.unregister(); } }); }
if ('caches' in window) { caches.keys().then(function(names) { for (let name of names) { caches.delete(name); } }); }
</script>
<script src="flutter_bootstrap.js?v256" async></script>
</body>
</html>`;

    await s3.send(
      new PutObjectCommand({
        Bucket: "zehut-media",
        Key: htmlFileName,
        Body: htmlContent,
        ContentType: "text/html; charset=utf-8",
      })
    );

    if (fs.existsSync(rawFilePath)) fs.unlinkSync(rawFilePath);
    if (fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
    if (fs.existsSync(thumbFilePath)) fs.unlinkSync(thumbFilePath);
    return res.json({ success: true, fileName });
  } catch (err) {
    console.error("Pipeline error:", err);
    if (fs.existsSync(rawFilePath)) fs.unlinkSync(rawFilePath);
    if (fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
    if (fs.existsSync(thumbFilePath)) fs.unlinkSync(thumbFilePath);
    return res.status(500).json({ error: err.message || "Pipeline failed" });
  }
});

app.post("/generateMissingWaveform", async (req, res) => {
  const { url, docId } = req.body;
  if (!url || !docId) {
    return res.status(400).json({ error: "Missing url or docId." });
  }

  const waveFilePath = path.join(os.tmpdir(), `${docId}_wave.png`);

  try {
    console.log(`Generating waveform for ${docId}...`);

    // FFmpeg streams the audio directly from your R2 URL to draw the picture
    execSync(`ffmpeg -y -i "${url}" -filter_complex "aformat=channel_layouts=mono,compand,showwavespic=s=2000x250:colors=white" -frames:v 1 "${waveFilePath}"`, { stdio: 'inherit' });

    console.log("Uploading Waveform to Cloudflare R2...");
    await s3.send(
      new PutObjectCommand({
        Bucket: "zehut-media",
        Key: `${docId}_wave.png`,
        Body: fs.createReadStream(waveFilePath),
        ContentType: "image/png",
      })
    );

    if (fs.existsSync(waveFilePath)) fs.unlinkSync(waveFilePath);
    return res.json({ success: true, waveUrl: `https://pub-142306085f2b48bda4045cd9efdd0d28.r2.dev/${docId}_wave.png` });
  } catch (err) {
    console.error("Waveform generation error:", err);
    if (fs.existsSync(waveFilePath)) fs.unlinkSync(waveFilePath);
    return res.status(500).json({ error: err.message || "Waveform generation failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
// Fix raw file corruption 1789576202
