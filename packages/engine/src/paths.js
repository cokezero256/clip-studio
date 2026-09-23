/**
 * Where the engine package lives on disk — resolved WITHOUT trusting __dirname.
 *
 * Next's bundler rewrites __dirname to the placeholder "/ROOT" even for packages declared
 * external, so every `path.resolve(__dirname, '..', 'config', …)` in this package pointed at
 * `/ROOT/config/…` when a web route called it: the editor's load route died with
 * "ENOENT /ROOT/packages/engine/config/layouts/layout-6-band-title.json". The worker, a plain
 * Node process, never saw it. One resolver, used by every module that needs a config or
 * binary path.
 */
const fs = require('fs');
const path = require('path');

let cached = null;

function engineRoot() {
  if (cached) return cached;
  if (process.env.CLIPSTUDIO_ENGINE_ROOT) return (cached = process.env.CLIPSTUDIO_ENGINE_ROOT);
  // Real __dirname (worker, tests, scripts).
  const fromHere = path.resolve(__dirname, '..');
  if (!fromHere.startsWith('/ROOT') && fs.existsSync(path.join(fromHere, 'package.json'))) {
    return (cached = fromHere);
  }
  // Inside Next: walk up from the working directory to the workspace, then into the package.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'packages', 'engine');
    if (fs.existsSync(path.join(candidate, 'package.json'))) return (cached = candidate);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('Could not locate the Clip Studio engine package. Set CLIPSTUDIO_ENGINE_ROOT.');
}

const configPath = (...parts) => path.join(engineRoot(), 'config', ...parts);
const binPath = (...parts) => path.join(engineRoot(), 'bin', ...parts);

module.exports = { engineRoot, configPath, binPath };
