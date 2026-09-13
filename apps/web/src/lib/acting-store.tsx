'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * "Acting for {Store}" (redesign Phase 3, README §2): the one store every
 * sale, drawer and report on the screen belongs to. First control in the
 * topbar. Selling-restricted members can only pick stores they are
 * approved for; everyone else can switch; every switch is audited.
 *
 * The choice is kept per browser session under the key the register,
 * the Orders list and the manager home already read
 * (`jetnine.sellingStore`), so those screens follow the chip unchanged.
 */

export interface ActingLocation {
  id: string;
  name: string;
  locationType?: string;
}

export interface MemberMe {
  membershipId: string | null;
  roleName: string | null;
  hiddenNav: string[];
  sellingScope: 'all' | 'approved';
  scopeLocations: ActingLocation[];
  managerDashboard?: boolean;
  operationsDashboard?: boolean;
  warehouseDashboard?: boolean;
  cashierDashboard?: boolean;
  /** Whether the API returns cost figures to this viewer (`products.cost.view`). */
  canSeeCost?: boolean;
}

interface ActingStore {
  /** The caller's own membership snapshot; null until loaded, `false` on error. */
  me: MemberMe | null;
  meReady: boolean;
  store: ActingLocation | null;
  choices: ActingLocation[];
  canSwitch: boolean;
  /** First login for a multi-store, selling-restricted member: they must pick. */
  mustPick: boolean;
  setStore: (loc: ActingLocation, opts?: { silent?: boolean }) => void;
  dismissPick: () => void;
}

const Ctx = createContext<ActingStore | null>(null);
export const SELLING_STORE_KEY = 'jetnine.sellingStore';

function readSaved(): ActingLocation | null {
  try {
    const raw = sessionStorage.getItem(SELLING_STORE_KEY);
    return raw ? (JSON.parse(raw) as ActingLocation) : null;
  } catch {
    return null;
  }
}

export function ActingStoreProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MemberMe | null>(null);
  const [meReady, setMeReady] = useState(false);
  const [choices, setChoices] = useState<ActingLocation[]>([]);
  const [store, setStoreState] = useState<ActingLocation | null>(null);
  const [mustPick, setMustPick] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let m: MemberMe | null = null;
      try {
        m = await api<MemberMe>('/v1/business/members/me');
      } catch {
        m = null;
      }
      if (!alive) return;
      setMe(m);
      setMeReady(true);

      let list: ActingLocation[] = [];
      if (m?.sellingScope === 'approved') {
        list = m.scopeLocations ?? [];
      } else {
        try {
          const rows = await api<ActingLocation[]>('/v1/business/locations');
          list = rows.map((r) => ({ id: r.id, name: r.name, locationType: r.locationType }));
        } catch {
          try {
            const rows = await api<ActingLocation[]>('/v1/pos/locations');
            list = rows.map((r) => ({ id: r.id, name: r.name, locationType: r.locationType }));
          } catch {
            list = m?.scopeLocations ?? [];
          }
        }
        // Stores first, warehouse last.
        list = [...list].sort((a, b) => {
          const wa = a.locationType === 'warehouse' ? 1 : 0;
          const wb = b.locationType === 'warehouse' ? 1 : 0;
          return wa - wb || a.name.localeCompare(b.name);
        });
      }
      if (!alive) return;
      setChoices(list);

      const saved = readSaved();
      const valid = saved ? list.find((l) => l.id === saved.id) : undefined;
      if (valid) {
        setStoreState(valid);
      } else if (list.length === 1) {
        setStoreState(list[0]!);
        persist(list[0]!);
      } else if (m?.sellingScope === 'approved' && list.length > 1) {
        setMustPick(true);
      } else if (list.length > 1) {
        const first = list.find((l) => l.locationType !== 'warehouse') ?? list[0]!;
        setStoreState(first);
        persist(first);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setStore = useCallback(
    (loc: ActingLocation, opts?: { silent?: boolean }) => {
      const previous = store;
      setStoreState(loc);
      setMustPick(false);
      persist(loc);
      window.dispatchEvent(new CustomEvent('erp:acting-store', { detail: loc }));
      if (previous?.id === loc.id) return;
      // Audited on change (README §2). Fire and forget: the chip must not wait on it.
      void api('/v1/business/members/me/acting-store', {
        method: 'POST',
        body: JSON.stringify({ locationId: loc.id, previousLocationId: previous?.id ?? null }),
      }).catch(() => undefined);
      if (!opts?.silent) toast.success(`Acting for ${loc.name}`);
    },
    [store],
  );

  const value = useMemo<ActingStore>(
    () => ({
      me,
      meReady,
      store,
      choices,
      canSwitch: choices.length > 1,
      mustPick,
      setStore,
      dismissPick: () => setMustPick(false),
    }),
    [me, meReady, store, choices, mustPick, setStore],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function persist(loc: ActingLocation) {
  try {
    sessionStorage.setItem(SELLING_STORE_KEY, JSON.stringify({ id: loc.id, name: loc.name }));
  } catch {
    // Session storage unavailable — the choice lasts for this page only.
  }
}

export function useActingStore(): ActingStore {
  const v = useContext(Ctx);
  if (!v) throw new Error('useActingStore needs ActingStoreProvider');
  return v;
}

/** Tolerant variant for components that may render outside the shell. */
export function useOptionalActingStore(): ActingStore | null {
  return useContext(Ctx);
}
