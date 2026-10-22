// The shadcn/ui-compatible components widgets import from '@/components/ui/*', and the class helpers
// (docs/WIDGETS.md). Matches src/widget-runtime/ui/index.ts and UI_COMPONENT_EXPORTS in
// src/shared/widget-imports.ts. Props follow shadcn/ui's; other DOM props pass through (loose).

type __CxUiProps = { className?: string; children?: __CxReact.ReactNode; [prop: string]: any };
type __CxUi<P = {}> = __CxReact.FC<__CxUiProps & P>;
type __CxVariants<V extends string, S extends string = never> = (options?: { variant?: V | null; size?: S | null; className?: string }) => string;

declare module '@/components/ui/card' {
  export const Card: __CxUi, CardHeader: __CxUi, CardTitle: __CxUi, CardDescription: __CxUi, CardAction: __CxUi, CardContent: __CxUi, CardFooter: __CxUi;
}
declare module '@/components/ui/button' {
  type Variant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  type Size = 'default' | 'sm' | 'lg' | 'icon';
  export const Button: __CxUi<{ variant?: Variant; size?: Size; asChild?: boolean; disabled?: boolean; onClick?: (event: __CxReact.MouseEvent<HTMLButtonElement>) => void }>;
  export const buttonVariants: __CxVariants<Variant, Size>;
}
declare module '@/components/ui/badge' {
  type Variant = 'default' | 'secondary' | 'destructive' | 'outline';
  export const Badge: __CxUi<{ variant?: Variant; asChild?: boolean }>;
  export const badgeVariants: __CxVariants<Variant>;
}
declare module '@/components/ui/input' {
  export const Input: __CxUi<{ type?: string; value?: string | number; defaultValue?: string | number; placeholder?: string; onChange?: (event: __CxReact.ChangeEvent<HTMLInputElement>) => void }>;
}
declare module '@/components/ui/label' {
  export const Label: __CxUi<{ htmlFor?: string }>;
}
declare module '@/components/ui/slider' {
  /** A native range input per value; shadcn's array API. */
  export const Slider: __CxUi<{
    value?: number[]; defaultValue?: number[]; min?: number; max?: number; step?: number; disabled?: boolean;
    onValueChange?: (value: number[]) => void; onValueCommit?: (value: number[]) => void; 'aria-label'?: string;
  }>;
}
declare module '@/components/ui/switch' {
  export const Switch: __CxUi<{ checked?: boolean; defaultChecked?: boolean; onCheckedChange?: (checked: boolean) => void; disabled?: boolean; id?: string }>;
}
declare module '@/components/ui/checkbox' {
  export const Checkbox: __CxUi<{ checked?: boolean | 'indeterminate'; defaultChecked?: boolean; onCheckedChange?: (checked: boolean) => void; disabled?: boolean; id?: string }>;
}
declare module '@/components/ui/tabs' {
  export const Tabs: __CxUi<{ value?: string; defaultValue?: string; onValueChange?: (value: string) => void; orientation?: 'horizontal' | 'vertical' }>;
  export const TabsList: __CxUi;
  export const TabsTrigger: __CxUi<{ value: string; disabled?: boolean }>;
  export const TabsContent: __CxUi<{ value: string; forceMount?: boolean }>;
}
declare module '@/components/ui/select' {
  /** Rendered as one native <select>; SelectContent's items become its options. */
  export const Select: __CxUi<{ value?: string; defaultValue?: string; onValueChange?: (value: string) => void; disabled?: boolean; name?: string; required?: boolean }>;
  export const SelectTrigger: __CxUi, SelectContent: __CxUi, SelectGroup: __CxUi, SelectLabel: __CxUi, SelectSeparator: __CxUi;
  export const SelectValue: __CxUi<{ placeholder?: string }>;
  export const SelectItem: __CxUi<{ value: string; disabled?: boolean }>;
}
declare module '@/components/ui/progress' {
  export const Progress: __CxUi<{ value?: number | null; max?: number }>;
}
declare module '@/components/ui/separator' {
  export const Separator: __CxUi<{ orientation?: 'horizontal' | 'vertical'; decorative?: boolean }>;
}
declare module '@/components/ui/alert' {
  export const Alert: __CxUi<{ variant?: 'default' | 'destructive' }>;
  export const AlertTitle: __CxUi, AlertDescription: __CxUi;
}
declare module '@/components/ui/tooltip' {
  export const TooltipProvider: __CxUi<{ delayDuration?: number }>;
  export const Tooltip: __CxUi<{ open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void; delayDuration?: number }>;
  export const TooltipTrigger: __CxUi<{ asChild?: boolean }>;
  export const TooltipContent: __CxUi<{ side?: 'top' | 'bottom' | 'left' | 'right'; sideOffset?: number }>;
}
declare module '@/components/ui/scroll-area' {
  export const ScrollArea: __CxUi, ScrollBar: __CxUi;
}

type __CxClassValue = string | number | bigint | boolean | null | undefined | __CxClassValue[] | { [className: string]: unknown };
declare module '@/lib/utils' {
  /** clsx, then tailwind-merge: later classes win (cn('p-2', big && 'p-4')). */
  export function cn(...inputs: __CxClassValue[]): string;
}
declare module 'clsx' {
  export type ClassValue = __CxClassValue;
  export function clsx(...inputs: ClassValue[]): string;
  export default clsx;
}
declare module 'tailwind-merge' {
  export function twMerge(...classes: __CxClassValue[]): string;
  export function twJoin(...classes: __CxClassValue[]): string;
  export const createTailwindMerge: any, extendTailwindMerge: any, fromTheme: any, getDefaultConfig: any, mergeConfigs: any, validators: any;
}
