import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RECENT, forgetDir, sameDir, withRecent, workDirProblem } from '../src/main/work-dir.ts'

/** Which folders may be the working directory, and the list of folders used lately. */

const folders = (...dirs) => ({ isDirectory: (dir) => dirs.includes(dir) })
const mac = (dirs) => ({ platform: 'darwin', home: '/Users/me', ...folders(...dirs) })
const win = (dirs) => ({ platform: 'win32', home: 'C:\\Users\\me', env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' }, ...folders(...dirs) })

test('a folder of the user\'s own, with spaces or Chinese in its name, may be the working directory', () => {
  assert.equal(workDirProblem('/Users/me/Projects/季度 报表', mac(['/Users/me/Projects/季度 报表'])), null)
  assert.equal(workDirProblem('D:\\工作\\my site', win(['D:\\工作\\my site'])), null)
})

test('a disk, the home folder itself, and the system\'s folders are refused, each saying why', () => {
  assert.match(workDirProblem('/', mac(['/'])), /整个磁盘/)
  assert.match(workDirProblem('C:\\', win(['C:\\'])), /整个磁盘/)
  assert.match(workDirProblem('/Users/me', mac(['/Users/me'])), /主目录/)
  assert.match(workDirProblem('C:\\Users\\me', win(['C:\\Users\\me'])), /主目录/)
  assert.match(workDirProblem('/System/Library', mac(['/System/Library'])), /系统/)
  assert.match(workDirProblem('/usr/local/bin', mac(['/usr/local/bin'])), /系统/)
  assert.match(workDirProblem('C:\\Windows\\System32', win(['C:\\Windows\\System32'])), /系统/)
  assert.match(workDirProblem('c:\\program files\\App', win(['c:\\program files\\App'])), /系统/, 'Windows paths compare without case')
})

test('a network path, a relative path, and a folder that is not there are refused', () => {
  assert.match(workDirProblem('\\\\server\\share\\docs', win(['\\\\server\\share\\docs'])), /网络/)
  assert.match(workDirProblem('Projects/site', mac(['Projects/site'])), /完整路径/)
  assert.match(workDirProblem('/Users/me/gone', mac([])), /不是一个文件夹/)
  assert.match(workDirProblem('', mac([])), /完整路径/)
})

test('the folders used lately: newest first, each once, at most a few', () => {
  const once = withRecent(['/a', '/b'], '/b', 'darwin')
  assert.deepEqual(once, ['/b', '/a'])
  assert.deepEqual(withRecent(['C:\\Work\\Site'], 'c:\\work\\site\\', 'win32'), ['c:\\work\\site\\'], 'the same folder, spelt differently, is one')
  const many = Array.from({ length: MAX_RECENT + 3 }, (_, i) => `/d${i}`).reduce((list, dir) => withRecent(list, dir, 'linux'), [])
  assert.equal(many.length, MAX_RECENT)
  assert.equal(many[0], `/d${MAX_RECENT + 2}`)
  assert.deepEqual(forgetDir(['/a', '/b'], '/a/', 'linux'), ['/b'])
  const original = ['/a']
  withRecent(original, '/b', 'linux')
  assert.deepEqual(original, ['/a'], 'the list given is left as it was')
})

test('the same folder is the same whatever the trailing separator, and on Windows whatever the case', () => {
  assert.equal(sameDir('/a/b/', '/a/b', 'linux'), true)
  assert.equal(sameDir('/a/B', '/a/b', 'linux'), false)
  assert.equal(sameDir('C:\\A\\b', 'c:\\a\\B\\', 'win32'), true)
})
