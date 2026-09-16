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
  const rawFilePath = path.join(os.tmpdir(), `raw_${fileName}`);
  const finalFilePath = path.join(os.tmpdir(), fileName);
  const thumbFilePath = path.join(os.tmpdir(), `${docId}.jpg`);

  try {
    console.log(`Processing ${url} [${startSec}s - ${endSec}s]...`);

    // 🎯 STEP 1: DUMB, FAST DOWNLOAD (Under the radar)
    await ytDlp(url, {
      downloadSections: `*${startSec}-${endSec}`,
      format: "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      mergeOutputFormat: "mp4",
      extractorArgs: "youtube:player_client=android", // The proven winner
      rmCacheDir: true,
      output: rawFilePath,
      noWarnings: true,
      forceOverwrites: true,
    });

    if (!fs.existsSync(rawFilePath)) {
      throw new Error("Raw download finished but output file not found");
    }

    console.log("Compressing and scaling to 720p via FFmpeg...");
    // 🎯 STEP 2: STANDALONE COMPRESSION (No YouTube API calls)
    execSync(`ffmpeg -i "${rawFilePath}" -vf "scale=-2:720" -c:v libx264 -crf 28 -preset faster -r 30 -c:a aac -b:a 64k -ac 1 -movflags +faststart "${finalFilePath}" -y`);

    console.log("Generating thumbnail...");
    execSync(`ffmpeg -i "${finalFilePath}" -ss 00:00:01 -vframes 1 -vf "scale=854:-1" -q:v 5 "${thumbFilePath}" -y`);

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

<!-- SCHEMA.ORG TAG -->
<meta itemprop="image" content="${thumbUrl}">

<!-- OPEN GRAPH / FACEBOOK / WHATSAPP TAGS -->
<meta name="video-id" content="${docId}">
<meta property="og:type" content="website">
<meta property="og:url" content="${exactLink}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="צפו לפני הכל כדי להבין את התמונה המלאה.">
<meta property="og:image" content="${thumbUrl}">
<meta property="og:image:secure_url" content="${thumbUrl}">
<meta property="og:image:type" content="image/jpeg">

<!-- TWITTER TAGS -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:url" content="${exactLink}">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="צפו לפני הכל כדי להבין את התמונה המלאה.">
<meta name="twitter:image" content="${thumbUrl}">

<style>
body, html { margin: 0; padding: 0; width: 100vw; height: 100vh; background-color: #ffffff; overflow: hidden; }
</style>
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
