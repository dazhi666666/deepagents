/** Parse isolated program bodies without evaluating them; Node's module loader is never a program capability. */
import { createRequire } from 'node:module'
import { compileFunction } from 'node:vm'
import type * as TypeScript from 'typescript'
// The standalone experiment shares the Harness installation's parser and dependency version.
const ts: typeof TypeScript = createRequire(new URL('../../../../science-harness/package.json', import.meta.url))('typescript')

/** Reject static/dynamic imports and import.meta, including comments or escapes around import tokens. */
export function assertIsolatedProgram(code: string, asynchronous: boolean) {
  const wrapper = `${asynchronous ? 'async ' : ''}function __isolated_program() {\n${code}\n}`
  const compiled = ts.transpileModule(wrapper, { fileName: 'isolated-body.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } })
  if (compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error('Isolated program syntax is invalid')
  const source = ts.createSourceFile('isolated-body.js', compiled.outputText, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS)
  const visit = (node: TypeScript.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) ||
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) throw new Error('Module imports are unavailable in isolated programs')
    ts.forEachChild(node, visit)
  }
  visit(source)
}

/** Validate a JavaScript model body without executing it; nested-function returns do not return its result. */
export function assertSynchronousModelProgram(code: string): void {
  try { compileFunction(`"use strict";\n${code}`, ['input', 'parameters']) }
  catch (error) {
    throw new Error(`Model code must be a synchronous JavaScript function body: ${error instanceof Error ? error.message : String(error)}. Use return {...}; do not wrap it in function(input) {...} or (input) => {...}.`)
  }
  assertIsolatedProgram(code, false)
  const source = ts.createSourceFile('model-body.js', `function __model(input, parameters) {\n${code}\n}`, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  const model = source.statements[0]
  if (!model || !ts.isFunctionDeclaration(model) || !model.body) throw new Error('Invalid model function body')
  let returns = false
  const visit = (node: TypeScript.Node): void => {
    if (ts.isReturnStatement(node)) { returns = true; return }
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return
    ts.forEachChild(node, visit)
  }
  visit(model.body)
  if (!returns) throw new Error('Model code must return finite JSON from its outer body. Use return {...}; a standalone arrow/function expression is not a model body.')
}
