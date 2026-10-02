#!/usr/bin/env node
// Set the version everywhere it is written, and point the Homebrew formula at that release:
//   node scripts/bump.js 0.4.0     then commit, tag v0.4.0 and push the tag (see CONTRIBUTING.md)
//   node scripts/bump.js --check   exit 1 if anything disagrees (the release workflow runs this)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const file = f => path.join(root, f);
const read = f => fs.readFileSync(file(f), 'utf8');
const JSONS = ['package.json', '.claude-plugin/plugin.json'];
const sha = () => crypto.createHash('sha256').update(fs.readFileSync(file('claude-image-gen.js'))).digest('hex');
const formulaRe = /(url "https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/v)([^/]+)(\/claude-image-gen\.js"\n\s*sha256 ")([0-9a-f]{64})/;

const want = process.argv[2];
if (want === '--check') {
  const v = read('claude-image-gen.js').match(/const VERSION = '([^']+)'/)[1];
  const [, , fv, , fsha] = read('Formula/claude-image-gen.rb').match(formulaRe);
  const problems = [
    ...JSONS.filter(f => JSON.parse(read(f)).version !== v).map(f => `${f} is not ${v}`),
    ...(fv !== v ? [`the formula points at v${fv}, not v${v}`] : []),
    ...(fsha !== sha() ? ['the formula sha256 is not that of claude-image-gen.js'] : []),
  ];
  if (problems.length) { console.error(problems.join('\n') + '\nRun: node scripts/bump.js ' + v); process.exit(1); }
  console.log(`version ${v} is consistent`);
} else if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(want || '')) {
  fs.writeFileSync(file('claude-image-gen.js'), read('claude-image-gen.js').replace(/const VERSION = '[^']+'/, `const VERSION = '${want}'`));
  for (const f of JSONS) fs.writeFileSync(file(f), read(f).replace(/"version": "[^"]+"/, `"version": "${want}"`));
  fs.writeFileSync(file('Formula/claude-image-gen.rb'), read('Formula/claude-image-gen.rb').replace(formulaRe, `$1${want}$3${sha()}`));
  console.log(`version ${want}: claude-image-gen.js, ${JSONS.join(', ')}, Formula/claude-image-gen.rb`);
} else {
  console.error('Usage: node scripts/bump.js <version> | --check');
  process.exit(2);
}
