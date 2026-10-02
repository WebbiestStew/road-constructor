import type { MetadataRoute } from "next";

/** Lets the game be installed to a home screen or dock and opened full-screen like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Road Constructor",
    short_name: "Road Constructor",
    description: "A free 3D traffic-management game. The city is built; fix the gridlock.",
    start_url: "/play",
    display: "standalone",
    orientation: "landscape",
    background_color: "#241b3d",
    theme_color: "#c7b4f7",
    categories: ["games", "simulation"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/app-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
