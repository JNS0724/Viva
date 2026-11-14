/**
 * The tools of dsh's sub-agents (system-design §11.7): read-only lookups, by allow list, so tools dsh or a plugin adds
 * later are not given to them. Since dsh 0.2.1 a sub-agent's tools are no longer set in the profile (tool-subagent lost
 * `toolFilter`); viva-routing narrows each sub-agent to these when it is created (plugins/routing/index.ts).
 */
export const SUBAGENT_TOOLS: readonly string[] = Object.freeze(['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_recall', 'search_conversations', 'read_conversation', 'todo_write'])
