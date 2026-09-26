import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Road Constructor — 3D Microscopic Traffic Simulation",
  description:
    "Real-time 3D microscopic traffic simulation of a highway interchange using IDM + MOBIL car-following models, Three.js and React Three Fiber.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
