#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`\nError: ${err?.message ?? err}`);
    if (process.env.VK_ARCHIVE_DEBUG) console.error(err?.stack);
    process.exit(1);
  },
);
