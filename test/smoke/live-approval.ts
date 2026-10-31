/** Live acceptance may change synthetic fixture files, never the host's security configuration. */
export function mayAutoApprove(cardText: string): boolean {
  return !/diagnose-windows-sandbox-acl|\b(?:icacls|takeown|secedit)(?:\.exe)?\b|\bSet-Acl\b|\b(?:Set|Add)-MpPreference\b/i.test(cardText)
}
