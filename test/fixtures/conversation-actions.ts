import { createConversationActions } from '../../src/renderer/conversation-actions.ts'
import { initialState, reduce } from '../../src/renderer/state.ts'

export const settle = () => new Promise<void>(resolve => setImmediate(resolve))

export function harness(overrides: Partial<Parameters<typeof createConversationActions>[0]['api']> = {}) {
  let state: State = { ...initialState, info: { mode: 'live', model: '', cwd: '/work' } }
  const prompts: Array<{ text: string, images?: Array<{ id: string }> }> = []
  const steers: string[] = [], toasts: string[] = [], pictures: string[] = []
  let resets = 0
  const dispatch = (action: Action) => { state = reduce(state, action) }
  const actions = createConversationActions({
    api: {
      prompt: async (text, images) => { prompts.push({ text, images }) },
      steer: async text => { steers.push(text); return { ok: true } },
      answerQuestion: async () => true, provideSecrets: async () => true,
      ...overrides,
    },
    getState: () => state, dispatch, errorMessage: String, showToast: text => { toasts.push(text) },
    beforePrompt: () => { resets++ }, keepPicture: id => { pictures.push(id) }, now: () => 123,
  })
  return { actions, prompts, steers, toasts, pictures, dispatch, state: () => state, resets: () => resets,
    change: (change: Partial<State>) => { state = { ...state, ...change } } }
}
