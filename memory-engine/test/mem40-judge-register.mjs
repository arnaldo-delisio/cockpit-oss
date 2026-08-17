// mem40-judge-register.mjs — preload for the MEM-40 source-sha/contradiction tests
// (source-sha-contradiction.test.mjs): installs the loader hook that swaps judge.mjs's judge()
// for the deterministic, prompt-recording offline one (mem40-judge-loader.mjs /
// mem40-judge-mock.mjs). Used only via `node --import <this file> step9-reconcile-driver.mjs`,
// never by the main suite. Same pattern as step9-judge-register.mjs.
import { register } from 'node:module';
register('./mem40-judge-loader.mjs', import.meta.url);
