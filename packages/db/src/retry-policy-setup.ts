/** A rolling deploy competes with the old API's tenant transactions for locks. */
export async function retryPolicySetup(
  apply: () => Promise<void>,
  options: {
    attempts?: number;
    wait?: (milliseconds: number) => Promise<void>;
    onRetry?: (attempt: number) => void;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? 20;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await apply();
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if ((code !== '40P01' && code !== '55P03') || attempt >= attempts) throw error;
      options.onRetry?.(attempt);
      await wait(Math.min(2000, attempt * 200) + Math.floor(Math.random() * 250));
    }
  }
}
