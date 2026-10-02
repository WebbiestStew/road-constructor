import { grabFrame } from "./photoMode";

/** A 1200x630 card (the size link previews use) built from the live 3D view plus the level's name, stars and result. */
export async function makeShareCard(opts: { title: string; stars: number; lines: string[] }): Promise<Blob | null> {
  const frame = await grabFrame();
  if (!frame) return null;
  const img = await createImageBitmap(frame);
  const W = 1200;
  const H = 630;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // The scene, cropped to fill the card.
  const scale = Math.max(W / img.width, H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);

  // A dark band on the left so the text reads over any map.
  const grad = ctx.createLinearGradient(0, 0, W * 0.72, 0);
  grad.addColorStop(0, "rgba(36,27,61,0.92)");
  grad.addColorStop(1, "rgba(36,27,61,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "alphabetic";
  ctx.font = `800 26px ${family}`;
  ctx.fillStyle = "#ffb703";
  ctx.fillText("ROAD CONSTRUCTOR", 64, 88);

  ctx.fillStyle = "#ffffff";
  ctx.font = `900 64px ${family}`;
  const words = opts.title.toUpperCase().split(" ");
  let line = "";
  let y = 190;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > 640 && line) {
      ctx.fillText(line, 64, y);
      line = word;
      y += 72;
    } else line = test;
  }
  ctx.fillText(line, 64, y);

  ctx.font = `900 72px ${family}`;
  ctx.fillStyle = "#ffd166";
  ctx.fillText("★".repeat(opts.stars) + "☆".repeat(3 - opts.stars), 64, y + 100);

  ctx.font = `700 30px ${family}`;
  ctx.fillStyle = "#ffffff";
  opts.lines.slice(0, 3).forEach((l, i) => ctx.fillText(l.length > 52 ? `${l.slice(0, 51)}…` : l, 64, y + 160 + i * 42));

  ctx.font = `700 24px ${family}`;
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText(`Think you can beat it? ${window.location.host}`, 64, H - 48);

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

/** Hands a file to the phone's share sheet where there is one, and otherwise downloads it. Returns how it went. */
export async function shareOrDownload(blob: Blob, filename: string, text: string): Promise<"shared" | "downloaded"> {
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], text });
      return "shared";
    } catch {
      // cancelled or refused: fall through to a download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return "downloaded";
}
