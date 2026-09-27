// The message of anything thrown. `catch` binds `unknown`, and most of what is
// thrown here is an Error, but a rejected promise or a callback can hand back
// anything at all.
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
