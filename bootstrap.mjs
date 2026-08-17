#!/usr/bin/env node
// bootstrap.mjs — thin root entry (layout §5: `node ~/cockpit/bootstrap.mjs`).
// The real bootstrap lives in memory-engine/bootstrap.mjs; this only forwards.
import { main } from './memory-engine/bootstrap.mjs';
main().catch((e) => { console.error('bootstrap failed:', e); process.exit(1); });
