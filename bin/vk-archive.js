#!/usr/bin/env node
import dns from 'node:dns';
import { main } from '../src/cli.js';

// Media links from VK's video CDN are bound to the IPv4 address the browser used; make
// sure Node connects the same way instead of preferring IPv6.
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  /* older Node */
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`\nError: ${err?.message ?? err}`);
    if (process.env.VK_ARCHIVE_DEBUG) console.error(err?.stack);
    process.exit(1);
  },
);
