import { useEffect, useState } from "react";
import { getThumbnailUrl } from "../lib/thumbnails";

/**
 * A card's picture as a small square. Cards are saved at full size (so they
 * can be Precise References), so lists show a cached, scaled-down copy.
 * `version` changes when the cards are re-read, picking up a new picture.
 */
export default function CardPicture({ path, size, version = 0 }: { path: string; size: number; version?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    getThumbnailUrl(path)
      .then((url) => !stale && setSrc(url))
      .catch(() => !stale && setSrc(null));
    return () => {
      stale = true;
    };
  }, [path, version]);
  return src ? (
    <img src={src} alt="" draggable={false} style={{ width: size, height: size, objectFit: "cover", borderRadius: 6, display: "block" }} />
  ) : (
    <span style={{ display: "block", width: size, height: size, borderRadius: 6, background: "var(--bg-page)" }} />
  );
}
