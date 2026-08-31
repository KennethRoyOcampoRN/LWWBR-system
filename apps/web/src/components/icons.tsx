// Spec §11 M6 (visual redesign, 2026-08-31): "small circular icon
// badges" needed real icons, and the app had none anywhere. Hand-rolled
// inline SVGs rather than an icon library — no new dependency, same
// convention as the mobile nav's hamburger glyph — so this is a small,
// deliberately minimal set (one icon per Command Center KPI/section),
// not a general-purpose icon library. Add to it as needed, don't import
// one wholesale for a handful of glyphs.
//
// Every icon shares the same 24x24 viewBox, stroke-based outline style
// (strokeWidth 2, round caps/joins) so they read as one consistent set
// regardless of which one renders next to which.
import type { SVGProps } from 'react';

function IconBase(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

// Occupied — a simple bed glyph.
export function IconBed(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M3 18v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7" />
      <path d="M3 18v2" />
      <path d="M21 18v2" />
      <path d="M3 13h18" />
      <path d="M7 13V9a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1" />
    </IconBase>
  );
}

// Ready.
export function IconCheck(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M20 6 9 17l-5-5" />
    </IconBase>
  );
}

// Dirty — needs housekeeping.
export function IconBroom(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M19 4 9.5 13.5" />
      <path d="M4 20l3-3" />
      <path d="M8 11l5 5-6 3-2-2 3-6Z" />
    </IconBase>
  );
}

// Out of order / urgent.
export function IconAlertTriangle(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </IconBase>
  );
}

// Check-ins today.
export function IconArrowIn(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 21h16" />
    </IconBase>
  );
}

// Check-outs today.
export function IconArrowOut(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M12 21V9" />
      <path d="m7 14 5-5 5 5" />
      <path d="M4 3h16" />
    </IconBase>
  );
}

// Open F&B tickets.
export function IconUtensils(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M6 3v7a2 2 0 0 0 2 2v9" />
      <path d="M6 3v4" />
      <path d="M9 3v4" />
      <path d="M18 3c-1.5 0-3 1.5-3 4v4h3" />
      <path d="M18 3v18" />
    </IconBase>
  );
}

// Live activity feed section header.
export function IconActivity(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </IconBase>
  );
}
