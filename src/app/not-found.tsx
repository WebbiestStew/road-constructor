import Link from "next/link";
import FallbackScreen from "@/components/FallbackScreen";

export default function NotFound() {
  return (
    <FallbackScreen title="Dead end">
      <p>There&apos;s no road here.</p>
      <Link href="/" className="mt-3 inline-block font-bold text-violet-700 underline">
        Back to the map
      </Link>
    </FallbackScreen>
  );
}
