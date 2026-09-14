import { notFound } from 'next/navigation';
import WrittenSalesPage from '@/app/(business)/reports/written-sales/page';

export default function WrittenSalesPreview() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <main style={{ padding: 24 }}>
      <p>Development preview · use an authenticated API or a local sample report server.</p>
      <WrittenSalesPage />
    </main>
  );
}
