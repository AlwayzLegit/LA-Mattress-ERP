'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { StorePeriod, StoresResponse } from './types';

export function useStores(period: StorePeriod, scopeKey: string) {
  const request = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{ data: StoresResponse; scopeKey: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(false);
    setResult(null);
    const qs = new URLSearchParams({ period });
    if (scopeKey) qs.set('locationIds', scopeKey);
    return api<StoresResponse>(`/v1/dashboard/stores?${qs}`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ data, scopeKey });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }, [period, scopeKey]);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);

  // A filter can change before its effect runs. Never render old rows under
  // the new period/scope, including when restoring a saved Today preference.
  const data = result?.data.period === period && result.scopeKey === scopeKey ? result.data : null;
  return { data, loading, error, load };
}
