import { expect, it, vi } from 'vitest';
import { retryPolicySetup } from './retry-policy-setup';

it.each(['40P01', '55P03'])(
  'retries a rolled-back lock failure (%s) before completing',
  async (code) => {
    const apply = vi.fn().mockRejectedValueOnce({ code }).mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);
    await retryPolicySetup(apply, { wait });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  },
);

it('fails closed immediately for permission or SQL errors', async () => {
  const error = { code: '42501' };
  const apply = vi.fn().mockRejectedValue(error);
  const wait = vi.fn().mockResolvedValue(undefined);
  await expect(retryPolicySetup(apply, { wait })).rejects.toBe(error);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});

it('does not start the app if lock contention persists past the attempt limit', async () => {
  const error = { code: '40P01' };
  const apply = vi.fn().mockRejectedValue(error);
  const wait = vi.fn().mockResolvedValue(undefined);
  await expect(retryPolicySetup(apply, { attempts: 3, wait })).rejects.toBe(error);
  expect(apply).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledTimes(2);
});
