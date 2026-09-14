import { notFound } from 'next/navigation';
import CashDrawerBalancingPage from '@/app/(business)/reports/cash-drawer-balancing/page';

export default function CashDrawerBalancingPreview() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <main style={{ padding: 24 }}>
      <p className="no-print">
        Development preview · use an authenticated API or a local sample report server.
      </p>
      <CashDrawerBalancingPage />
    </main>
  );
}
