import { ICON } from "../../lib/iconSize.ts";
/** Rail glyphs for the fork's harness panels (Accounts, Queue). Kept out of
 *  icons.tsx so upstream syncs never have to merge around them; drawn with the
 *  same stroke recipe so they sit in the rail as if they had always been there. */

const svg = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

type P = { size?: number };

/** Two people: more than one login behind the same cockpit. */
export function AccountsIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
      <path d="M18.5 14.3A6.5 6.5 0 0 1 21.5 20" />
    </svg>
  );
}

/** A list waiting its turn, the top item already moving. */
export function QueueIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M4 5.5l3 2-3 2z" />
      <path d="M10.5 7.5H20" />
      <path d="M4 12.5h16" />
      <path d="M4 17.5h16" />
    </svg>
  );
}
