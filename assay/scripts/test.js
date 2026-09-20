#!/usr/bin/env node
// Portable test runner: `node --test <dir>` and shell globs behave differently across Node
// versions and operating systems, so list the files explicitly.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test');
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => join(dir, f));
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
