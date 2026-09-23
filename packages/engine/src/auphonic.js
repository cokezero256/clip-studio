/**
 * Auphonic Simple API client — premium one-click audio mastering.
 * Docs: https://auphonic.com/help/api/simple_api.html
 *
 * Auth: Bearer API key (AUPHONIC_API_KEY). Optional AUPHONIC_PRESET (preset UUID/name)
 * locks your sound (leveler + denoise + -16 LUFS). Without a preset we pass the
 * equivalent algorithm flags inline.
 *
 * Flow: POST /api/simple/productions.json (action=start, input_file) → poll
 * GET /api/production/<uuid>.json until status_string=="Done" → download output file.
 *
 * This is OPT-IN and gated on the API key. When unconfigured, callers fall back to the
 * free local enhancement (highpass + afftdn + loudnorm) in clip-renderer.
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');

const BASE = 'https://auphonic.com/api';

function isConfigured() {
  return !!process.env.AUPHONIC_API_KEY;
}

function authHeaders() {
  return { Authorization: `bearer ${process.env.AUPHONIC_API_KEY}` };
}

/**
 * Enhance a local audio file through Auphonic and write the mastered result to outputPath.
 * Throws if not configured or on API error. Polls up to ~6 minutes.
 *
 * @param {string} inputPath  local audio (wav/mp3/m4a) to master
 * @param {string} outputPath where to write the mastered audio
 * @param {object} [opts]
 * @param {number} [opts.pollMs=5000]   poll interval
 * @param {number} [opts.timeoutMs=360000] give up after this long
 * @param {(s:string)=>void} [opts.log]
 */
async function enhanceAudioFile(inputPath, outputPath, opts = {}) {
  if (!isConfigured()) throw new Error('AUPHONIC_API_KEY is not set.');
  const { pollMs = 5000, timeoutMs = 360000, log = () => {} } = opts;

  // 1) Create + start the production.
  const form = new FormData();
  form.append('action', 'start');
  form.append('title', 'Clip audio enhance');
  form.append('input_file', fs.createReadStream(inputPath), { filename: path.basename(inputPath) });
  if (process.env.AUPHONIC_PRESET) {
    form.append('preset', process.env.AUPHONIC_PRESET);
  } else {
    // No preset → request sensible mastering inline.
    form.append('leveler', 'true');
    form.append('denoise', 'true');
    form.append('normloudness', 'true');
    form.append('loudnesstarget', '-16');
  }
  // Mastered audio output — m4a/aac is small and muxes cleanly back into MP4.
  form.append('output_files', JSON.stringify([{ format: 'aac', ending: 'm4a' }]));

  const createRes = await fetch(`${BASE}/simple/productions.json`, {
    method: 'POST',
    headers: { ...authHeaders(), ...form.getHeaders() },
    body: form,
  });
  if (!createRes.ok) {
    throw new Error(`Auphonic create failed HTTP ${createRes.status}: ${(await createRes.text()).slice(0, 300)}`);
  }
  const created = await createRes.json();
  const uuid = created?.data?.uuid;
  if (!uuid) throw new Error('Auphonic: no production uuid in response.');
  log(`Auphonic production ${uuid} started`);

  // 2) Poll until done.
  const deadline = Date.now() + timeoutMs;
  let prod = created.data;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const pr = await fetch(`${BASE}/production/${uuid}.json`, { headers: authHeaders() });
    if (!pr.ok) throw new Error(`Auphonic poll failed HTTP ${pr.status}`);
    prod = (await pr.json()).data;
    log(`Auphonic status: ${prod.status_string}`);
    if (prod.status_string === 'Done') break;
    if (prod.status_string === 'Error' || prod.status_string === 'Incomplete') {
      throw new Error(`Auphonic production ${prod.status_string}: ${prod.error_message || ''}`);
    }
  }
  if (prod.status_string !== 'Done') throw new Error('Auphonic timed out before completion.');

  // 3) Download the mastered output file.
  const out = (prod.output_files || [])[0];
  const url = out?.download_url;
  if (!url) throw new Error('Auphonic: no output file to download.');
  const dl = await fetch(url, { headers: authHeaders() });
  if (!dl.ok) throw new Error(`Auphonic download failed HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  fs.writeFileSync(outputPath, buf);
  log(`Auphonic output written → ${outputPath}`);
  return outputPath;
}

module.exports = { isConfigured, enhanceAudioFile };
