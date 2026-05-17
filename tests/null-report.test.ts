import { describe, expect, it } from 'vitest'
import { buildNullCountQuery, classifyColumn } from '../src/core/db/null-report.js'

describe('null-report helpers', () => {
  it('classifica campo legado de group_feature_flags como contextual', () => {
    expect(classifyColumn('group_feature_flags', 'antilink_allow_own_group_invite')).toBe('contextual')
  })

  it('conta null de label_associations.message_db_id apenas para association_type=message', () => {
    const { query, params } = buildNullCountQuery({
      connectionId: 'default',
      hasConnectionId: true,
      table: 'label_associations',
      column: 'message_db_id',
    })

    expect(query).toContain("association_type = 'message'")
    expect(query).toContain('message_db_id')
    expect(params).toEqual(['default'])
  })

  it('mantem query padrao para outras colunas', () => {
    const { query, params } = buildNullCountQuery({
      connectionId: 'default',
      hasConnectionId: true,
      table: 'users',
      column: 'display_name',
    })

    expect(query).toContain('connection_id = ?')
    expect(query).toContain('`display_name` IS NULL')
    expect(query).not.toContain('association_type')
    expect(params).toEqual(['default'])
  })
})
