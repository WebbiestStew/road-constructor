import { ImageResponse } from "next/og";

export const alt = "Road Constructor (Beta) — Traffic Engineering Sandbox";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 80,
          background: "linear-gradient(160deg, #ffe8a3 0%, #ffd1e8 45%, #c7b4f7 100%)",
          color: "#241b3d",
        }}
      >
        <div style={{ display: "flex", fontSize: 30, fontWeight: 800, letterSpacing: 4 }}>BETA</div>
        <div style={{ display: "flex", fontSize: 120, fontWeight: 800, lineHeight: 1.05 }}>Road Constructor</div>
        <div style={{ display: "flex", fontSize: 44, marginTop: 24 }}>
          The city is built. The traffic is a mess. Make it flow.
        </div>
      </div>
    ),
    size
  );
}
