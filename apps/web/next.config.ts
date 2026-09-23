import type { NextConfig } from 'next';
import path from 'path';

// Keys live in the workspace root .env, shared with the worker. Without this the web
// process silently has no LLM key and title generation returns 502.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const nextConfig: NextConfig = {
  // The engine and db packages are CommonJS and shell out to native binaries; they must
  // stay external to the bundler rather than being traced and rewritten.
  serverExternalPackages: ['better-sqlite3', 'ffmpeg-static', 'ffprobe-static', '@clip-studio/engine', '@clip-studio/db'],
  outputFileTracingRoot: require('path').resolve(__dirname, '../..'),
};

export default nextConfig;
