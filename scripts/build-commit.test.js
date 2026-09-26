// UI-4 S2: the build-id helper, with the env set, unset, and 'dev'
// (falling through to the git fallback, then to the honest 'dev' default).
import { describe, it, expect } from 'vitest'
import { resolveBuildCommit } from './build-commit.mjs'

describe('resolveBuildCommit', () => {
  it('prefers RAILWAY_GIT_COMMIT_SHA over Vercel\'s and a bare GIT_COMMIT_SHA', () => {
    expect(resolveBuildCommit({ RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef' })).toBe('0123456')
    expect(resolveBuildCommit({ RAILWAY_GIT_COMMIT_SHA: 'aaa1111', VERCEL_GIT_COMMIT_SHA: 'bbb2222', GIT_COMMIT_SHA: 'ccc3333' })).toBe('aaa1111')
    expect(resolveBuildCommit({ VERCEL_GIT_COMMIT_SHA: 'bbb2222', GIT_COMMIT_SHA: 'ccc3333' })).toBe('bbb2222')
    expect(resolveBuildCommit({ GIT_COMMIT_SHA: 'ccc3333' })).toBe('ccc3333')
  })

  it('falls back to the injected git head when no env var is set', () => {
    expect(resolveBuildCommit({}, () => 'deadbee\n')).toBe('deadbee')
  })

  it('reads as the honest \'dev\' when the env is unset AND git is unavailable — never a fabricated hash', () => {
    expect(resolveBuildCommit({}, () => { throw new Error('not a git repository') })).toBe('dev')
    expect(resolveBuildCommit({}, () => '')).toBe('dev')
  })

  it('an env var wins even when it would need git to resolve — the git function is never called', () => {
    let called = false
    resolveBuildCommit({ RAILWAY_GIT_COMMIT_SHA: 'abc1234' }, () => { called = true; return 'zzz9999' })
    expect(called).toBe(false)
  })
})
