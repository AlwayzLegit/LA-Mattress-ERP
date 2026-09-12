'use client';

import { useParams } from 'next/navigation';
import { OrderSheet } from '@/components/orders/order-sheet';

export default function OrderSheetPage() {
  const params = useParams<{ id: string }>();
  return <OrderSheet id={params.id} />;
}
