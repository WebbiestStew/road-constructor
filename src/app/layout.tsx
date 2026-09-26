import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-ui",
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
      <body className={`${manrope.variable} antialiased`}>{children}</body>
    </html>
  );
}
