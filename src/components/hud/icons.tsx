import type { SVGProps } from "react";

/**
 * Small line-style icon set for the HUD. Every icon is a plain functional
 * component taking standard SVG props (className drives size/color via
 * `currentColor`) — no icon library dependency, just hand-drawn 24x24 paths
 * in a consistent stroke style.
 */

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconDraw(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 20l1-4.2L15.6 5.2a1.5 1.5 0 0 1 2.1 0l1.1 1.1a1.5 1.5 0 0 1 0 2.1L8.2 19l-4.2 1z" />
      <path d="M14 6.5L17.5 10" />
    </svg>
  );
}

export function IconDelete(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V4.8c0-.44.36-.8.8-.8h4.4c.44 0 .8.36.8.8V7" />
      <path d="M6 7l.8 12.2c.04.98.86 1.8 1.84 1.8h6.72c.98 0 1.8-.82 1.84-1.8L18 7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function IconInspect(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.3 15.3L20 20" />
    </svg>
  );
}

export function IconZone(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 3v18" />
      <path d="M6 4.5h10.5c1 0 1.4 1.2.7 1.9l-2.9 2.9 2.9 2.9c.7.7.3 1.9-.7 1.9H6" />
    </svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <svg {...base} fill="currentColor" stroke="none" viewBox="0 0 24 24" {...props}>
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  );
}

export function IconPause(props: IconProps) {
  return (
    <svg {...base} fill="currentColor" stroke="none" viewBox="0 0 24 24" {...props}>
      <rect x="6" y="4.5" width="4.2" height="15" rx="1" />
      <rect x="13.8" y="4.5" width="4.2" height="15" rx="1" />
    </svg>
  );
}

export function IconCoin(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v9M14.6 9.7c0-1.1-1.1-1.7-2.6-1.7-1.6 0-2.7.7-2.7 1.9 0 2.7 5.3 1.3 5.3 4 0 1.2-1.2 1.9-2.7 1.9s-2.8-.6-2.9-1.8" />
    </svg>
  );
}

export function IconCar(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4.5 15.5l1.3-4.6A2 2 0 0 1 7.7 9.5h8.6a2 2 0 0 1 1.9 1.4l1.3 4.6" />
      <rect x="3.5" y="15.5" width="17" height="4" rx="1.3" />
      <circle cx="7.5" cy="19.5" r="1.4" />
      <circle cx="16.5" cy="19.5" r="1.4" />
      <path d="M7 12.5h10" />
    </svg>
  );
}

export function IconGauge(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 15a8 8 0 1 1 16 0" />
      <path d="M12 15l3.5-4.5" />
      <path d="M12 15h.01" />
    </svg>
  );
}

export function IconFlag(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 3v18" />
      <path d="M6 4.5h11.5c1 0 1.4 1.2.7 1.9L15.6 9l2.6 2.6c.7.7.3 1.9-.7 1.9H6" />
    </svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.2 2" />
    </svg>
  );
}

export function IconSignal(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="8" y="3" width="8" height="16" rx="3" />
      <circle cx="12" cy="7" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="11" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" />
      <path d="M12 19v2" />
    </svg>
  );
}

export function IconYield(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.5l9 16h-18z" />
      <path d="M8.3 8.5l7.4 9" />
    </svg>
  );
}

export function IconRoundabout(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v3.4M12 18.1v3.4M2.5 12h3.4M18.1 12h3.4" opacity={0.35} />
      <path d="M17.3 8.2a7.5 7.5 0 1 1-2.6-2.9" />
      <path d="M17.8 4.2l.6 3.8-3.8-.4" />
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function IconTrendUp(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 16l5.5-5.5L13 14l7-7" />
      <path d="M15 7h5v5" />
    </svg>
  );
}

export function IconRoad(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 3L4.5 21" />
      <path d="M16 3l3.5 18" />
      <path d="M12 4v3M12 10.5v3M12 17v3" />
    </svg>
  );
}
