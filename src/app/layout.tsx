import type { Metadata } from "next";
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
      <body className={`${manrope.variable} ${overpass.variable} antialiased`}>{children}</body>
    </html>
  );
}
