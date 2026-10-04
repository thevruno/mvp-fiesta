import { GuestClient } from "@/components/GuestClient";

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <div className="min-h-screen bg-neutral-950">
      <GuestClient code={code.toUpperCase()} />
    </div>
  );
}
