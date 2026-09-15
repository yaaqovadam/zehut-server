const ffmpegPath = require("ffmpeg-static");
const ytDlp = require("yt-dlp-exec");
const fs = require("fs");
const path = require("path");

async function testSlice() {
  const testUrl = "https://www.youtube.com/watch?v=tEgFdFMGu6w";
  const output = path.join(__dirname, "test_output.mp4");

  console.log("Testing yt-dlp extraction and cutting...");
  
  try {
    await ytDlp(testUrl, {
      downloadSections: "*15-35",
      mergeOutputFormat: "mp4",
      output: output,
      ffmpegLocation: ffmpegPath,
      noWarnings: true,
      forceOverwrites: true,
    });

    if (fs.existsSync(output)) {
      const stats = fs.statSync(output);
      console.log(`SUCCESS! File created locally. Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`Saved at: ${output}`);
    } else {
      console.log("FAILED: Script finished but file does not exist.");
    }
  } catch (err) {
    console.error("TEST FAILED WITH ERROR:", err.message);
  }
}

testSlice();
