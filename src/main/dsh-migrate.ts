import fs from 'node:fs'
import path from 'node:path'
import { removeTree } from './remove-tree.ts'

/**
 * The app's dsh used to share the user's `~/.dsh`. Moving to its own home (dsh-runtime.js) brings along
 * what belongs to the app and leaves the rest:
 * - the sessions of the app's workspace, so old conversations still resume and show their 过程 (copied,
 *   never moved or overwritten; dsh groups sessions by working directory, so the user's own stay apart);
 * - the skills in `~/.dsh/skills` (the app imported into that folder), copied once: a skill the user then
 *   removes from the app stays removed, and the user's own dsh keeps its folder as it was;
 * - the profiles the app wrote there (`viva`, earlier `my-agent`) are removed, and only when their manifest
 *   says the app wrote them.
 */
const OWN_PROFILES = Object.freeze({ viva: 'dsh-profile-viva', 'my-agent': 'dsh-profile-my-agent' })

/**
 * dsh's folder name for a working directory (dsh-session-persistence-jsonl `projectKey`, which it does
 * not export): separators become `-`, other unsafe characters `~XXXX`.
 */
export function projectKey(cwd: string) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (const ch of cwd.split('')) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Copies the sessions of `cwd` from the old home unless the new one has them already.
 * @returns sessions copied
 */
export function adoptDshSessions({ fromHome, toHome, cwd }: { fromHome: string, toHome: string, cwd: string }): number {
  if (path.resolve(fromHome) === path.resolve(toHome)) return 0
  const key = projectKey(cwd)
  const source = path.join(fromHome, 'sessions', key)
  const target = path.join(toHome, 'sessions', key)
  if (!fs.existsSync(source) || fs.existsSync(target)) return 0
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true, errorOnExist: false, force: false })
  return fs.readdirSync(target).length
}

/** Left in the app's dsh home once its skills have been brought over. */
const SKILLS_ADOPTED = '.skills-adopted'

/**
 * Copies the old home's skills (folders and single `.md` files) that the app's home does not have yet,
 * on the first launch only.
 * @returns skills copied
 */
export function adoptDshSkills({ fromHome, toHome }: { fromHome: string, toHome: string }): string[] {
  if (path.resolve(fromHome) === path.resolve(toHome)) return []
  const marker = path.join(toHome, SKILLS_ADOPTED)
  if (fs.existsSync(marker)) return []
  const source = path.join(fromHome, 'skills')
  const target = path.join(toHome, 'skills')
  const names = fs.existsSync(source) ? fs.readdirSync(source).filter((name) => !name.startsWith('.')) : []
  const copied = names.filter((name) => !fs.existsSync(path.join(target, name))).map((name) => {
    fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true, errorOnExist: false, force: false, dereference: false })
    return name
  })
  fs.mkdirSync(toHome, { recursive: true })
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
  return copied
}

const manifestName = (dir: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name
  } catch {
    return null
  }
}

/**
 * Removes the profiles the app wrote into the old home. Their plugin links point into the app, so they
 * are unlinked rather than followed (remove-tree.js).
 * @returns profiles removed
 */
export function removeOwnProfiles({ fromHome, toHome }: { fromHome: string, toHome: string }): string[] {
  if (path.resolve(fromHome) === path.resolve(toHome)) return []
  return Object.entries(OWN_PROFILES)
    .filter(([profile, name]) => manifestName(path.join(fromHome, 'profiles', profile)) === name)
    .map(([profile]) => {
      removeTree(path.join(fromHome, 'profiles', profile))
      return profile
    })
}
