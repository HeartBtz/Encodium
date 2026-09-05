'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

// Load the actual implementation with explicit boundaries substituted, without
// modifying require.cache or opening an application DB/starting any workers.
module.exports = function loadModule(relative, mocks = {}, options = {}) {
  const filename = path.resolve(__dirname, '../..', relative);
  const nativeRequire = createRequire(filename);
  const localRequire = name => Object.hasOwn(mocks, name) ? mocks[name] : nativeRequire(name);
  const mod = { exports: {} };
  const extra = options.expose ? `\nObject.assign(module.exports, { ${options.expose.join(',')} });` : '';
  const source = process.env.ENCODIUM_TEST_BASELINE === relative
    ? execFileSync('git', ['show', `30abcc2:${relative}`], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' })
    : fs.readFileSync(filename, 'utf8');
  const wrapper = vm.runInThisContext(`(function(exports, require, module, __filename, __dirname, process) {\n${source}${extra}\n})`, { filename });
  wrapper(mod.exports, localRequire, mod, filename, options.dirname || path.dirname(filename), { ...process, env: { ...process.env, ...options.env } });
  return mod.exports;
};
