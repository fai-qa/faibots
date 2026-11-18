import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_GROUP_SETTINGS } from '@shared/domain'

describe('toolchain smoke', () => {
  it('resolves @shared and runs node:sqlite with FTS5', () => {
    expect(DEFAULT_GROUP_SETTINGS.maxRounds).toBe(3)
    const db = new DatabaseSync(':memory:')
    db.exec("create virtual table f using fts5(c); insert into f values ('remember the deadline')")
    expect(db.prepare("select count(*) as n from f where f match 'deadline'").get()).toEqual({ n: 1 })
  })
})
