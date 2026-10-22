// Library 'clsx': class-name helpers (clsx, tailwind-merge, and shadcn's `cn` from '@/lib/utils').
import * as clsx from 'clsx';
import * as twMerge from 'tailwind-merge';
import { register } from '../registry.ts';

register('clsx', clsx, true);
register('tailwind-merge', twMerge, true);
register('@/lib/utils', { cn: (...inputs) => twMerge.twMerge(clsx.clsx(inputs)) }, true);
