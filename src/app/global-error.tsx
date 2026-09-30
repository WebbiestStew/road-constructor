"use client";

export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(160deg, #ffe8a3 0%, #ffd1e8 45%, #c7b4f7 100%)",
          fontFamily: "system-ui, sans-serif",
          color: "#241b3d",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div>
          <h1>Road Constructor hit a pothole</h1>
          <p>Something went badly wrong. Your network is autosaved.</p>
          <button onClick={() => retry()} style={{ padding: "8px 20px", fontWeight: 700, borderRadius: 999 }}>
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
