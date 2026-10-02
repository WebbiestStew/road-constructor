// Turns a NetworkSnapshot into a /play#data=… share link payload, for loading hand-built test layouts in the browser.
import { gzipSync } from "node:zlib";
import type { NetworkSnapshot } from "../../src/sim/types";

export function toShareHash(network: NetworkSnapshot, budget = 1e12): string {
  const payload = { version: 1, network, budget, nextNodeSeq: 1000, nextEdgeSeq: 1000 };
  return gzipSync(Buffer.from(JSON.stringify(payload))).toString("base64url");
}
