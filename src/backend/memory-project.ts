import { memoryProjectScope } from '../memory/node/project-scope.ts'
export { memoryProjectScope }

/** A topic can be visible in several workspaces; its model-visible memory scope stays in the original project. */
export function memoryConversationScope(topic: string, project?: ReturnType<typeof memoryProjectScope>) {
  return { kind: 'conversation' as const, id: project ? `${topic}@${project.id}` : topic }
}
