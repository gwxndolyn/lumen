/**
 * Collapse concurrent calls into one: while a run is in flight, further calls get the same promise
 * instead of starting another. Used for shortcut-triggered screen captures, where key repeat or an
 * impatient double press would otherwise hide/show the panel and capture the screen several times.
 */
export function singleFlight<T>(fn: () => Promise<T>): (() => Promise<T>) & { readonly inFlight: boolean } {
  let current: Promise<T> | null = null;
  const run = () => {
    if (current) return current;
    current = (async () => {
      try {
        return await fn();
      } finally {
        current = null;
      }
    })();
    return current;
  };
  return Object.defineProperty(run, "inFlight", { get: () => current !== null }) as (() => Promise<T>) & { readonly inFlight: boolean };
}
