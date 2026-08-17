// step5-embed-register.mjs, preload for the suppression-backstop scenarios in
// ratification.test.mjs: installs the loader hook that swaps retrieval.mjs's embed() for a
// deterministic offline one (see step5-embed-loader.mjs). Used only via
// `node --import <this file> step5-driver.mjs`, never by the main suite.
import { register } from 'node:module';
register('./step5-embed-loader.mjs', import.meta.url);
