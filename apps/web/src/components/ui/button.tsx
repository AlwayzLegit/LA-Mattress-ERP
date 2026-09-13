'use client';

import Link from 'next/link';
import { forwardRef, type ReactNode } from 'react';
import { cx } from './cx';
import { Kbd } from './kbd';

/**
 * Four tiers (canvas 2e): primary (accent fill), secondary (hairline),
 * ghost (accent text, no border), destructive (outlined risk red — never
 * filled, never beside primary, never the default focus). Heights follow
 * the ambient density (`--control-h`). `kbd` appends a shortcut chip.
 * `danger` is the pre-redesign name for destructive and still works.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'danger';

function variantClass(v: ButtonVariant): string {
  return v === 'danger' ? 'btn-destructive' : `btn-${v}`;
}

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: 'sm';
    /** Shortcut spec for a trailing `<Kbd>` ("F8", "mod+k", "N"). */
    kbd?: string;
  }
>(function Button({ variant = 'secondary', size, kbd, className, children, ...props }, ref) {
  return (
    <button
      type="button"
      {...props}
      ref={ref}
      className={cx('btn', variantClass(variant), size === 'sm' && 'btn-sm', className)}
    >
      {children}
      {kbd && <Kbd keys={kbd} />}
    </button>
  );
});

export function LinkButton({
  href,
  variant = 'secondary',
  size,
  kbd,
  className,
  children,
  ...props
}: {
  href: string;
  variant?: ButtonVariant;
  size?: 'sm';
  kbd?: string;
  className?: string;
  children: ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <Link
      href={href}
      {...props}
      className={cx('btn', variantClass(variant), size === 'sm' && 'btn-sm', className)}
    >
      {children}
      {kbd && <Kbd keys={kbd} />}
    </Link>
  );
}
