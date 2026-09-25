const express = require("express");
const cors = require("cors");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const ytDlp = require("yt-dlp-exec");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// INITIALIZE FIREBASE ADMIN
admin.initializeApp();

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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==========================================
// ROUTE 1: VIDEO PROCESSING & R2 DEPLOYMENT
// ==========================================
app.post("/processAndDeployVideo", async (req, res) => {
  const { url, start, end, title, docId } = req.body;
  if (!url || !docId || !title) return res.status(400).json({ error: "Missing required fields." });

  const startSec = parseInt(start) || 0;
  const endSec = parseInt(end) || 15;
  const fileName = `${docId}.mp4`;
  const tempFilePath = path.join(os.tmpdir(), fileName);
  const thumbFilePath = path.join(os.tmpdir(), `${docId}.jpg`);

  try {
    console.log(`Processing ${url} [${startSec}s - ${endSec}s]...`);

    await ytDlp(url, {
      downloadSections: `*${startSec}-${endSec}`,
      format: "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      mergeOutputFormat: "mp4",
      extractorArgs: "youtube:player_client=ios",
      postprocessorArgs: ["-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart"],
      output: tempFilePath,
      noWarnings: true,
      forceOverwrites: true,
    });

    if (!fs.existsSync(tempFilePath)) throw new Error("Download finished but output file not found");

    console.log("Generating thumbnail...");
    execSync(`ffmpeg -i "${tempFilePath}" -ss 00:00:01 -vframes 1 "${thumbFilePath}" -y`);

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
        Body: fs.createReadStream(tempFilePath),
        ContentType: "video/mp4",
      })
    );

    console.log("Uploading HTML to Cloudflare R2...");
    const htmlFileName = `${docId}.html`;
    const exactLink = `https://gamfeiglintzadak.co.il/${htmlFileName}`;
    const thumbUrl = `https://gamfeiglintzadak.co.il/${docId}.jpg`;
    const htmlContent = `<!DOCTYPE html>
<html lang="he">
<head>
<base href="/">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${title}</title>
<meta name="video-id" content="${docId}">
<meta property="og:type" content="website">
<meta property="og:url" content="${exactLink}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="צפו לפני הכל כדי להבין את התמונה המלאה.">
<meta property="og:image" itemprop="image" content="${thumbUrl}">
<meta property="og:image:secure_url" itemprop="image" content="${thumbUrl}">
<meta property="og:image:type" content="image/jpeg">
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

    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    if (fs.existsSync(thumbFilePath)) fs.unlinkSync(thumbFilePath);
    return res.json({ success: true, fileName });
  } catch (err) {
    console.error("Pipeline error:", err);
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    if (fs.existsSync(thumbFilePath)) fs.unlinkSync(thumbFilePath);
    return res.status(500).json({ error: err.message || "Pipeline failed" });
  }
});

// ==========================================
// ROUTE 2: WAVEFORM GENERATION
// ==========================================
app.post("/generateMissingWaveform", async (req, res) => {
  const { url, docId } = req.body;
  if (!url || !docId) return res.status(400).json({ error: "Missing url or docId" });

  const audioFilePath = path.join(os.tmpdir(), `${docId}_wave_audio.mp3`);
  const waveFilePath = path.join(os.tmpdir(), `${docId}_wave.png`);

  try {
    console.log(`Extracting audio for waveform: ${docId}`);
    await ytDlp(url, { extractAudio: true, audioFormat: "mp3", output: audioFilePath, noWarnings: true });

    console.log("Generating waveform image...");
    execSync(`ffmpeg -i "${audioFilePath}" -filter_complex "compand,showwavespic=s=1200x250:colors=cyan" -frames:v 1 "${waveFilePath}" -y`);

    console.log("Uploading waveform to R2...");
    await s3.send(
      new PutObjectCommand({ Bucket: "zehut-media", Key: `${docId}_wave.png`, Body: fs.createReadStream(waveFilePath), ContentType: "image/png" })
    );

    const waveUrl = `https://pub-142306085f2b48bda4045cd9efdd0d28.r2.dev/${docId}_wave.png?v=${Date.now()}`;

    if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    if (fs.existsSync(waveFilePath)) fs.unlinkSync(waveFilePath);

    return res.json({ success: true, waveUrl });
  } catch (err) {
    if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    if (fs.existsSync(waveFilePath)) fs.unlinkSync(waveFilePath);
    return res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROUTE 3: GEMINI CADENCE-MATCHED TRANSCRIPTION
// ==========================================
app.post("/transcribe", async (req, res) => {
  const { url, docId } = req.body;
  if (!url || !docId) return res.status(400).json({ success: false, error: "Missing url or docId" });

  const audioFilePath = path.join(os.tmpdir(), `${docId}_audio.mp3`);

  try {
    console.log(`Extracting audio for transcription: ${docId}...`);
    await ytDlp(url, { extractAudio: true, audioFormat: "mp3", output: audioFilePath, noWarnings: true });

    if (!fs.existsSync(audioFilePath)) throw new Error("Failed to extract audio");

    console.log("Sending MP3 directly to Gemini 1.5 Pro...");
    const audioBytes = fs.readFileSync(audioFilePath).toString("base64");

    const systemPrompt = `
You are a highly specialized rhythmic subtitle sync engine.
Listen to the provided audio. Your objective is to transcribe the spoken text in its original language, translate it to the target language (English if Hebrew, Hebrew if English), and cluster the translated text into chunks that perfectly mirror the pacing, count, and rhythm of the original spoken text.

CRITICAL RULES:
1. The 'sourceArray' must contain the literal, word-for-word transcription of the spoken audio.
2. The 'targetArray' must contain the translation, but it MUST have the exact same number of items as the 'sourceArray'.
3. You must combine or split translated words into phonetic/semantic clusters so they match the spoken cadence of the corresponding index in the source array.

Example (Hebrew to English):
sourceArray: ["היינו", "בבית", "הגדול"]
targetArray: ["We were", "in the house", "that is big"]

Return ONLY a raw JSON object with this exact schema:
{
  "originalLanguage": "hebrew",
  "sourceArray": ["word1", "word2"],
  "targetArray": ["cluster1", "cluster2"]
}
`;

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-pro",
      generationConfig: { responseMimeType: "application/json" }
    });

    const result = await model.generateContent([
      systemPrompt,
      { inlineData: { data: audioBytes, mimeType: "audio/mp3" } }
    ]);

    const parsedData = JSON.parse(result.response.text());

    const hebrewString = parsedData.originalLanguage === 'hebrew' ? parsedData.sourceArray.join(" ") : parsedData.targetArray.join(" ");
    const englishString = parsedData.originalLanguage === 'english' ? parsedData.sourceArray.join(" ") : parsedData.targetArray.join(" ");

    if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);

    return res.json({ success: true, data: { he: hebrewString, en: englishString } });

  } catch (err) {
    console.error("Transcription error:", err);
    if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));