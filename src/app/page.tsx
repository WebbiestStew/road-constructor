import Landing from "@/components/landing/Landing";

const site = process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

/** Structured data so search engines understand this is a free browser game. */
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "VideoGame",
  name: "Road Constructor",
  description: "A free 3D traffic-management game: fix the gridlock in pre-built cities and real places from OpenStreetMap.",
  url: site,
  genre: ["Simulation", "Strategy"],
  applicationCategory: "Game",
  operatingSystem: "Any (web browser)",
  playMode: "SinglePlayer",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default function Home() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Landing />
    </>
  );
}
