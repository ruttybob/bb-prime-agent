/**
 * Await a promise that must reject, and hand back the rejection. Keeps test
 * types honest: `.catch((error) => error)` on a resolved-promise type widens
 * to the resolved type again.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the promise to reject");
}
