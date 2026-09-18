#!/usr/bin/env node
/**
 * One-command operator status: health + waitlist count + demo URL.
 * Usage: node scripts/status.js [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || process.env.HOOKKEEP_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DATA_DIR = process.env.HOOKKEEP_DATA || path.join(ROOT, 'data');
const DEMO_JSON = path.join(ROOT, 'docs', 'demo.json');
const WAITLIST = path.join(DATA_DIR, 'waitlist.ndjson');

function countNdjson(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function readDemo() {
  try {
    return JSON.parse(fs.readFileSync(DEMO_JSON, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const demo = readDemo();
  let health = null;
  let healthErr = null;
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    health = await res.json().catch(() => ({}));
    if (!res.ok) healthErr = `HTTP ${res.status}`;
  } catch (e) {
    healthErr = e.message || String(e);
  }

  const waitlist = countNdjson(WAITLIST);
  const lines = [
    `Hookkeep status — ${new Date().toISOString()}`,
    `Base: ${BASE}`,
    healthErr
      ? `Health: FAIL (${healthErr})`
      : `Health: OK · persistOk=${health?.persistOk} · workspaces=${health?.workspaceCount ?? '?'} · billing=${health?.billing ?? 'null'}`,
    `Waitlist entries: ${waitlist}`,
    `Demo URL (docs/demo.json): ${demo?.demoUrl || '(missing)'}`,
    `Demo updatedAt: ${demo?.updatedAt || '(missing)'}`,
    `Pages: https://kestrel-devagent.github.io/hookkeep/`,
  ];
  console.log(lines.join('\n'));
  if (healthErr) process.exit(1);
}

main();
