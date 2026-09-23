const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');
const { spawn } = require('child_process');

const FFMPEG = process.env.FFMPEG_BIN || require('ffmpeg-static');
const WHISPER_FILE_LIMIT_BYTES = 25 * 1024 * 1024; // OpenAI Whisper API: 25MB hard limit

function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    // Mono 16kHz Opus in OGG — small enough for ~3 hours under the 25MB limit, fully supported by Whisper.
    const proc = spawn(FFMPEG, [
      '-y',
      '-i', videoPath,
      '-vn',
      '-c:a', 'libopus',
      '-ar', '16000',
      '-ac', '1',
      '-b:a', '32k',
      audioPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve(audioPath);
      else reject(new Error(`ffmpeg audio extract exit ${code}: ${stderr.slice(-1000)}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Transcribe a video file with OpenAI Whisper API, returning word-level timestamps.
 * Returns the raw verbose_json shape: { text, segments: [...], words: [...], language, duration }
 */
async function transcribe(videoPath, { language = 'en', workDir } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Add it to .env.');
  }

  const audioPath = path.join(workDir, `whisper-input-${Date.now()}.ogg`);
  await extractAudio(videoPath, audioPath);

  try {
    const stat = fs.statSync(audioPath);
    if (stat.size > WHISPER_FILE_LIMIT_BYTES) {
      throw new Error(
        `Extracted audio is ${(stat.size / 1024 / 1024).toFixed(1)}MB, over Whisper's 25MB limit. ` +
        `Source video is too long; chunk-and-merge transcription is not implemented yet.`
      );
    }

    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), { filename: 'audio.ogg' });
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    if (language) form.append('language', language);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Whisper API HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = await response.json();
    return data;
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }
}

module.exports = { transcribe };
