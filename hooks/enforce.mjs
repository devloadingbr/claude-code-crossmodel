#!/usr/bin/env node

import { decide } from '../lib/enforce.mjs';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { buf += chunk; });
process.stdin.on('end', () => {
  let result = { permission: 'allow' };
  try {
    result = decide(JSON.parse(buf));
  } catch {
    // Hooks must fail open when their input is not valid JSON or an unexpected
    // payload reaches the pure decision function.
    result = { permission: 'allow' };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
});

