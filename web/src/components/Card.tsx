// Surfaces: a card with the two elevation levels of SPEC §9.3, and the skeleton of §9.1 X5
// ("Skeleton content within 100 ms [...] no full-page spinners").

import type {ReactNode} from "react";

export type CardProps = {
  title?: ReactNode;
  /** Sits opposite the title: a badge, a freshness line, a secondary control. */
  aside?: ReactNode;
  footer?: ReactNode;
  raised?: boolean;
  /** Renders the card as a `<section>` with the title as its accessible name. */
  as?: "div" | "section" | "article";
  children?: ReactNode;
};

export function Card({title, aside, footer, raised = false, as = "section", children}: CardProps) {
  const Tag = as;
  return (
    <Tag className={raised ? "card card--raised" : "card"}>
      {title === undefined && aside === undefined ? null : (
        <header className="page-heading">
          {title === undefined ? <span /> : <h2 className="card__title">{title}</h2>}
          {aside}
        </header>
      )}
      {children}
      {footer === undefined ? null : <div className="card__footer">{footer}</div>}
    </Tag>
  );
}

export type SkeletonProps = {
  /** Any CSS length. Defaults to full width. */
  width?: string;
  height?: string;
  /** Announced to assistive technology in place of the shimmer. */
  label?: string;
};

export function Skeleton({width = "100%", height = "1rem", label = "Loading"}: SkeletonProps) {
  return (
    <span className="skeleton" style={{width, height}} role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
