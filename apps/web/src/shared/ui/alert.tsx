import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../lib/cn';

const alertVariants = cva('relative w-full rounded-lg border p-4 text-sm', {
  variants: {
    tone: {
      info: 'border-blue-200 bg-blue-50 text-blue-900',
      warning: 'border-amber-300 bg-amber-50 text-amber-950',
      danger: 'border-red-300 bg-red-50 text-red-900',
      success: 'border-green-300 bg-green-50 text-green-900',
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
