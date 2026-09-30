import type { Metadata, Viewport } from "next";
import { Manrope, Overpass } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
});

// Overpass is the open-source metric-compatible reimplementation of Highway
// Gothic (the FHWA road-sign alphabet) — the real font isn't freely licensed,
// this is the standard free substitute.
const overpass = Overpass({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

export const viewport: Viewport = {
  themeColor: "#c7b4f7",
  width: "device-width",
  initialScale: 1,
};

// Absolute base for social-card URLs: explicit override, else Vercel's production domain, else local dev.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Road Constructor (Beta) — Traffic Engineering Sandbox",
  applicationName: "Road Constructor",
  openGraph: {
    title: "Road Constructor (Beta)",
    description: "The city is built. The traffic is a mess. Make it flow.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
  description:
    "A 3D traffic-management sandbox. The city is built; fix the gridlock with lane arrows, speed limits and signal timing while every car drives for real (IDM + MOBIL models, Three.js).",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${manrope.variable} ${overpass.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
