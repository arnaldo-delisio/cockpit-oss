// Layout primitives for React/Tailwind. Scaffolded into the repo by /taste.
// The spacing decision is made ONCE, inside each primitive, then reused — so sibling
// surfaces are identical by construction. Compose UI from these; do not write raw
// p-/gap-/m-/space- utilities on composed surfaces. The dev-time guard below makes
// that rule enforceable at usage time, not just at code review.
import * as React from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// Throws in development if a caller tries to inject spacing utilities through className —
// spacing belongs to the primitive, not the consumer. No-op in production.
const SPACING_RE = /(^|\s)-?(p[trblxyse]?|m[trblxyse]?|gap(-[xy])?|space-[xy])-/;
function guard(cls?: string) {
  if (cls && typeof process !== "undefined" && process.env?.NODE_ENV !== "production" && SPACING_RE.test(cls)) {
    throw new Error(`/taste: spacing utility in className ("${cls}") on a layout primitive. Spacing comes from the primitive/tokens — extend a primitive instead of inlining a value.`);
  }
  return cls;
}

type Div = React.HTMLAttributes<HTMLDivElement>;

// Vertical rhythm. One gap token for the whole stack — children never set their own margins.
export function Stack({ gap = "stack", className, ...p }: Div & { gap?: "stack" | "section" | "card" }) {
  const g = { stack: "[gap:var(--space-stack-gap)]", section: "[gap:var(--space-section-gap)]", card: "[gap:var(--space-card-gap)]" }[gap];
  return <div className={cx("flex flex-col", g, guard(className))} {...p} />;
}

// Inline group (buttons, tags) — wraps, even gap, baseline-aligned.
export function Cluster({ className, ...p }: Div) {
  return <div className={cx("flex flex-wrap items-center [gap:var(--space-cluster-gap)]", guard(className))} {...p} />;
}

// Responsive equal-column grid with a single shared gap. Equal-height cells by construction.
// Track width is a named, token-backed variant — no arbitrary values that break rhythm.
export function Grid({ density = "default", className, ...p }: Div & { density?: "narrow" | "default" | "wide" }) {
  const min = { narrow: "12rem", default: "16rem", wide: "22rem" }[density];
  return <div className={cx("grid [gap:var(--space-card-gap)]", guard(className))} style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}, 1fr))`, ...(p.style || {}) }} {...p} />;
}

// Centered content column, capped to the content width with page padding.
export function Center({ className, ...p }: Div) {
  return <div className={cx("mx-auto w-full [max-width:var(--content-max)] [padding-inline:var(--space-page-padding)]", guard(className))} {...p} />;
}

// Card with symmetric internal padding from the token. All cards read as siblings.
export function Card({ className, ...p }: Div) {
  return <div className={cx("[padding:var(--space-card-padding)] [border-radius:var(--radius-card)] [box-shadow:var(--shadow-card)] bg-white", guard(className))} {...p} />;
}

// Constrained measure for body copy.
export function Prose({ className, ...p }: Div) {
  return <div className={cx("[max-width:var(--measure)]", guard(className))} {...p} />;
}
