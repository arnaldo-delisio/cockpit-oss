// step9-judge-register.mjs, preload for the fragmentation-insight scenarios in
// step9-drift-fragmentation.test.mjs: installs the loader hook that swaps judge.mjs's judge() for
// the deterministic offline one (step9-judge-loader.mjs / step9-judge-mock.mjs). Used only via
// `node --import <this file> step9-reconcile-driver.mjs`, never by the main suite.
import { register } from 'node:module';
register('./step9-judge-loader.mjs', import.meta.url);
