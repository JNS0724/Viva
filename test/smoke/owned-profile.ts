import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const MARKER = '.viva-smoke-owner'
export interface OwnedProfile { base: string, root: string, userData: string, workspace: string, owner: string }

/** Each logical scenario gets a newly created profile; restart checks reuse it only within that scenario. */
export function createOwnedProfile(directory: string, label: string): OwnedProfile {
  fs.mkdirSync(path.resolve(directory), { recursive: true })
  const base = fs.realpathSync(path.resolve(directory))
  const root = fs.mkdtempSync(path.join(base, `profile-${label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}-`))
  const owner = randomUUID()
  const userData = path.join(root, 'userData')
  const workspace = path.join(userData, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(root, MARKER), owner, { flag: 'wx' })
  return Object.freeze({ base, root, userData, workspace, owner })
}

export function assertOwnedProfile(profile: OwnedProfile): void {
  const base = fs.realpathSync(profile.base)
  const root = fs.realpathSync(profile.root)
  if (root !== path.resolve(profile.root) || !root.startsWith(base + path.sep)) throw new Error('Profile escaped its owned directory')
  if (fs.readFileSync(path.join(root, MARKER), 'utf8') !== profile.owner) throw new Error('Profile ownership marker does not match')
  for (const directory of [profile.userData, profile.workspace]) {
    if (!fs.realpathSync(directory).startsWith(root + path.sep)) throw new Error('Profile data escaped its owned directory')
  }
}

export function disposeOwnedProfile(profile: OwnedProfile): void {
  assertOwnedProfile(profile)
  // The canonical absolute target and marker above are verified before this recursive delete.
  fs.rmSync(profile.root, { recursive: true, maxRetries: 3, retryDelay: 150 })
}
