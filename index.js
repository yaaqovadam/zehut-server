const express = require("express");
const cors = require("cors");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const ytDlp = require("yt-dlp-exec");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");

admin.initializeApp();

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

app.get("/", (req, res) => res.status(200).send("Zehut Server Active"));

app.get("/models", async (req, res) => {
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + process.env.GEMINI_API_KEY);
    const data = await r.json();
    const models = (data.models || []).map(m => ({
      name: m.name,
      methods: m.supportedGenerationMethods
    }));
    res.json({ count: models.length, models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const s3 = new S3Client({
  region: "auto",
  endpoint: "https://" + process.env.R2_ACCOUNT_ID + ".r2.cloudflarestorage.com",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ROUTE 1: VIDEO PROCESSING & R2 DEPLOYMENT
app.post("/processAndDeployVideo", async (req, res) => {
  const { url, start, end, title, docId } = req.body;
  if (!url || !docId || !title) return res.status(400).json({ error: "Missing required fields." });

  const startSec = parseInt(start) || 0;
  const endSec = parseInt(end) || 15;
  const fileName = docId + ".mp4";
  const tempFilePath = path.join(os.tmpdir(), fileName);
  const thumbFilePath = path.join(os.tmpdir(), docId + ".jpg");

  try {
    await ytDlp(url, {
      downloadSections: "*" + startSec + "-" + endSec,
      format: "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      mergeOutputFormat: "mp4",
      extractorArgs: "youtube:player_client=ios",
      postprocessorArgs: ["-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart"],
      output: tempFilePath,
      noWarnings: true,
      forceOverwrites: true,
    });

    if (!fs.existsSync(tempFilePath)) throw new Error("Download finished but output file not found");

    execSync('ffmpeg -i "' + tempFilePath + '" -ss 00:00:01 -vframes 1 "' + thumbFilePath + '" -y');

    await s3.send(
      new PutObjectCommand({
        Bucket: "zehut-media",
        Key: docId + ".jpg",
        Body: fs.createReadStream(thumbFilePath),
        ContentType: "image/jpeg",
      })
    );

    await s3.send(
      new PutObjectCommand({
        Bucket: "zehut-media",
        Key: fileName,
        Body: fs.createReadStream(tempFilePath),
        ContentType: "video/mp4",
      })
    );

    const htmlFileName = docId + ".html";
    const exactLink = "https://gamfeiglintzadak.co.il/" + htmlFileName;
    const thumbUrl = "https://gamfeiglintzadak.co.il/" + docId + ".jpg";
    const htmlContent = [
      '<!DOCTYPE html>',
      '<html lang="he">',
      '<head>',
      '<base href="/">',
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">',
      '<meta name="color-scheme" content="dark">',
      '<title>' + title + '</title>',
      '<meta name="video-id" content="' + docId + '">',
      '<meta property="og:type" content="website">',
      '<meta property="og:url" content="' + exactLink + '">',
      '<meta property="og:title" content="' + title + '">',
      '<meta property="og:description" content="צפו לפני הכל כדי להבין את התמונה המלאה.">',
      '<meta property="og:image" itemprop="image" content="' + thumbUrl + '">',
      '<meta property="og:image:secure_url" itemprop="image" content="' + thumbUrl + '">',
      '<meta property="og:image:type" content="image/jpeg">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:url" content="' + exactLink + '">',
      '<meta name="twitter:title" content="' + title + '">',
      '<meta name="twitter:description" content="צפו לפני הכל כדי להבין את התמונה המלאה.">',
      '<meta name="twitter:image" content="' + thumbUrl + '">',
      '<style>body, html { margin: 0; padding: 0; width: 100vw; height: 100vh; background-color: #ffffff; overflow: hidden; }</style>',
      '</head>',
      '<body>',
      '<script>',
      "if ('serviceWorker' in navigator) { navigator.serviceWorker.getRegistrations().then(function(registrations) { for(let registration of registrations) { registration.unregister(); } }); }",
      '</script>',
      '<script src="flutter_bootstrap.js?v256" async></script>',
      '</body>',
      '</html>'
    ].join("\n");

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
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    if (fs.existsSync(thumbFilePath)) fs.unlinkSync(thumbFilePath);
    return res.status(500).json({ error: err.message || "Pipeline failed" });
  }
});

// ROUTE 2: WAVEFORM GENERATION
app.post("/generateMissingWaveform", async (req, res) => {
  const { url, docId } = req.body;
  if (!url || !docId) return res.status(400).json({ error: "Missing url or docId" });

  const audioFilePath = path.join(os.tmpdir(), docId + "_wave_audio.mp3");
  const waveFilePath = path.join(os.tmpdir(), docId + "_wave.png");

  try {
    await ytDlp(url, { extractAudio: true, audioFormat: "mp3", output: audioFilePath, noWarnings: true });
    execSync('ffmpeg -i "' + audioFilePath + '" -filter_complex "compand,showwavespic=s=1200x250:colors=cyan" -frames:v 1 "' + waveFilePath + '" -y');

    await s3.send(
      new PutObjectCommand({ Bucket: "zehut-media", Key: docId + "_wave.png", Body: fs.createReadStream(waveFilePath), ContentType: "image/png" })
    );

    const waveUrl = "https://pub-142306085f2b48bda4045cd9efdd0d28.r2.dev/" + docId + "_wave.png?v=" + Date.now();

    if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    if (fs.existsSync(waveFilePath)) fs.unlinkSync(waveFilePath);

    return res.json({ success: true, waveUrl });
  } catch (err) {
    if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    if (fs.existsSync(waveFilePath)) fs.unlinkSync(waveFilePath);
    return res.status(500).json({ error: err.message });
  }
});

// ROUTE 3: GEMINI CADENCE-MATCHED & TIMESTAMP-LOCKED TRANSCRIPTION (1-6 WORDS/ROW)
app.post("/transcribe", async (req, res) => {
  const { url, docId } = req.body;
  if (!url || !docId) return res.status(400).json({ success: false, error: "Missing url or docId" });

  const audioFilePath = path.join(os.tmpdir(), docId + "_audio.mp3");

  try {
    await ytDlp(url, { extractAudio: true, audioFormat: "mp3", output: audioFilePath, noWarnings: true });
    if (!fs.existsSync(audioFilePath)) throw new Error("Failed to extract audio");

    const audioBytes = fs.readFileSync(audioFilePath).toString("base64");
    const systemPrompt = [
      "You are a precision rhythmic subtitle-sync engine.",
      "Listen to the ENTIRE audio clip from 0:00 all the way to the very last second. Do NOT stop early, skip, or summarize any part of the speech.",
      "CRITICAL RULES:",
      "1. Transcribe 100% of the spoken audio from beginning to end into natural subtitle rows of 1 to 6 words maximum per row (blocks).",
      "2. For every single block, the Hebrew phrase (he) and the English phrase (en) MUST have the EXACT SAME number of space-separated words (1 to 6 words). If a translation naturally needs an extra word, condense it or hyphenate two words (e.g., gone-crazy, right-wing, know-from) so the space-separated word count matches 1-to-1.",
      "3. Provide exact start and end timestamps in seconds (e.g., 0.5, 2.8) for each block matching the exact moment those words are spoken.",
      "Return ONLY a raw JSON object with this exact schema:",
      '{"originalLanguage":"hebrew","blocks":[{"start":0.5,"end":2.8,"he":"ויש להם עדות יודעים של מי?","en":"They have testimony know-from whom?"}]}'
    ].join("\n");

    const model = genAI.getGenerativeModel({
      model: "gemini-3.6-flash",
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 65536,
        temperature: 0.1,
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    const result = await model.generateContent([
      systemPrompt,
      { inlineData: { data: audioBytes, mimeType: "audio/mp3" } }
    ]);

    const parsedData = JSON.parse(result.response.text());
    const blocks = Array.isArray(parsedData.blocks) ? parsedData.blocks : [];

    const hebrewString = blocks.map(b => (b.he || "").trim()).filter(Boolean).join(" ");
    const englishString = blocks.map(b => (b.en || "").trim()).filter(Boolean).join(" ");

    if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    return res.json({
      success: true,
      data: {
        he: hebrewString,
        en: englishString,
        blocks: blocks
      }
    });
  } catch (err) {
    if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    return res.status(500).json({ success: false, error: err.message });
  }
});


function compressToJpg60(inputBuffer, prefix) {
  const inPath = path.join(os.tmpdir(), prefix + "_in.img");
  const outPath = path.join(os.tmpdir(), prefix + "_out.jpg");
  try {
    fs.writeFileSync(inPath, inputBuffer);
    // -q:v 14 in ffmpeg mjpeg encoder corresponds to ~60% JPEG quality
    execSync('ffmpeg -y -i "' + inPath + '" -vf "scale=1080:-1" -q:v 14 "' + outPath + '"', { stdio: "ignore" });
    const compressed = fs.readFileSync(outPath);
    if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    return compressed;
  } catch (e) {
    if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    return inputBuffer;
  }
}

// ROUTE 4: THUMBNAIL UPLOAD TO R2
app.post("/uploadThumbnail", async (req, res) => {
  const { docId, fileName, imageBase64 } = req.body;
  const targetPrefix = (docId || fileName || "").replace(/\.(jpg|jpeg|png|mp4|html)$/i, "").trim();
  if (!targetPrefix || !imageBase64) {
    return res.status(400).json({ error: "Missing docId/fileName or imageBase64" });
  }

  const exactJpgName = targetPrefix + ".jpg";

  try {
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const rawBuffer = Buffer.from(cleanBase64, "base64");
    const buffer = compressToJpg60(rawBuffer, "thumb_" + Date.now());
    console.log("Compressed R2 thumbnail from " + Math.round(rawBuffer.length/1024) + "KB to " + Math.round(buffer.length/1024) + "KB");

    await s3.send(
      new PutObjectCommand({
        Bucket: "zehut-media",
        Key: exactJpgName,
        Body: buffer,
        ContentType: "image/jpeg",
      })
    );

    const thumbUrl = "https://pub-142306085f2b48bda4045cd9efdd0d28.r2.dev/" + exactJpgName;
    return res.json({ success: true, fileName: exactJpgName, thumbUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ROUTE 5: REAL GOOGLE AI IMAGE GENERATOR
app.post("/generateAiImage", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  const apiKey = process.env.GEMINI_API_KEY;
  const errors = [];

  try {
    const listResp = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + apiKey);
    const listData = await listResp.json();
    const allModels = listData.models || [];

    const geminiImageModels = allModels
      .filter(m => m.name.includes("image") && (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace("models/", ""));

    const imagenModels = allModels
      .filter(m => m.name.includes("imagen") && (m.supportedGenerationMethods || []).includes("predict"))
      .map(m => m.name.replace("models/", ""));

    const geminiCandidates = [...new Set([
      "gemini-nano-banana-2.1", "gemini-3.1-flash-image", "gemini-3-pro-image", ...geminiImageModels,
      "nano-banana-pro-preview", "gemini-nano-banana-2.1", "gemini-2.5-flash-image-preview",
      "gemini-2.0-flash-preview-image-generation",
      "gemini-2.0-flash-exp-image-generation",
      "gemini-2.0-flash-exp"
    ])];

    const imagenCandidates = [...new Set([
      ...imagenModels,
      "imagen-3.0-generate-002",
      "imagen-3.0-generate-001",
      "imagen-3.0-fast-generate-001"
    ])];

    const fullPrompt = "Generate a high-contrast, ultra-crisp, photorealistic image (NO text, NO letters, NO words anywhere in the image): " + prompt;

    for (const modelName of geminiCandidates) {
      try {
        const resp = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + modelName + ":generateContent?key=" + apiKey,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: fullPrompt }] }],
              generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
            }),
          }
        );
        const json = await resp.json();
        if (resp.ok) {
          const parts = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
          const imgPart = parts.find(p => p.inlineData && p.inlineData.data);
          if (imgPart) {
            const rawAiBuf = Buffer.from(imgPart.inlineData.data, "base64");
            const compAiBuf = compressToJpg60(rawAiBuf, "ai_" + Date.now());
            console.log("Compressed AI image from " + Math.round(rawAiBuf.length/1024) + "KB to " + Math.round(compAiBuf.length/1024) + "KB");
            return res.json({ success: true, imageBase64: compAiBuf.toString("base64"), provider: modelName });
          }
        } else {
          errors.push(modelName + ": " + ((json.error && json.error.message) || resp.status));
        }
      } catch (e) {
        errors.push(modelName + ": " + e.message);
      }
    }

    for (const modelName of imagenCandidates) {
      try {
        const resp = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + modelName + ":predict?key=" + apiKey,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              instances: [{ prompt: fullPrompt }],
              parameters: { sampleCount: 1, aspectRatio: "1:1" },
            }),
          }
        );
        const json = await resp.json();
        if (resp.ok) {
          const b64 = json.predictions && json.predictions[0] && json.predictions[0].bytesBase64Encoded;
          if (b64) {
            return res.json({ success: true, imageBase64: b64, provider: modelName });
          }
        } else {
          errors.push(modelName + ": " + ((json.error && json.error.message) || resp.status));
        }
      } catch (e) {
        errors.push(modelName + ": " + e.message);
      }
    }

    return res.status(500).json({ error: "No Google Image models succeeded on this key.", details: errors });
  } catch (err) {
    return res.status(500).json({ error: err.message, details: errors });
  }
});

