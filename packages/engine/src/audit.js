/**
 * Generates the human-readable audit.md that ships alongside the FCPXML.
 * The editor scans this in 30 seconds to know what was cut, why, and where to override.
 */

function fmtTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00:00.000';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

function fmtClock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function buildAudit({
  sourceName,
  client,
  probe,
  cuts,           // all cuts from cut-decider, post-validation
  appliedCuts,    // subset that was actually applied to the rendered MP4
  suggestedCuts,  // borderline-confidence drops, NOT applied
  highlights,     // keep_highlight entries (hooks + b-roll cues)
  finalDuration,
  clientConfig,
}) {
  const sourceDur = probe.duration_seconds;
  const reductionPct = ((1 - finalDuration / sourceDur) * 100).toFixed(1);

  const fillerHeatmap = computeFillerHeatmap(appliedCuts, sourceDur);

  const lines = [];
  lines.push(`# Auto-edit audit — ${sourceName}`);
  lines.push('');
  lines.push(`**Client:** ${client}`);
  lines.push(`**Source:** ${fmtClock(sourceDur)} → **Output:** ${fmtClock(finalDuration)} _(−${reductionPct}%)_`);
  lines.push(
    `**${appliedCuts.length}** cuts applied · **${suggestedCuts.length}** suggested (review) · **${highlights.length}** highlights flagged`,
  );
  lines.push('');
  lines.push(`**Model:** \`${clientConfig.model || 'haiku'}\` · **Auto-apply threshold:** ${clientConfig.auto_apply_confidence ?? 0.85}`);
  lines.push('');

  // ── Hooks ──
  const hooks = highlights.filter((h) => h.reason === 'hook');
  if (hooks.length > 0) {
    lines.push('## Hook candidates (best openers)');
    lines.push('');
    for (const h of hooks) {
      const dur = (h.end_seconds - h.start_seconds).toFixed(1);
      lines.push(
        `- ${fmtTime(h.start_seconds)}–${fmtTime(h.end_seconds)} _(${dur}s)_ — ${h.note ? `"${h.note.replace(/"/g, '\\"')}"` : '(no note)'} — confidence ${h.confidence.toFixed(2)}`,
      );
    }
    lines.push('');
  }

  // ── B-roll cues ──
  const broll = highlights.filter((h) => h.reason === 'b_roll_cue');
  if (broll.length > 0) {
    lines.push('## B-roll cues (visual concepts mentioned)');
    lines.push('');
    for (const b of broll) {
      lines.push(`- ${fmtTime(b.start_seconds)} — ${b.note || '(verbalized visual)'}`);
    }
    lines.push('');
  }

  // ── Filler heatmap ──
  if (fillerHeatmap.length > 0) {
    lines.push('## Filler density (per minute)');
    lines.push('');
    lines.push('| Minute | Filler cuts |');
    lines.push('|--------|-------------|');
    for (const row of fillerHeatmap) {
      const bar = '█'.repeat(Math.min(row.count, 20));
      lines.push(`| ${row.minute.toString().padStart(2, '0')} | ${row.count} ${bar} |`);
    }
    lines.push('');
  }

  // ── Cuts applied ──
  lines.push('## Cuts applied');
  lines.push('');
  if (appliedCuts.length === 0) {
    lines.push('_No cuts applied. Either the source was clean, or no decisions exceeded the auto-apply threshold._');
  } else {
    lines.push('| Time | Duration | Reason | Conf | Note |');
    lines.push('|------|---------:|--------|-----:|------|');
    for (const c of appliedCuts) {
      const dur = (c.end_seconds - c.start_seconds).toFixed(2);
      lines.push(
        `| ${fmtTime(c.start_seconds)} | ${dur}s | ${c.reason} | ${c.confidence.toFixed(2)} | ${escapeMd(c.note || '')} |`,
      );
    }
  }
  lines.push('');

  // ── Suggested but not applied ──
  if (suggestedCuts.length > 0) {
    lines.push('## Suggested but NOT applied (review these)');
    lines.push('');
    lines.push('| Time | Duration | Reason | Conf | Note |');
    lines.push('|------|---------:|--------|-----:|------|');
    for (const c of suggestedCuts) {
      const dur = (c.end_seconds - c.start_seconds).toFixed(2);
      lines.push(
        `| ${fmtTime(c.start_seconds)} | ${dur}s | ${c.reason} | ${c.confidence.toFixed(2)} | ${escapeMd(c.note || '')} |`,
      );
    }
    lines.push('');
    lines.push('_To apply any of these in Premiere: navigate to the timecode, slip-edit the cut yourself. The FCPXML does not include these spans as cuts; they remain in the rendered MP4._');
    lines.push('');
  }

  // ── J/L cut intent ──
  const jCutMs = clientConfig.j_cut_ms || 0;
  const lCutMs = clientConfig.l_cut_ms || 0;
  if (jCutMs > 0 || lCutMs > 0) {
    lines.push('## J/L cut intent');
    lines.push('');
    if (jCutMs > 0) {
      lines.push(
        `- **J-cuts: ${jCutMs}ms.** Audio of the next clip should lead by ${jCutMs}ms before the video transitions. ` +
          'The FCPXML ships with straight cuts — apply this with Premiere\'s rolling-edit tool (N) on each cut, +' + jCutMs + 'ms on the audio track.',
      );
    }
    if (lCutMs > 0) {
      lines.push(
        `- **L-cuts: ${lCutMs}ms.** Audio of the previous clip should linger ${lCutMs}ms after the video transitions. Same rolling-edit treatment, opposite direction.`,
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`Generated by mozzo-auto-editor · ${new Date().toISOString()}`);
  return lines.join('\n');
}

function escapeMd(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function computeFillerHeatmap(cuts, durationSec) {
  const minutes = Math.ceil(durationSec / 60);
  const buckets = new Array(minutes).fill(0);
  for (const c of cuts) {
    if (c.reason !== 'filler') continue;
    const m = Math.floor(c.start_seconds / 60);
    if (m >= 0 && m < minutes) buckets[m] += 1;
  }
  return buckets
    .map((count, minute) => ({ minute, count }))
    .filter((row) => row.count > 0);
}

module.exports = { buildAudit };
