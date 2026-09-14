import { notFound } from 'next/navigation';
import { WebsiteStatsPanel } from '@/app/(business)/dashboard/owner/website-stats';
export default function WebsiteStatsPreview() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <main style={{ padding: 24, maxWidth: 1500, margin: '0 auto' }}>
      <p>
        Development preview · statistics require an authenticated owner API or a local fixture
        server.
      </p>
      <WebsiteStatsPanel businessId="11111111-1111-4111-8111-111111111111" />
    </main>
  );
}
