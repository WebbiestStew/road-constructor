import { ImageResponse } from "next/og";

/** The app icon at a requested square size (for the web manifest and home-screen installs). */
export function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  return ctx.params.then(({ size }) => {
    const px = size === "512" ? 512 : 192;
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "linear-gradient(135deg, #fb923c, #ec4899)",
            borderRadius: px * 0.22,
          }}
        >
          <div style={{ display: "flex", width: px * 0.34, height: px * 0.74, background: "#241b3d", clipPath: "polygon(30% 0, 70% 0, 100% 100%, 0 100%)", alignItems: "center", justifyContent: "center" }}>
            <div style={{ display: "flex", width: px * 0.03, height: px * 0.5, background: "#fff", borderRadius: px }} />
          </div>
        </div>
      ),
      { width: px, height: px }
    );
  });
}
