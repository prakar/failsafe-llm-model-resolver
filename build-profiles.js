#!/usr/bin/env node
// build-profiles.js  —  run after editing profiles/*.yml
// Requires js-yaml: npm install --save-dev js-yaml
// Converts each .yml file to a corresponding .js module that the resolver loads
// at runtime without needing js-yaml as a runtime dependency.
'use strict';
const fs     = require('fs');
const path   = require('path');
const jsyaml = require('js-yaml');

const dir     = path.join(__dirname, 'profiles');
const banner  = '// Generated from {name}.yml — do not edit directly.\n// Edit {name}.yml then run: node build-profiles.js\n';

let built = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.yml'))) {
  const name = f.replace('.yml','');
  const raw  = jsyaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
  const code = banner.replace(/{name}/g, name) +
    "'use strict';\nmodule.exports = " + JSON.stringify(raw, null, 2) + ';\n';
  fs.writeFileSync(path.join(dir, name + '.js'), code);
  console.log('  wrote profiles/' + name + '.js');
  built++;
}
console.log('Done —', built, 'profiles rebuilt.');
