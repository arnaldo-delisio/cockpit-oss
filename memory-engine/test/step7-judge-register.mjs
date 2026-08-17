// step7-judge-register.mjs, preload for the staleness-producer scenarios in
// step7-producers.test.mjs: installs the loader hook that swaps judge.mjs's judge() for the
// deterministic offline one (see step7-judge-loader.mjs). Used only via
// `node --import <this file> step7-truth-driver.mjs`, never by the main suite.
import { register } from 'node:module';
register('./step7-judge-loader.mjs', import.meta.url);
