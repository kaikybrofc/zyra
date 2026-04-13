import 'dotenv/config'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import mysql from 'mysql2/promise'
import { describe, expect, it } from 'vitest'

const queriesDir = path.resolve(process.cwd(), 'tests/queries')
const mysqlUrl = process.env.MYSQL_URL ?? process.env.WA_DB_URL
const FORBIDDEN_STATEMENT_PATTERN = /\b(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE)\b/i
const READ_ONLY_STATEMENT_PATTERN = /^(?:SELECT|WITH)\b/i

const splitStatements = (sql: string): string[] =>
  sql
    .split(/;\s*(?=(?:--|\/\*|SELECT|WITH|$))/gim)
    .map((statement) => statement.trim())
    .filter(Boolean)

const queryFiles = (await readdir(queriesDir))
  .filter((file) => file.endsWith('.sql'))
  .sort()

describe('queries sql', () => {
  it('encontra arquivos SQL para validar', () => {
    expect(queryFiles.length).toBeGreaterThan(0)
  })

  for (const fileName of queryFiles) {
    it(`valida a estrutura de ${fileName}`, async () => {
      const sqlPath = path.join(queriesDir, fileName)
      const sql = await readFile(sqlPath, 'utf-8')
      const statements = splitStatements(sql)

      expect(sql.trim().length).toBeGreaterThan(0)
      expect(statements.length).toBeGreaterThan(0)
      expect(sql).not.toMatch(/\bTODO\b/i)
      expect(sql).not.toMatch(/\$\{.+\}/)

      for (const statement of statements) {
        const statementWithoutComments = statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '')
        expect(statementWithoutComments.trim()).toMatch(READ_ONLY_STATEMENT_PATTERN)
        expect(statementWithoutComments).not.toMatch(FORBIDDEN_STATEMENT_PATTERN)
      }
    })

    const run = mysqlUrl ? it : it.skip

    run(`executa ${fileName} sem erro no mysql configurado`, async () => {
      const sqlPath = path.join(queriesDir, fileName)
      const sql = await readFile(sqlPath, 'utf-8')
      const statements = splitStatements(sql)

      const connection = await mysql.createConnection(mysqlUrl!)
      try {
        for (const statement of statements) {
          const [rows] = await connection.query(statement)
          expect(Array.isArray(rows)).toBe(true)
        }
      } finally {
        await connection.end()
      }
    })
  }
})
