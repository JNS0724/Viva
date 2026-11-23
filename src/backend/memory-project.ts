import { memoryProjectScope } from '../memory/node/project-scope.ts'
export { memoryProjectScope }
export { resolveMemoryProject } from '../memory/node/project-scope.ts'

/** Foreground originals share memory within their authenticated user or project. */
export function foregroundMemoryScope(project?: ReturnType<typeof memoryProjectScope>) {
  return project ?? { kind: 'user' as const }
}
