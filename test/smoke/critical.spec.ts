import { test, expect } from './fixtures.ts'

test('fresh app opens usable settings without a model', async ({ scenario }) => {
  const run = await scenario({ phase: 'setup', bridge: 'real' })
  const { page } = await run.start('startup')
  await expect(page.locator('#composer-input')).toBeDisabled()
  await page.getByRole('button', { name: '回顾、后台、关于你和设置', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.locator('#settings-root')).toBeVisible()
})

test('a real embedded agent answers and history survives a restart', async ({ scenario }) => {
  const run = await scenario({ phase: 'memory', bridge: 'real' })
  let session = await run.start('send')
  await session.page.locator('#composer-input').fill('你好，外部冒烟验证')
  await session.page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(session.page.locator('.msg-agent .msg-text').last()).toContainText('外部冒烟验证')
  await expect(session.page.locator('#send-btn')).toHaveAttribute('data-busy', 'false')
  session = await run.start('restart')
  await expect(session.page.locator('.msg-user').last()).toContainText('外部冒烟验证')
  await expect(session.page.locator('.msg-agent .msg-text').last()).toContainText('外部冒烟验证')
})
