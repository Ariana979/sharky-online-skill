// package-skill.ts — package this skill for distribution.
//
//   bun scripts/package-skill.ts [--out dist/sharky-online.zip]
//
// Produces a zip whose single top-level folder is named after the skill
// (frontmatter `name` — claude.ai's upload validator requires the folder
// name to match it). The same archive serves every install channel:
//   - claude.ai / Claude web & desktop: Settings > Capabilities > Skills > upload
//   - Claude Code CLI (machine-wide):  unzip -d ~/.claude/skills/
//   - Claude Code (per-project):       unzip -d <project>/.claude/skills/
// The folder name doubles as the slash command in Claude Code
// (/sharky-online), so the archive keeps it stable regardless of what the
// repo checkout is called.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const args: Record<string, string> = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] ?? ''
}

const skillRoot = resolve(import.meta.dir, '..')
const front = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8').match(/^---\n([\s\S]*?)\n---/)
const name = front?.[1].match(/^name:\s*(\S+)/m)?.[1]
if (!name) {
  console.error('SKILL.md frontmatter has no `name:` — cannot derive the folder name')
  process.exit(1)
}

const outPath = resolve(args.out || join(skillRoot, 'dist', `${name}.zip`))
mkdirSync(dirname(outPath), { recursive: true })

// Stage into <tmp>/<name>/ so the zip's single top-level folder matches the
// skill name exactly, whatever this checkout is called.
const stage = mkdtempSync(join(tmpdir(), 'sharky-skill-pkg-'))
const SHIP = ['SKILL.md', 'README.md', '.release', 'assets', 'examples', 'references', 'scripts']
try {
  const dest = join(stage, name)
  mkdirSync(dest)
  for (const entry of SHIP) {
    try { cpSync(join(skillRoot, entry), join(dest, entry), { recursive: true }) } catch { /* .release absent in some copies */ }
  }
  rmSync(outPath, { force: true })
  const zip = spawnSync('zip', ['-r', '-q', outPath, name], { cwd: stage, stdio: 'inherit' })
  if (zip.error || zip.status !== 0) {
    console.error('`zip` failed or is not installed (macOS/Linux ship it; on Windows use WSL or compress the staged folder below by hand)')
    console.error(`staged folder left at: ${dest}`)
    process.exit(1)
  }
} finally {
  rmSync(stage, { recursive: true, force: true })
}

const kb = Math.round(statSync(outPath).size / 1024)
console.log(`packaged ${name} -> ${outPath} (${kb} KB)`)
console.log(`install (Claude Code, machine-wide):  unzip ${outPath} -d ~/.claude/skills/`)
console.log(`install (per-project):                unzip ${outPath} -d .claude/skills/`)
console.log(`upload  (claude.ai / desktop):        Settings > Capabilities > Skills > upload the zip`)
