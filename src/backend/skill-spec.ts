import YAML from 'yaml'

/**
 * A skill as dsh reads it (dsh-skill-filesystem, 0.2.0-rc.2), so what the app lists as fine is what dsh loads and what
 * it lists as broken says why dsh skips it: dsh only warns in its log, and the model never learns a skill was left out.
 * The rules, as dsh has them: a `---` first line and a `---` line closing YAML that parses to fields; `name` and
 * `description` as non-empty text; the name in kebab case; `disable-model-invocation` and `user-invocable`, when
 * written, booleans (true/false, yes/no, on/off, 1/0), and their old camelCase spellings refused.
 */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Why dsh skips a skill: no frontmatter (or YAML that does not parse), name or description missing, a name not in kebab case, a bad switch. */
export type SkillIssue = 'frontmatter' | 'fields' | 'name-format' | 'invocation'

export interface SkillCheck {
  /** As written; empty when there is none. */
  name: string
  description: string
  /** Empty when dsh loads it. */
  issues: readonly SkillIssue[]
}

const SWITCHES = ['disable-model-invocation', 'user-invocable'] as const
const OLD_SWITCHES = ['disableModelInvocation', 'modelInvocable', 'userInvocable'] as const
const BOOLEAN_WORDS = new Set(['true', 'yes', 'on', 'false', 'no', 'off', '1', '0'])

/** The YAML between the opening and closing `---` lines, as fields; null when there is none or it is not fields. */
function frontmatter(source: string): Record<string, unknown> | null {
  const lines = source.split('\n').map((line) => line.replace(/\r$/, ''))
  if (lines[0] !== '---') return null
  const closing = lines.indexOf('---', 1)
  if (closing < 0) return null
  try {
    const data: unknown = YAML.parse(lines.slice(1, closing).join('\n'))
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : null
  } catch {
    return null
  }
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

const isBoolean = (value: unknown): boolean => typeof value === 'boolean' || value === 0 || value === 1
  || (typeof value === 'string' && BOOLEAN_WORDS.has(value.toLowerCase()))

function issuesOf(data: Record<string, unknown>, name: string, description: string): SkillIssue[] {
  if (!name || !description) return ['fields']
  if (!SKILL_NAME.test(name)) return ['name-format']
  const badSwitch = SWITCHES.some((key) => Object.hasOwn(data, key) && !isBoolean(data[key]))
    || OLD_SWITCHES.some((key) => Object.hasOwn(data, key))
  return badSwitch ? ['invocation'] : []
}

/** What dsh makes of a SKILL.md (or a single-file skill), and why it would skip it. */
export function checkSkill(source: string): SkillCheck {
  const data = frontmatter(source)
  if (!data) return { name: '', description: '', issues: ['frontmatter'] }
  const name = textOf(data.name)
  const description = textOf(data.description)
  return { name, description, issues: issuesOf(data, name, description) }
}
