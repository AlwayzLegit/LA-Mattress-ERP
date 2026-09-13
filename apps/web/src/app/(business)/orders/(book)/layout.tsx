import type { ReactNode } from 'react';
import { OrdersBook } from '@/components/orders/orders-book';

/**
 * The orders book (redesign Phase 6): `/orders` is the list; `/orders/[id]`
 * is the same list with the order's slide-over open, so the URL names the
 * order and the list never remounts behind it. The full order workspace
 * stays at `/orders/[id]/full`, outside this group.
 */
export default function OrdersBookLayout({ children }: { children: ReactNode }) {
  return <OrdersBook>{children}</OrdersBook>;
}
