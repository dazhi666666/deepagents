/** Hash executable experiment sources without reading private runs, credentials or device data. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentHash } from './contracts.ts'

/** Record source-file hashes from three explicit code roots; symlinks and generated trees are excluded. */
export function sourceManifest() {
  const roots = [
    { name: 'mars', path: fileURLToPath(new URL('../', import.meta.url)) },
    { name: 'greenhouse', path: fileURLToPath(new URL('../../greenhouse/', import.meta.url)) },
    { name: 'harness-ai4science', path: fileURLToPath(new URL('../../../../../science-harness/integrations/ai4science/', import.meta.url)) },
  ]
  const excluded = new Set(['node_modules', 'lib', 'types', 'dist', '.git', 'artifacts', 'secrets', 'runs', 'private', 'data', 'logs', 'report', 'reports', '__pycache__'])
  const files: { path: string; sha256: string }[] = []
  for (const root of roots) {
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || excluded.has(entry.name)) continue
        const file = join(directory, entry.name)
        if (entry.isDirectory()) visit(file)
        else if (entry.isFile() && /\.(ts|mjs|py)$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name))
          files.push({ path: `${root.name}/${relative(root.path, file).replaceAll('\\', '/')}`,
            sha256: createHash('sha256').update(readFileSync(file)).digest('hex') })
      }
    }
    visit(root.path)
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { version: 1, files, hash: contentHash(files) }
}
