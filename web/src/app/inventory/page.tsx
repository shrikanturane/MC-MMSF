import { InventoryView } from '@/features/inventory/InventoryView';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const { provider } = await searchParams;
  // key forces a remount when the provider query changes (topbar chips).
  return <InventoryView key={provider ?? 'all'} initialProvider={provider ?? 'all'} />;
}
