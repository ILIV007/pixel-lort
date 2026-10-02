#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
  if (!process.env[name]) {
    console.error(`Missing required deployment credential: ${name}`);
    process.exit(1);
  }
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/i.test(commit)) {
  console.error('Unable to resolve a full Git commit identifier.');
  process.exit(1);
}

execFileSync('npx', ['wrangler', 'deploy', '--env', 'preview', '--var', `APP_COMMIT:${commit}`], {
  stdio: 'inherit',
  env: process.env,
});
