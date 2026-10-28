import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mayAutoApprove } from '../src/main/live-approval.ts'

test('live acceptance does not automatically approve OS security or ACL changes', () => {
  for (const text of ['pwsh Set-Acl E:\\fixture', 'icacls.exe E:\\fixture /grant', 'takeown /F E:\\fixture', 'diagnose-windows-sandbox-acl.ps1', 'Set-MpPreference -DisableRealtimeMonitoring $true']) {
    assert.equal(mayAutoApprove(text), false, text)
  }
  for (const text of ['读取工作区外的测试文件', '创建 notes.md', '接入测试 MCP mail-123', '创建周报 skill']) assert.equal(mayAutoApprove(text), true)
})
