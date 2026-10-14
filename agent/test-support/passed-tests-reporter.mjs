// Claude · № 14,590 14-Oct (owner "next work": NASA-5 batch 2; claude-builder).
// A node:test reporter that prints one JSON line per test that PASSED and
// actually ran — not skipped, not todo — with its file and its name as the
// runner saw it (a parameterised title arrives already expanded). Used by
// agent/acceptance/matrix.test.js to prove a receipt ran, which reading the
// source cannot (dead code, a conditional skip, t.skip() in the body).
export default async function * passedTests(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass') continue
    const d = event.data
    if (d.skip || d.todo || d.details?.type === 'suite') continue
    yield JSON.stringify({ file: d.file ?? null, name: d.name }) + '\n'
  }
}
