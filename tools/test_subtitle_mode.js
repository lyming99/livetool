'use strict'
// Compatibility entry: subtitle policies are tested as an actual controller, not source slices.
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const root = path.join(__dirname, '..')
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
  'tests/subtitles.test.ts', 'tests/config.test.ts'
], { cwd: root, stdio: 'inherit' })
if (result.error) { console.error(result.error); process.exit(1) }
process.exit(result.status ?? 1)
