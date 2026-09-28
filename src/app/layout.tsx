import type { Metadata } from "next";
import { Overpass } from "next/font/google";
import "./globals.css";

// Overpass is the open-source metric-compatible reimplementation of Highway
// Gothic (the FHWA road-sign alphabet) — the real font isn't freely licensed,
// this is the standard free substitute. Used everywhere (body text and
// display headings both resolve to it, see --font-sans/--font-display in
// globals.css), so the full range of weights Tailwind utility classes
// reference (font-normal through font-black) is loaded here rather than
// just the bold display-only subset it used to cover.
const overpass = Overpass({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-highway",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Road Constructor — Traffic Engineering Sandbox",
  description:
    "Design road networks, open them to traffic, and see if they hold up — a 3D microscopic traffic simulation built with IDM + MOBIL car-following models, Three.js and React Three Fiber.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${overpass.variable} antialiased`}>{children}</body>
    </html>
  );
}
