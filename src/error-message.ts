/**
 * One error-to-text rendering shared by every log line that reports a caught
 * thing (bbpa-b1m.11): Errors contribute their message, everything else is
 * stringified. Kept dependency-free so any module can import it.
 */

/** The message an `Error` carries, or the string form of anything else. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
