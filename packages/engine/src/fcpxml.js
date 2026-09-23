const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Express T seconds as an FCPXML rational on the source frame rate.
 * For 29.97 (30000/1001), 1 frame = "1001/30000s", 100 frames = "100100/30000s".
 * For integer seconds, returns "Ns" (cleaner; both forms are valid).
 */
function rational(seconds, fps_num, fps_den) {
  if (seconds === 0) return '0s';
  const fps = fps_num / fps_den;
  const frames = Math.round(seconds * fps);
  // numerator = frames * fps_den, denominator = fps_num
  // simplifies to integer seconds when divisible
  const num = frames * fps_den;
  const den = fps_num;
  if (num % den === 0) return `${num / den}s`;
  return `${num}/${den}s`;
}

/**
 * Build a minimal-but-correct FCPXML 1.10 timeline.
 *
 * @param {object} opts
 * @param {string} opts.projectName       — shows up in Premiere as the imported timeline's name
 * @param {string} opts.sourceFileName    — basename of the source MP4, e.g. "source.mp4"
 * @param {object} opts.probe             — ffprobe result: { fps_num, fps_den, width, height, duration_seconds, audio_sample_rate, audio_channels }
 * @param {Array}  opts.keepSegments      — [{ start_seconds, end_seconds }] in source-timeline order
 * @returns {string} FCPXML document
 *
 * Path strategy: src="file://./<sourceFileName>" — relative URL, resolved against the FCPXML's
 * own location. Premiere/Resolve re-link automatically as long as source is dropped alongside.
 *
 * Cut model: each kept segment becomes one <asset-clip> on the spine. This is straight-cuts —
 * J/L cut OFFSETS are documented in audit.md so the editor applies them with a rolling edit
 * in Premiere (30 seconds of work). FCPXML J/L via separate <video>+<audio> lanes is fragile
 * across Premiere versions; we don't ship it in v1.
 */
function buildFcpxml(opts) {
  const { projectName, sourceFileName, probe, keepSegments } = opts;
  const { fps_num, fps_den, width, height, audio_sample_rate, audio_channels } = probe;

  if (!keepSegments.length) throw new Error('FCPXML: keepSegments is empty');

  const formatId = 'r1';
  const assetId = 'r2';
  const formatName = `mozzo-${width}x${height}-${(fps_num / fps_den).toFixed(2).replace('.', '_')}`;
  const frameDuration = rational(fps_den / fps_num, fps_num, fps_den); // one frame
  const sourceDurationSec = probe.duration_seconds;
  const audioRateAttr = audio_sample_rate ? Math.round(audio_sample_rate / 1000) + 'k' : '48k';
  const audioLayout = (audio_channels || 2) === 1 ? 'mono' : 'stereo';

  // Compute spine clip placements
  let spineCursor = 0;
  const clips = keepSegments.map((seg, i) => {
    const startInSrc = rational(seg.start_seconds, fps_num, fps_den);
    const dur = seg.end_seconds - seg.start_seconds;
    const durRat = rational(dur, fps_num, fps_den);
    const offsetRat = rational(spineCursor, fps_num, fps_den);
    spineCursor += dur;
    return {
      name: `seg${i + 1}`,
      ref: assetId,
      offset: offsetRat,
      start: startInSrc,
      duration: durRat,
    };
  });

  const totalDurationRat = rational(spineCursor, fps_num, fps_den);
  const sourceDurationRat = rational(sourceDurationSec, fps_num, fps_den);
  const escapedSrc = `file://./${encodeURIComponent(sourceFileName)}`;
  const safeProjectName = escapeXml(projectName);

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE fcpxml>');
  lines.push('<fcpxml version="1.10">');
  lines.push('  <resources>');
  lines.push(
    `    <format id="${formatId}" name="${formatName}" frameDuration="${frameDuration}" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>`,
  );
  lines.push(
    `    <asset id="${assetId}" name="${escapeXml(path.basename(sourceFileName, path.extname(sourceFileName)))}" start="0s" duration="${sourceDurationRat}" hasVideo="1" hasAudio="1" format="${formatId}" videoSources="1" audioSources="1" audioChannels="${audio_channels || 2}" audioRate="${audio_sample_rate || 48000}">`,
  );
  lines.push(`      <media-rep kind="original-media" src="${escapedSrc}"/>`);
  lines.push('    </asset>');
  lines.push('  </resources>');
  lines.push('  <library>');
  lines.push(`    <event name="${safeProjectName} (Auto-Edit)">`);
  lines.push(`      <project name="${safeProjectName}">`);
  lines.push(
    `        <sequence format="${formatId}" duration="${totalDurationRat}" tcStart="0s" tcFormat="NDF" audioLayout="${audioLayout}" audioRate="${audioRateAttr}">`,
  );
  lines.push('          <spine>');
  for (const c of clips) {
    lines.push(
      `            <asset-clip ref="${c.ref}" name="${c.name}" offset="${c.offset}" start="${c.start}" duration="${c.duration}" tcFormat="NDF"/>`,
    );
  }
  lines.push('          </spine>');
  lines.push('        </sequence>');
  lines.push('      </project>');
  lines.push('    </event>');
  lines.push('  </library>');
  lines.push('</fcpxml>');

  return lines.join('\n') + '\n';
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Validate well-formedness with xmllint if available. Throws on errors.
 * Note: we don't validate against Apple's FCPXML 1.10 DTD by default — DTD shipping is fiddly.
 * Premiere/Resolve will surface real schema errors clearly on import.
 */
function validateWellFormed(fcpxmlPath) {
  const result = spawnSync('xmllint', ['--noout', fcpxmlPath]);
  if (result.error) {
    console.warn(`[fcpxml] xmllint not found, skipping well-formedness check: ${result.error.code}`);
    return { skipped: true };
  }
  if (result.status !== 0) {
    throw new Error(`FCPXML is not well-formed:\n${result.stderr.toString()}`);
  }
  return { ok: true };
}

function writeFcpxml(outputPath, opts) {
  const xml = buildFcpxml(opts);
  fs.writeFileSync(outputPath, xml, 'utf-8');
  validateWellFormed(outputPath);
  return outputPath;
}

/**
 * Build a minimal FCPXML for a SINGLE clip — used by the per-clip render endpoint so
 * each shortform/longform export gets its own importable timeline file in addition to the MP4.
 *
 * The XML points at the SOURCE file (not the rendered MP4) with the clip's start/end range,
 * so the editor can refine inside Premiere/Resolve from the original media.
 *
 * @param {object} opts
 * @param {string} opts.projectName    — shown in Premiere's event/project tree
 * @param {string} opts.sourceFileName — filename of the source media (relative to the FCPXML location)
 * @param {object} opts.probe          — { fps_num, fps_den, width, height, duration_seconds, audio_sample_rate, audio_channels }
 * @param {number} opts.startSeconds
 * @param {number} opts.endSeconds
 */
function buildSingleClipFcpxml(opts) {
  return buildFcpxml({
    projectName: opts.projectName,
    sourceFileName: opts.sourceFileName,
    probe: opts.probe,
    keepSegments: [
      { start_seconds: opts.startSeconds, end_seconds: opts.endSeconds },
    ],
  });
}

function writeSingleClipFcpxml(outputPath, opts) {
  const xml = buildSingleClipFcpxml(opts);
  fs.writeFileSync(outputPath, xml, 'utf-8');
  validateWellFormed(outputPath);
  return outputPath;
}

module.exports = {
  buildFcpxml,
  writeFcpxml,
  buildSingleClipFcpxml,
  writeSingleClipFcpxml,
  rational,
  validateWellFormed,
};
