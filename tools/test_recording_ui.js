'use strict'
// Compatibility entry: the former VM fixtures now test the real TypeScript modules.
// DOM behavior is additionally covered by test_audio_settings_ui.js in real Electron.
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const root = path.join(__dirname, '..')
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
  'tests/diagnostics.test.ts', 'tests/playback.test.ts', 'tests/config-writer.test.ts',
  'tests/settings-model.test.ts', 'tests/speech.test.ts', 'tests/config.test.ts', 'tests/ipc.test.ts'
], { cwd: root, stdio: 'inherit' })
if (result.error) { console.error(result.error); process.exit(1) }
process.exit(result.status ?? 1)
