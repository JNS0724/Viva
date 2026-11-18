/** Fault injection for processes created by the calling test. Never used by application code. */
import { spawn } from 'node:child_process'

export interface PausedProcess { resume(): Promise<void> }

// A separate, short-lived debugger owns the suspension on Windows. EOF resumes the target, and
// KillOnExit=false makes even an abruptly terminated helper detach rather than kill the fixture.
// https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-debugactiveprocess
const windowsPause = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class VivaOwnedProcessPause {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DebugActiveProcess(uint id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DebugActiveProcessStop(uint id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DebugSetProcessKillOnExit(bool kill);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WaitForDebugEvent(IntPtr data, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ContinueDebugEvent(uint process, uint thread, uint status);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Run(uint target) {
    IntPtr data = Marshal.AllocHGlobal(1024);
    bool attached = false, held = false;
    uint thread = 0, heldStatus = 0x80010001;
    try {
      Check(DebugActiveProcess(target)); attached = true;
      Check(DebugSetProcessKillOnExit(false));
      int union = IntPtr.Size == 8 ? 16 : 12;
      Stopwatch deadline = Stopwatch.StartNew();
      while (deadline.ElapsedMilliseconds < 10000) {
        if (!WaitForDebugEvent(data, 250)) {
          int error = Marshal.GetLastWin32Error();
          if (error == 121) continue;
          throw new Win32Exception(error);
        }
        uint kind = unchecked((uint)Marshal.ReadInt32(data, 0));
        uint process = unchecked((uint)Marshal.ReadInt32(data, 4));
        thread = unchecked((uint)Marshal.ReadInt32(data, 8));
        held = true;
        heldStatus = kind == 1 ? 0x80010001 : 0x00010002;
        // These image-file handles belong to the debugger. Process/thread handles belong to the OS.
        if (kind == 3 || kind == 6) {
          IntPtr file = Marshal.ReadIntPtr(data, union);
          if (file != IntPtr.Zero && file != new IntPtr(-1)) CloseHandle(file);
        }
        if (kind == 1 && unchecked((uint)Marshal.ReadInt32(data, union)) == 0x80000003) {
          heldStatus = 0x00010002;
          Console.WriteLine("READY"); Console.Out.Flush();
          Console.ReadLine(); // RESUME or EOF: both release this owned suspension.
          Check(ContinueDebugEvent(process, thread, 0x00010002)); held = false;
          Check(DebugActiveProcessStop(target)); attached = false;
          Console.WriteLine("RESUMED"); Console.Out.Flush();
          return;
        }
        Check(ContinueDebugEvent(process, thread, kind == 1 ? 0x80010001 : 0x00010002));
        held = false;
        if (kind == 5) throw new InvalidOperationException("Owned process exited before suspension");
      }
      throw new TimeoutException("Owned process suspension deadline");
    } finally {
      if (held) ContinueDebugEvent(target, thread, heldStatus);
      if (attached) DebugActiveProcessStop(target);
      Marshal.FreeHGlobal(data);
    }
  }
}
'@
[VivaOwnedProcessPause]::Run([uint32]$env:VIVA_DIAGNOSTIC_PAUSE_PID)
`

export async function pauseOwnedProcess(pid: number): Promise<PausedProcess> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('Expected an owned child process PID')
  if (process.platform !== 'win32') {
    process.kill(pid, 'SIGSTOP')
    let resumed = false
    return { async resume() {
      if (resumed) return
      resumed = true
      try { process.kill(pid, 'SIGCONT') } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
    } }
  }
  const helper = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsPause, 'utf16le').toString('base64')], {
    windowsHide: true, env: { ...process.env, VIVA_DIAGNOSTIC_PAUSE_PID: String(pid) }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let ready!: () => void, fail!: (error: Error) => void
  const started = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject })
  let output = '', errors = '', exited = false
  const exit = new Promise<number | null>(resolve => helper.once('close', (code, signal) => {
    exited = true
    fail(new Error(`Pause helper exited (${code ?? signal}): ${errors}`))
    resolve(code)
  }))
  helper.once('error', fail)
  helper.stdin.on('error', () => { /* Process exit owns failure reporting. */ })
  helper.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-2048) })
  helper.stdout.on('data', (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-2048)
    if (/(?:^|\n)READY\r?\n/.test(output)) ready()
  })
  let resume: Promise<void> | undefined
  const release = () => resume ??= (async () => {
    if (!exited) helper.stdin.end('RESUME\n')
    const terminate = setTimeout(() => { if (!exited) helper.kill() }, 5000)
    try {
      const code = await exit
      if (code !== 0 || !/(?:^|\n)RESUMED\r?\n/.test(output)) throw new Error(`Owned process resume failed: ${errors}`)
    } finally { clearTimeout(terminate) }
  })()
  const timeout = setTimeout(() => fail(new Error('Owned process suspension helper deadline')), 15_000)
  try { await started; return { resume: release } }
  catch (error) { await release().catch(() => {}); throw error }
  finally { clearTimeout(timeout) }
}
