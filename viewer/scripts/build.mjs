#!/usr/bin/env node
/** Bundle owned native ES modules into one offline HTML file. No dependencies or network installs. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { demoBundle } from '../fixtures/demo.mjs'
import { validateBundle } from '../src/data.js'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), source = join(root, 'src')

function bundleModules(entry) {
  const complete = new Map(), pending = new Set()
  function visit(filename) {
    const id = relative(source, filename).replaceAll('\\', '/')
    if (id.startsWith('..') || isAbsolute(id)) throw new Error('Module is outside viewer/src')
    if (complete.has(id)) return
    if (pending.has(id)) throw new Error(`Circular frontend module: ${id}`)
    pending.add(id)
    let content = readFileSync(filename, 'utf8')
    const imports = [...content.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*$/gm)]
    for (const [statement, names, specifier] of imports) {
      if (!specifier.startsWith('.')) throw new Error('Standalone frontend cannot import a package')
      const target = resolve(dirname(filename), specifier), targetId = relative(source, target).replaceAll('\\', '/')
      visit(target)
      content = content.replace(statement, `const {${names.replaceAll(/\bas\b/g, ':')}} = __modules[${JSON.stringify(targetId)}];`)
    }
    const names = [...content.matchAll(/^export\s+(?:async\s+)?(?:const|let|function|class)\s+(\w+)/gm)].map(m => m[1])
    content = content.replace(/^export\s+/gm, '')
    if (/^\s*(?:import|export)\s/m.test(content)) throw new Error(`Unsupported module syntax in ${id}`)
    complete.set(id, `__modules[${JSON.stringify(id)}] = (() => {\n${content}\nreturn {${names.join(',')}};\n})();`)
    pending.delete(id)
  }
  visit(entry)
  return `const __modules = Object.create(null);\n${[...complete.values()].join('\n')}\n`
}
export function buildViewer({ dataFile, output, demo = false } = {}) {
  const configFile = join(root, 'config.json'), config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
  const selectedData = dataFile ? resolve(dataFile) : !demo && config.defaultData ? resolve(root, config.defaultData) : null
  const bundle = validateBundle(selectedData ? JSON.parse(readFileSync(selectedData, 'utf8')) : demoBundle())
  const safeData = JSON.stringify(bundle).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
  let script = `${bundleModules(join(source, 'app.js'))}\n__modules['app.js'].startViewer(${safeData});\n`
  new Script(script, { filename: 'mars-viewer-bundle.js' })
  script = script.replaceAll(/<\/script/gi, '<\\/script')
  const css = ['styles.css', 'app.css'].map(name => readFileSync(join(source, name), 'utf8')).join('\n')
  let html = readFileSync(join(root, 'index.template.html'), 'utf8').replace('/* VIEWER_STYLES */', () => css).replace('/* VIEWER_SCRIPT */', () => script)
  if (/\/\* VIEWER_(STYLES|SCRIPT) \*\//.test(html)) throw new Error('Unfilled HTML template')
  const destination = resolve(output ?? join(root, 'dist', 'index.html'))
  mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, html)
  return { file: destination, bytes: Buffer.byteLength(html), source: bundle.source, runs: bundle.runs.length }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {}
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--demo') { options.demo = true; continue }
      if (!args[i + 1] || !['--data', '--out'].includes(args[i])) throw new Error('用法：node viewer/scripts/build.mjs [--data <数据包.json> | --demo] [--out <网页.html>]')
      options[args[i] === '--data' ? 'dataFile' : 'output'] = args[++i]
    }
    console.log(JSON.stringify(buildViewer(options)))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
