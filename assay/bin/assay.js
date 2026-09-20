#!/usr/bin/env node
import { main } from '../src/cli.js';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  process.stderr.write(`assay needs Node 20.12 or newer (you have ${process.versions.node}).\n`);
  process.exit(2);
}

process.exitCode = await main(process.argv.slice(2));
