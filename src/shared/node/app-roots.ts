import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where `npm run build` puts the app as it runs (scripts/build.mjs), laid out like the repository. */
export const BUILD_DIR = 'out'

/**
 * Where the app's code is (its src/ and plugins/) and where the project is (node_modules, build/, test/fixtures,
 * workspace/), from the path of this file (src/shared/node/app-roots): one folder when the app runs from the sources,
 * out/ and the folder around it once built (in the repository, and inside app.asar). The shell and the backend both
 * read them; src/shared/node is what they share that needs Node, and the pages never load it.
 */
export function rootsOf(file: string): { codeRoot: string, appRoot: string } {
  const codeRoot = path.resolve(path.dirname(file), '..', '..', '..')
  return { codeRoot, appRoot: path.basename(codeRoot) === BUILD_DIR ? path.dirname(codeRoot) : codeRoot }
}

export const { codeRoot: CODE_ROOT, appRoot: APP_ROOT } = rootsOf(fileURLToPath(import.meta.url))
