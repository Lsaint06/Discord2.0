// Read-only database facts: integrity, foreign keys, applied migrations, triggers, rows per table.
// Inside the staging container:  node - /data/discord2.db < dbstats.cjs   (path = last argument)
const { DatabaseSync } = require('node:sqlite')

const file = process.argv[process.argv.length - 1]
if (!file || !file.endsWith('.db')) throw new Error('usage: node dbstats.cjs <discord2.db>')
const db = new DatabaseSync(file, { readOnly: true })
const one = (sql) => Object.values(db.prepare(sql).get())[0]
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name)
const counts = {}
for (const t of tables) counts[t] = one(`SELECT COUNT(*) FROM "${t}"`)
const out = {
  file,
  integrity: one('PRAGMA integrity_check'),
  foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
  journalMode: one('PRAGMA journal_mode'),
  migrations: db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all().map((r) => `${r.version}:${r.name}`),
  triggers: db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((r) => r.name),
  counts
}
db.close()
console.log(JSON.stringify(out, null, 1))
process.exitCode = out.integrity === 'ok' && out.foreignKeyViolations === 0 ? 0 : 1
