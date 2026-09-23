/**
 * Load / save caption style presets.
 *
 * Styles live as JSON files under `config/captions/styles/*.json`. Each describes the
 * visual treatment of captions: font, size, colors, position, animation. The renderer
 * pulls the user-selected preset and turns it into ASS subtitle directives.
 *
 * Schema (see /config/captions/styles/mozzo.json for the canonical example):
 *
 *   {
 *     "id": "mozzo",
 *     "name": "Mozzo Brand",
 *     "font_family": "Mozzo Sans Bold",         // PostScript name; must match the font file's PS name
 *     "font_file": "MozzoSans-Bold.ttf" | null, // basename in config/captions/fonts/, or null = system font
 *     "font_size_px": 80,                       // height at 1920px tall frame
 *     "primary_color": "#FFFFFF",               // resting caption text color
 *     "highlight_color": "#F59E0B",             // active-word color during karaoke
 *     "outline_color": "#000000",
 *     "outline_width_px": 4,                    // 0 = no outline
 *     "shadow": { "color": "#000000", "blur_px": 6, "offset_y_px": 2 } | null,
 *     "case": "as-spoken" | "upper" | "lower" | "title",
 *     "y_offset_pct": 0.72,                     // 0 = top, 1 = bottom of frame; 0.72 = bottom-third
 *     "animation": "pop" | "none"               // "pop" = active word slight scale-up
 *   }
 */

const fs = require('fs');
const path = require('path');

const { configPath } = require('../paths');
const STYLES_DIR = configPath('captions', 'styles');
const FONTS_DIR = configPath('captions', 'fonts');

function ensureDirs() {
  fs.mkdirSync(STYLES_DIR, { recursive: true });
  fs.mkdirSync(FONTS_DIR, { recursive: true });
}

function listStyles() {
  ensureDirs();
  if (!fs.existsSync(STYLES_DIR)) return [];
  return fs.readdirSync(STYLES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(STYLES_DIR, f), 'utf-8'));
      } catch (err) {
        console.warn(`[style-store] failed to parse ${f}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

function loadStyle(id) {
  ensureDirs();
  const filePath = path.join(STYLES_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`[style-store] failed to parse style ${id}: ${err.message}`);
    return null;
  }
}

function saveStyle(style) {
  ensureDirs();
  if (!style || typeof style.id !== 'string' || !style.id.match(/^[a-z0-9_-]+$/i)) {
    throw new Error('Style id must be a non-empty alphanumeric string (with - and _ allowed).');
  }
  const filePath = path.join(STYLES_DIR, `${style.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(style, null, 2), 'utf-8');
  return filePath;
}

function deleteStyle(id) {
  const filePath = path.join(STYLES_DIR, `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

/** Where on disk the user drops .ttf/.otf font files for the styles to reference. */
function fontsDir() {
  ensureDirs();
  return FONTS_DIR;
}

/**
 * True if the style's font_file actually exists on disk. We use this to decide
 * whether to pass `fontsdir=...` to ffmpeg or fall back to a system font.
 */
function styleHasCustomFont(style) {
  if (!style || !style.font_file) return false;
  return fs.existsSync(path.join(FONTS_DIR, style.font_file));
}

module.exports = {
  listStyles,
  loadStyle,
  saveStyle,
  deleteStyle,
  fontsDir,
  styleHasCustomFont,
  STYLES_DIR,
  FONTS_DIR,
};
