import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../lib/cn';

const alertVariants = cva('relative w-full rounded-lg border p-4 text-sm', {
  variants: {
    tone: {
      info: 'border-info-border bg-info text-info-foreground',
      warning: 'border-warning-border bg-warning text-warning-foreground',
      danger: 'border-danger-border bg-danger text-danger-foreground',
      success: 'border-success-border bg-success text-success-foreground',
    },
  },
  defaultVariants: { tone: 'info' },
});

export function Alert({
  className,
  tone,
  ...p
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cn(alertVariants({ tone }), className)}
      {...p}
    />
  );
}
