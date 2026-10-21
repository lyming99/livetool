import fs from 'node:fs'
import path from 'node:path'

export function redact(text: string, secret = ''): string {
  let output = secret ? text.split(secret).join('[REDACTED]') : text
  output = output.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
  return output.replace(/("apiKey"\s*:\s*")[^"]*(")/g, '$1[REDACTED]$2')
}

export function setupLogging(directory: string, getSecret: () => string): () => void {
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'livetool.log')
  try {
    if (fs.existsSync(file)) {
      const previous = file + '.1'
      if (fs.existsSync(previous)) fs.unlinkSync(previous)
      fs.renameSync(file, previous)
    }
  } catch { /* Keep startup working if another process owns the previous file. */ }
  const stream = fs.createWriteStream(file, { flags: 'w' })
  stream.on('error', () => { /* Logging is best effort; never crash the application. */ })
  const originalLog = console.log.bind(console)
  const originalError = console.error.bind(console)
  const wrap = (original: typeof console.log, prefix: string) => (...values: unknown[]): void => {
    const text = redact(values.map(value => typeof value === 'string' ? value : String(value)).join(' '), getSecret())
    original(text)
    if (!stream.destroyed) stream.write(`${new Date().toISOString()} ${prefix}${text}\n`)
  }
  console.log = wrap(originalLog, '')
  console.error = wrap(originalError, 'ERROR ')
  return () => { console.log = originalLog; console.error = originalError; stream.end() }
}
