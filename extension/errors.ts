// The message of anything thrown. `catch` binds `unknown`, and a rejected
// chrome.* promise or a callback can hand back anything at all.
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
