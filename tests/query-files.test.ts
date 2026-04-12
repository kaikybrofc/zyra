import 'dotenv/config'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import mysql from 'mysql2/promise'
import { describe, expect, it } from 'vitest'

const queriesDir = path.resolve(process.cwd(), 'tests/queries')
const mysqlUrl = process.env.MYSQL_URL ?? process.env.WA_DB_URL

const splitStatements = (sql: string): string[] =>
  sql
    .split(/;\s*(?=(?:--|\/\*|SELECT|WITH|$))/gim)
    .map((statement) => statement.trim())
    .filter(Boolean)

describe('queries sql', async () => {
  const queryFiles = (await readdir(queriesDir))
    .filter((file) => file.endsWith('.sql'))
    .sort()

  for (const fileName of queryFiles) {
    const run = mysqlUrl ? it : it.skip

    run(`executa ${fileName} sem erro no mysql configurado`, async () => {
      const sqlPath = path.join(queriesDir, fileName)
      const sql = await readFile(sqlPath, 'utf-8')
      const statements = splitStatements(sql)

      expect(statements.length).toBeGreaterThan(0)

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
