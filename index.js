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

    // STEP 1: THE HEIST (Now with Subtitle Extraction)
    await ytDlp(url, {
      downloadSections: `*${startSec}-${endSec}`,
      format: "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      mergeOutputFormat: "mp4",
      extractorArgs: "youtube:player_client=android",
      rmCacheDir: true,
      proxy: "http://werzukfu-rotate:6e0rz03xvqbj@p.webshare.io:80",
      postprocessorArgs: [
        "-c:v", "copy",
        "-c:a", "aac",
        "-movflags", "+faststart"
      ],
      output: rawFilePath,
      noWarnings: true,
      forceOverwrites: true,
      writeAutoSubs: true, // Pulls the YouTube auto-captions
      subLangs: "en",      // Specifically requests English
    });

    if (!fs.existsSync(rawFilePath)) {
      throw new Error("Download finished but raw output file not found");
    }

    // Locate the downloaded subtitle file (yt-dlp usually saves as .vtt or .srt)
    const vttFilePath = path.join(os.tmpdir(), `raw_${docId}.en.vtt`);
    const srtFilePath = path.join(os.tmpdir(), `raw_${docId}.en.srt`);
    const subFilePath = fs.existsSync(vttFilePath) ? vttFilePath : (fs.existsSync(srtFilePath) ? srtFilePath : null);
    const hasSubs = subFilePath !== null;
    
    if (hasSubs) console.log(`English subtitles found and locked in: ${subFilePath}`);
    else console.log("No English auto-subs found for this clip, proceeding without text.");

    console.log("Generating thumbnail...");
    execSync(`ffmpeg -y -i "${rawFilePath}" -ss 00:00:01 -frames:v 1 -update 1 "${thumbFilePath}"`, { stdio: 'inherit' });

    // STEP 2: THE CHOP SHOP (Dynamic Filter Graph for Subtitles)
    console.log("Checking video dimensions...");
    const dimensions = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${rawFilePath}"`).toString().trim();
    const [vidWidth, vidHeight] = dimensions.split('x').map(Number);
    
    if (vidWidth >= vidHeight) {
      console.log(`Video is Landscape. Applying 12:12 blur and formatting...`);
      
      // Build the base blur layout
      let filter = `[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=12:12[bg];[0:v]scale=720:1280:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
      
      // If subs exist, chain them over the blurred layout, ~15px below the video
      if (hasSubs) {
        filter += `[v1];[v1]subtitles='${subFilePath}':force_style='Fontname=Arial,Fontsize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1,Shadow=2,MarginV=420,Alignment=2'`;
      }
      filter += `[outv]`;
      
      execSync(`ffmpeg -y -i "${rawFilePath}" -filter_complex "${filter}" -map "[outv]" -map 0:a? -c:v libx264 -pix_fmt yuv420p -profile:v main -crf 30 -preset fast -r 30 -c:a aac -b:a 64k -ac 1 -movflags +faststart "${finalFilePath}"`, { stdio: 'inherit' });
    } else {
      console.log(`Video is Portrait. Compressing directly...`);
      
      let filter = `scale=720:-2`;
      // If portrait, push the subs down to the very bottom of the screen
      if (hasSubs) {
        filter += `,subtitles='${subFilePath}':force_style='Fontname=Arial,Fontsize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1,Shadow=2,MarginV=60,Alignment=2'`;
      }
      
      execSync(`ffmpeg -y -i "${rawFilePath}" -vf "${filter}" -c:v libx264 -pix_fmt yuv420p -profile:v main -crf 30 -preset fast -r 30 -c:a aac -b:a 64k -ac 1 -movflags +faststart "${finalFilePath}"`, { stdio: 'inherit' });
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

    // Deep clean all temp files
    if (fs.existsSync(rawFilePath)) fs.unlinkSync(rawFilePath);
    if (fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
    if (fs.existsSync(thumbFilePath)) fs.unlinkSync(thumbFilePath);
    if (subFilePath && fs.existsSync(subFilePath)) fs.unlinkSync(subFilePath);
    
    return res.json({ success: true, fileName });
  } catch (err) {
    console.error("Pipeline error:", err);
    if (fs.existsSync(rawFilePath)) fs.unlinkSync(rawFilePath);
    if (fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
    if (fs.existsSync(thumbFilePath)) fs.unlinkSync(thumbFilePath);
    // Use a try-catch for the dynamic sub variable in error handling
    try { 
      const errSubPath = path.join(os.tmpdir(), `raw_${docId}.en.vtt`);
      if (fs.existsSync(errSubPath)) fs.unlinkSync(errSubPath);
    } catch(e) {}
    
    return res.status(500).json({ error: err.message || "Pipeline failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
// Subtitle ping 1789561665
