import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const builtIn = new URL('./public-content-patterns.json', import.meta.url);
const patterns = JSON.parse(readFileSync(builtIn, 'utf8'));
if (process.env.HERMESQ_PUBLIC_PATTERNS_FILE) {
  patterns.push(...JSON.parse(readFileSync(process.env.HERMESQ_PUBLIC_PATTERNS_FILE, 'utf8')));
}
const compiled = patterns.map(({ name, regex }) => ({ name, pattern: new RegExp(regex, 'im') }));
const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let found = false;
for (const path of paths) {
  const content = readFileSync(path, 'utf8');
  if (content.includes('\0')) continue;
  for (const { name, pattern } of compiled) {
    if (!pattern.test(content)) continue;
    console.error(`${path}: ${name}`);
    found = true;
  }
}
if (found) process.exitCode = 1;
