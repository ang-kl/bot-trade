// agent/test-support/module-imports.js — every module a JS file asks for, read
// from its syntax tree rather than from a pattern over its text.
//
// Claude · № 14,078+ 13-Oct (owner: NASA programme step 4, "syntax-aware
// import analysis"; claude-builder). Finding C1 of
// doc/bot-trade-NASA-assessment-2026-10-13.md: the line-start regex in
// research-isolation.test.js missed an inline `await import("./x.js")` and
// the second import on one line, so the isolation graph could certify an
// absence it never looked for. The parser (acorn, the parser eslint's espree
// is built on) reads the ECMAScript module grammar itself:
//   import … from 'x'            ImportDeclaration
//   export … from 'x'            ExportNamedDeclaration / ExportAllDeclaration
//   import('x')                  ImportExpression (anywhere: inline, nested)
//   require('x')                 CallExpression on `require` (createRequire)
// Comments and strings are not code, so they never count.
//
// A dynamic import or require whose target is not a fixed string cannot be
// resolved by reading; it is returned in `unresolved` with its line so a
// caller can fail closed instead of assuming it is harmless. Where a file
// routes its imports through its own loader (strategies.js: loadCompute('./x.js'))
// or a table (fast-monitor.js: { mod: './x.js' }), the caller DECLARES that
// with `loaders` / `specProps` and those literal targets are counted too. A
// file that does
// not parse throws (named): a scanner that cannot read a file has not shown
// it is clean.
import * as acorn from 'acorn'

const fixed = (node) => {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked
  return null
}

/**
 * For one source text: { specs, unresolved, declared, sites }. `sites` names
 * each literal import's kind ('static' at load, 'dynamic' when run) and, for a
 * dynamic one, the innermost enclosing function (null at module top level, so
 * a top-level `await import()` counts as load time). Throws on a parse error.
 */
export function moduleImports(src, file = '<source>', { loaders = [], specProps = [] } = {}) {
  let ast
  try {
    ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true })
  } catch (err) {
    throw new Error(`module-imports: ${file} does not parse (${err.message})`)
  }
  const specs = [], unresolved = [], declared = [], sites = []
  const fnStack = []
  const note = (kind, node) => unresolved.push({ kind, line: node.loc.start.line, fn: fnStack.length ? fnStack[fnStack.length - 1] : null, text: src.slice(node.start, node.end).slice(0, 120) })
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        specs.push(node.source.value); sites.push({ spec: node.source.value, kind: 'static', fn: null, line: node.loc.start.line }); break
      case 'ExportNamedDeclaration':
        if (node.source) { specs.push(node.source.value); sites.push({ spec: node.source.value, kind: 'static', fn: null, line: node.loc.start.line }) }
        break
      case 'ImportExpression': {
        const s = fixed(node.source)
        if (s != null) { specs.push(s); sites.push({ spec: s, kind: 'dynamic', fn: fnStack.length ? fnStack[fnStack.length - 1] : null, line: node.loc.start.line }) } else note('import()', node)
        break
      }
      case 'CallExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const s = fixed(node.arguments[0])
          if (s != null) specs.push(s); else note('require()', node)
        } else if (node.callee.type === 'Identifier' && loaders.includes(node.callee.name)) {
          const s = fixed(node.arguments[0])
          if (s != null) { specs.push(s); declared.push(s) } else note(`${node.callee.name}()`, node)
        }
        break
      case 'Property':
        if (!node.computed && specProps.includes(node.key.name ?? node.key.value)) {
          const s = fixed(node.value)
          if (s != null) { specs.push(s); declared.push(s) }
        }
        break
    }
    const isFn = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)
    if (isFn) fnStack.push(node.id?.name ?? '<anonymous>')
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const v = node[key]
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c) }
      else if (v && typeof v.type === 'string') visit(v)
    }
    if (isFn) fnStack.pop()
  }
  visit(ast)
  return { specs, unresolved, declared, sites }
}