app.post("/syncHtmlBatch", async (req, res) => { try { await Promise.all(req.body.files.map(f => s3.send(new PutObjectCommand({ Bucket: "zehut-media", Key: f.name, Body: f.content, ContentType: "text/html; charset=utf-8" })))); res.json({ success: true, count: req.body.files.length }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ==========================================
// ROUTE 7: REAL HUMAN VISITOR ANALYTICS (R2 BACKED)
// ==========================================
let memStats = null;

async function loadStatsFromR2() {
  if (memStats) return memStats;
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: "zehut-media", Key: "_site_stats.json" }));
    const str = await resp.Body.transformToString();
    memStats = JSON.parse(str);
  } catch (_) {
    memStats = { totalSessions: 0, uniqueVisitors: 0, dailyUnique: {}, dailySessions: {}, pages: {} };
  }
  return memStats;
}

async function saveStatsToR2(stats) {
  memStats = stats;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: "zehut-media",
      Key: "_site_stats.json",
      Body: JSON.stringify(stats),
      ContentType: "application/json"
    }));
  } catch (e) {
    console.error("Stats save error:", e.message);
  }
}

app.post("/hitVisit", async (req, res) => {
  try {
    const { isNewEver, isNewToday, page } = req.body || {};
    const stats = await loadStatsFromR2();
    const today = new Date().toISOString().slice(0, 10);

    stats.totalSessions = (stats.totalSessions || 0) + 1;
    if (isNewEver) stats.uniqueVisitors = (stats.uniqueVisitors || 0) + 1;

    stats.dailySessions = stats.dailySessions || {};
    stats.dailySessions[today] = (stats.dailySessions[today] || 0) + 1;

    stats.dailyUnique = stats.dailyUnique || {};
    if (isNewToday) {
      stats.dailyUnique[today] = (stats.dailyUnique[today] || 0) + 1;
    }

    if (page) {
      stats.pages = stats.pages || {};
      stats.pages[page] = (stats.pages[page] || 0) + 1;
    }

    await saveStatsToR2(stats);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/getStats", async (req, res) => {
  try {
    const stats = await loadStatsFromR2();
    const today = new Date().toISOString().slice(0, 10);
    return res.json({
      totalUnique: stats.uniqueVisitors || 0,
      totalSessions: stats.totalSessions || 0,
      todayUnique: (stats.dailyUnique && stats.dailyUnique[today]) || 0,
      todaySessions: (stats.dailySessions && stats.dailySessions[today]) || 0,
      pages: stats.pages || {}
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Listening on port " + PORT));