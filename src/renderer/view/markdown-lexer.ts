// The renderer has no bundler. The build copies this file-based dependency.
// @ts-expect-error the module's declarations live at the package entry
import { Lexer as UntypedLexer } from '../../../node_modules/marked/lib/marked.esm.js'
import type { Lexer as MarkedLexer } from 'marked'

const Lexer: typeof MarkedLexer = UntypedLexer
export const lexMarkdown = (text: string) => new Lexer({ gfm: true }).lex(text)
