import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Road Constructor (Beta): a free 3D traffic game with real cities";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  // A real screenshot of the game (Midtown Manhattan) as the backdrop, darkened on the left so the title reads.
  let backdrop = "";
  try {
    const img = await readFile(path.join(process.cwd(), "docs", "og.jpg"));
    backdrop = `data:image/jpeg;base64,${img.toString("base64")}`;
  } catch {
    backdrop = "";
  }
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#241b3d" }}>
        {backdrop && <img src={backdrop} alt="" width={1200} height={630} style={{ position: "absolute", inset: 0, width: 1200, height: 630, objectFit: "cover" }} />}
        <div style={{ position: "absolute", left: 0, top: 0, width: 800, height: 630, display: "flex", backgroundColor: "rgba(36,27,61,0.88)" }} />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "center", padding: 72, width: 760, color: "#fff" }}>
          <div style={{ display: "flex", fontSize: 28, fontWeight: 800, letterSpacing: 4, color: "#ffb703" }}>FREE · IN YOUR BROWSER · BETA</div>
          <div style={{ display: "flex", fontSize: 96, fontWeight: 800, lineHeight: 1.02, marginTop: 14 }}>Road Constructor</div>
          <div style={{ display: "flex", fontSize: 40, marginTop: 22, lineHeight: 1.25 }}>The city is built. The traffic is a mess. Make it flow.</div>
          <div style={{ display: "flex", fontSize: 28, marginTop: 30, color: "#d8cdf5" }}>Real cities from OpenStreetMap · signals · buses · ambulances</div>
        </div>
      </div>
    ),
    size
  );
}
