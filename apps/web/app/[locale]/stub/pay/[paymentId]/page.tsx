import { StubPayPage } from '@/views/stub-pay';

export default async function Page({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  return <StubPayPage paymentId={paymentId} />;
}
