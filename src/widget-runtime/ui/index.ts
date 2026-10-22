// Library 'ui': shadcn/ui-compatible components for widgets, registered as '@/components/ui/<name>'.
// Same names and props as shadcn's (Radix-like APIs), but plain elements: native <select> and range inputs,
// and popups (tooltips) that stay inside the widget's frame. Styled with the theme tokens (theme.css);
// high-contrast borders come from `--border`/`--ring` and the `.hc` rules there. docs/WIDGETS-PLAN.md §2, §7.
import {
  Children, cloneElement, createContext, createElement as h, isValidElement, useCallback, useContext, useEffect,
  useId, useLayoutEffect, useRef, useState,
  type ReactElement, type ReactNode,
} from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { register } from '../registry.ts';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// Loose prop types: widgets are plain JS at runtime; the bundled .d.ts for authors is separate (plan §2).
type P = Record<string, any> & { className?: string; children?: ReactNode };

const FOCUS = 'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Radix-style `asChild`: merge our props into the single child element instead of rendering our own. */
function slot(tag: string, asChild: boolean | undefined, props: P): ReactElement {
  const { children, ...rest } = props;
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<P>;
    return cloneElement(child, { ...rest, ...child.props, className: cn(rest.className, child.props.className) });
  }
  return h(tag, rest, children);
}

/** A tiny class-variance-authority: base classes plus one class string per variant value. */
function variants<V extends Record<string, Record<string, string>>>(base: string, map: V, defaults: { [K in keyof V]: keyof V[K] }) {
  return (opts: { [K in keyof V]?: keyof V[K] | null } & { className?: string } = {}) =>
    cn(base, ...Object.keys(map).map((k) => map[k]![String(opts[k] ?? defaults[k])] ?? ''), opts.className);
}

const div = (slotName: string, base: string) => {
  const C = ({ className, ...props }: P) => h('div', { 'data-slot': slotName, className: cn(base, className), ...props });
  C.displayName = slotName;
  return C;
};

// ---- card ----
const Card = div('card', 'rounded-lg border border-border bg-card text-card-foreground shadow-sm');
const CardHeader = div('card-header', 'flex flex-col gap-1.5 p-6');
const CardTitle = div('card-title', 'text-lg font-semibold leading-none tracking-tight');
const CardDescription = div('card-description', 'text-sm text-muted-foreground');
const CardContent = div('card-content', 'p-6 pt-0');
const CardFooter = div('card-footer', 'flex items-center p-6 pt-0');
const CardAction = div('card-action', 'self-start justify-self-end');

// ---- button ----
const buttonVariants = variants(
  `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-medium transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 ${FOCUS}`,
  {
    variant: {
      default: 'bg-primary text-primary-foreground hover:bg-primary/90',
      destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      outline: 'border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
      secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      ghost: 'hover:bg-accent hover:text-accent-foreground',
      link: 'text-primary underline-offset-4 hover:underline',
    },
    size: { default: 'h-9 px-4 py-2', sm: 'h-8 rounded-md px-3 text-xs', lg: 'h-10 rounded-md px-8', icon: 'h-9 w-9' },
  },
  { variant: 'default', size: 'default' },
);
function Button({ className, variant, size, asChild, type, ...props }: P) {
  return slot(asChild ? 'span' : 'button', asChild, {
    'data-slot': 'button', className: buttonVariants({ variant, size, className }), ...(asChild ? {} : { type: type ?? 'button' }), ...props,
  });
}

// ---- badge ----
const badgeVariants = variants(
  `inline-flex items-center gap-1 rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors ${FOCUS}`,
  {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      destructive: 'border-transparent bg-destructive text-destructive-foreground',
      outline: 'border-border text-foreground',
    },
  },
  { variant: 'default' },
);
function Badge({ className, variant, asChild, ...props }: P) {
  return slot('span', asChild, { 'data-slot': 'badge', className: badgeVariants({ variant, className }), ...props });
}

// ---- input, label ----
function Input({ className, type, ...props }: P) {
  return h('input', {
    'data-slot': 'input', type,
    className: cn(`flex h-9 w-full min-w-0 rounded-md border border-input bg-[var(--input-background)] px-3 py-1 text-sm text-foreground shadow-xs placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 file:border-0 file:bg-transparent file:text-sm file:font-medium ${FOCUS} focus-visible:outline-offset-0`, className),
    ...props,
  });
}
function Label({ className, ...props }: P) {
  return h('label', { 'data-slot': 'label', className: cn('text-sm font-medium leading-none select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70', className), ...props });
}

// ---- slider (native range; shadcn's value-array API) ----
function Slider({ className, value, defaultValue, onValueChange, onValueCommit, min = 0, max = 100, step = 1, disabled, orientation, name, 'aria-label': ariaLabel, ...props }: P) {
  // shadcn takes arrays; a plain number (value={5}) is common in generated code and means the same.
  const asList = (v: unknown): number[] | undefined => (Array.isArray(v) ? v : typeof v === 'number' ? [v] : undefined);
  const controlled = asList(value) !== undefined;
  const [inner, setInner] = useState<number[]>(() => asList(defaultValue) ?? [min]);
  const values: number[] = controlled ? asList(value)! : inner;
  const change = (i: number, v: number, commit: boolean) => {
    const next = values.slice();
    next[i] = v;
    if (!controlled) setInner(next);
    (commit ? onValueCommit : onValueChange)?.(next);
  };
  return h('div', { 'data-slot': 'slider', className: cn('flex w-full touch-none select-none flex-col gap-2', className), ...props },
    values.map((v, i) => h('input', {
      key: i, type: 'range', min, max, step, value: v, disabled, name,
      'aria-label': ariaLabel, 'aria-orientation': orientation,
      className: cn('h-4 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50', FOCUS),
      onChange: (e: any) => change(i, Number(e.target.value), false),
      onPointerUp: (e: any) => change(i, Number(e.target.value), true),
      onKeyUp: (e: any) => change(i, Number(e.target.value), true),
    })));
}

// ---- switch, checkbox ----
function useControlled<T>(value: T | undefined, defaultValue: T, onChange?: (v: T) => void): [T, (v: T) => void] {
  const [inner, setInner] = useState<T>(defaultValue);
  const controlled = value !== undefined;
  return [controlled ? value : inner, (v: T) => { if (!controlled) setInner(v); onChange?.(v); }];
}
function Switch({ className, checked, defaultChecked, onCheckedChange, disabled, onClick, ...props }: P) {
  const [on, set] = useControlled<boolean>(checked, !!defaultChecked, onCheckedChange);
  return h('button', {
    type: 'button', role: 'switch', 'aria-checked': on, 'data-state': on ? 'checked' : 'unchecked', 'data-slot': 'switch', disabled,
    className: cn('peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      on ? 'bg-primary' : 'bg-input', '[:root.hc_&]:border-border', FOCUS, className),
    ...props,
    onClick: (e: any) => { onClick?.(e); if (!e.defaultPrevented) set(!on); },
  }, h('span', {
    'data-slot': 'switch-thumb',
    className: cn('pointer-events-none block size-4 rounded-full shadow-sm transition-transform', on ? 'translate-x-4 bg-primary-foreground' : 'translate-x-0.5 bg-foreground'),
  }));
}
function Checkbox({ className, checked, defaultChecked, onCheckedChange, disabled, onChange, ...props }: P) {
  const [on, set] = useControlled<boolean | 'indeterminate'>(checked, !!defaultChecked, onCheckedChange);
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (ref.current) ref.current.indeterminate = on === 'indeterminate'; }, [on]);
  return h('input', {
    ref, type: 'checkbox', checked: on === true, disabled, 'data-slot': 'checkbox', 'data-state': on === true ? 'checked' : 'unchecked',
    className: cn('peer size-4 shrink-0 cursor-pointer rounded-sm accent-primary disabled:cursor-not-allowed disabled:opacity-50', FOCUS, className),
    ...props,
    onChange: (e: any) => { onChange?.(e); set(e.target.checked); },
  });
}

// ---- tabs ----
const TabsContext = createContext<{ value: string; set: (v: string) => void; id: string; orientation: string } | null>(null);
function Tabs({ className, value, defaultValue, onValueChange, orientation = 'horizontal', ...props }: P) {
  const [v, set] = useControlled<string>(value, defaultValue ?? '', onValueChange);
  const id = useId();
  return h(TabsContext.Provider, { value: { value: v, set, id, orientation } },
    h('div', { 'data-slot': 'tabs', 'data-orientation': orientation, className: cn('flex flex-col gap-2', className), ...props }));
}
function TabsList({ className, ...props }: P) {
  const ctx = useContext(TabsContext);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ctx?.orientation === 'vertical' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (!keys.includes(e.key) && e.key !== 'Home' && e.key !== 'End') return;
    const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === keys[1] ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
    e.preventDefault();
  };
  return h('div', {
    role: 'tablist', 'aria-orientation': ctx?.orientation, 'data-slot': 'tabs-list', onKeyDown,
    className: cn('inline-flex h-9 w-fit items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground', className), ...props,
  });
}
function TabsTrigger({ className, value, disabled, onClick, ...props }: P) {
  const ctx = useContext(TabsContext);
  const active = ctx?.value === value;
  return h('button', {
    type: 'button', role: 'tab', 'aria-selected': active, tabIndex: active ? 0 : -1, disabled,
    id: `${ctx?.id}-t-${value}`, 'aria-controls': `${ctx?.id}-c-${value}`,
    'data-state': active ? 'active' : 'inactive', 'data-slot': 'tabs-trigger',
    className: cn('inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-3 py-1 text-sm font-medium transition-all cursor-pointer disabled:pointer-events-none disabled:opacity-50',
      'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm', FOCUS, className),
    ...props,
    onClick: (e: any) => { onClick?.(e); if (!e.defaultPrevented) ctx?.set(value); },
  });
}
function TabsContent({ className, value, forceMount, ...props }: P) {
  const ctx = useContext(TabsContext);
  const active = ctx?.value === value;
  if (!active && !forceMount) return null;
  return h('div', {
    role: 'tabpanel', id: `${ctx?.id}-c-${value}`, 'aria-labelledby': `${ctx?.id}-t-${value}`, hidden: !active, tabIndex: 0,
    'data-state': active ? 'active' : 'inactive', 'data-slot': 'tabs-content', className: cn('flex-1', FOCUS, className), ...props,
  });
}

// ---- select (native-backed, Radix-like API) ----
// Select reads its children (SelectTrigger > SelectValue, SelectContent > SelectGroup/SelectLabel/SelectItem)
// and renders one native <select>, whose popup is the browser's and stays usable at any widget size.
const SelectTrigger = (_: P) => null;
const SelectValue = (_: P) => null;
const SelectContent = (_: P) => null;
const SelectItem = (_: P) => null;
const SelectGroup = (_: P) => null;
const SelectLabel = (_: P) => null;
const SelectSeparator = (_: P) => null;
const SelectScrollUpButton = () => null;
const SelectScrollDownButton = () => null;

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as P).children);
  return '';
}

function Select({ value, defaultValue, onValueChange, disabled, name, required, children }: P) {
  const [v, set] = useControlled<string>(value, defaultValue ?? '', onValueChange);
  let trigger: P = {};
  let placeholder: string | undefined;
  const options: ReactNode[] = [];
  const items = (nodes: ReactNode, out: ReactNode[]): void => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      const props = child.props as P;
      if (child.type === SelectItem) {
        out.push(h('option', { key: String(props.value), value: props.value, disabled: props.disabled }, textOf(props.children)));
      } else if (child.type === SelectGroup) {
        const label = Children.toArray(props.children).find((c) => isValidElement(c) && c.type === SelectLabel) as ReactElement<P> | undefined;
        const inner: ReactNode[] = [];
        items(props.children, inner);
        out.push(h('optgroup', { key: `g${out.length}`, label: label ? textOf(label.props.children) : '' }, inner));
      } else if (child.type !== SelectLabel && child.type !== SelectSeparator) {
        items(props.children, out);
      }
    });
  };
  const walk = (nodes: ReactNode): void => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      const props = child.props as P;
      if (child.type === SelectTrigger) {
        trigger = props;
        Children.forEach(props.children, (c) => { if (isValidElement(c) && c.type === SelectValue) placeholder = (c.props as P).placeholder; });
      } else if (child.type === SelectContent) {
        items(props.children, options);
      } else {
        walk(props.children);
      }
    });
  };
  walk(children);
  const { className, children: _c, ...triggerRest } = trigger;
  return h('div', { 'data-slot': 'select', className: cn('relative inline-flex w-fit', /\bw-/.test(className ?? '') && 'w-auto') },
    h('select', {
      ...triggerRest, 'data-slot': 'select-trigger', value: v, disabled, name, required,
      className: cn('h-9 w-full cursor-pointer appearance-none rounded-md border border-input bg-[var(--input-background)] py-1 pl-3 pr-8 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50', FOCUS, 'focus-visible:outline-offset-0', className),
      onChange: (e: any) => set(e.target.value),
    },
    placeholder !== undefined || !v ? h('option', { value: '', disabled: true, hidden: !!v }, placeholder ?? '') : null,
    options),
    h('svg', { 'aria-hidden': true, viewBox: '0 0 24 24', className: 'pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 opacity-60', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
      h('path', { d: 'm6 9 6 6 6-6' })));
}

// ---- progress, separator ----
function Progress({ className, value, max = 100, ...props }: P) {
  const pct = Math.max(0, Math.min(100, ((Number(value) || 0) / (max || 100)) * 100));
  return h('div', {
    role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value ?? undefined, 'data-slot': 'progress',
    className: cn('relative h-2 w-full overflow-hidden rounded-full bg-muted [:root.hc_&]:border [:root.hc_&]:border-border', className), ...props,
  }, h('div', { 'data-slot': 'progress-indicator', className: 'h-full bg-primary transition-[width]', style: { width: `${pct}%` } }));
}
function Separator({ className, orientation = 'horizontal', decorative = true, ...props }: P) {
  return h('div', {
    role: decorative ? 'none' : 'separator', 'aria-orientation': decorative ? undefined : orientation, 'data-slot': 'separator', 'data-orientation': orientation,
    className: cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className), ...props,
  });
}

// ---- alert ----
const alertVariants = variants(
  'relative grid w-full gap-1 rounded-lg border border-border px-4 py-3 text-sm [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-3.5 [&>svg]:size-4 [&>svg~*]:pl-7',
  { variant: { default: 'bg-card text-card-foreground', destructive: 'border-destructive bg-card text-destructive [&>svg]:text-current' } },
  { variant: 'default' },
);
function Alert({ className, variant, ...props }: P) {
  return h('div', { role: 'alert', 'data-slot': 'alert', className: alertVariants({ variant, className }), ...props });
}
const AlertTitle = div('alert-title', 'font-medium leading-none tracking-tight');
const AlertDescription = div('alert-description', 'text-sm text-muted-foreground [&_p]:leading-relaxed');

// ---- tooltip (stays inside the frame: flips, then clamps to the frame's own viewport) ----
const TooltipContext = createContext<{ open: boolean; setOpen: (o: boolean) => void; trigger: React.RefObject<HTMLElement | null>; id: string; delay: number } | null>(null);
const DelayContext = createContext(300);
function TooltipProvider({ delayDuration = 300, children }: P) {
  return h(DelayContext.Provider, { value: delayDuration }, children);
}
function Tooltip({ open, defaultOpen, onOpenChange, delayDuration, children }: P) {
  const [o, setOpen] = useControlled<boolean>(open, !!defaultOpen, onOpenChange);
  const trigger = useRef<HTMLElement | null>(null);
  const providerDelay = useContext(DelayContext);
  const id = useId();
  return h(TooltipContext.Provider, { value: { open: o, setOpen, trigger, id, delay: delayDuration ?? providerDelay } }, children);
}
function TooltipTrigger({ asChild, children, ...props }: P) {
  const ctx = useContext(TooltipContext);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = () => { clearTimeout(timer.current); timer.current = setTimeout(() => ctx?.setOpen(true), ctx?.delay ?? 300); };
  const hide = () => { clearTimeout(timer.current); ctx?.setOpen(false); };
  const handlers = {
    ref: (el: HTMLElement | null) => { if (ctx) ctx.trigger.current = el; },
    'aria-describedby': ctx?.open ? ctx.id : undefined,
    'data-state': ctx?.open ? 'delayed-open' : 'closed',
    'data-slot': 'tooltip-trigger',
    onPointerEnter: show, onPointerLeave: hide, onFocus: () => ctx?.setOpen(true), onBlur: hide,
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape' && ctx?.open) { e.preventDefault(); hide(); } },
  };
  if (asChild && isValidElement(children)) return cloneElement(children as ReactElement<P>, { ...props, ...handlers });
  return h('button', { type: 'button', className: cn('cursor-help', FOCUS), ...props, ...handlers }, children);
}
function TooltipContent({ className, side = 'top', sideOffset = 6, children, style, ...props }: P) {
  const ctx = useContext(TooltipContext);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const place = useCallback(() => {
    const t = ctx?.trigger.current, el = ref.current;
    if (!t || !el) return;
    // The frame's own viewport (window.innerHeight is the panel's; see the runtime).
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const r = t.getBoundingClientRect(), w = el.offsetWidth, ht = el.offsetHeight;
    const at = (s: string) => s === 'top' ? { left: r.left + r.width / 2 - w / 2, top: r.top - ht - sideOffset }
      : s === 'bottom' ? { left: r.left + r.width / 2 - w / 2, top: r.bottom + sideOffset }
      : s === 'left' ? { left: r.left - w - sideOffset, top: r.top + r.height / 2 - ht / 2 }
      : { left: r.right + sideOffset, top: r.top + r.height / 2 - ht / 2 };
    const fits = (p: { left: number; top: number }) => p.left >= 2 && p.top >= 2 && p.left + w <= vw - 2 && p.top + ht <= vh - 2;
    const opposite: Record<string, string> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
    let p = at(side);
    if (!fits(p)) {
      const q = at(opposite[side] ?? 'bottom');
      if (fits(q)) p = q;
    }
    setPos({ left: Math.max(2, Math.min(p.left, vw - w - 2)), top: Math.max(2, Math.min(p.top, vh - ht - 2)) });
  }, [ctx, side, sideOffset]);
  useLayoutEffect(() => { if (ctx?.open) place(); else setPos(null); }, [ctx?.open, place]);
  if (!ctx?.open) return null;
  return h('div', {
    ref, id: ctx.id, role: 'tooltip', 'data-slot': 'tooltip-content', 'data-side': side,
    className: cn('fixed z-50 w-max max-w-[calc(100vw-8px)] rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md', className),
    style: { left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden', ...style },
    ...props,
  }, children);
}

// ---- scroll area ----
function ScrollArea({ className, children, ...props }: P) {
  return h('div', { 'data-slot': 'scroll-area', className: cn('relative overflow-auto', FOCUS, className), tabIndex: 0, ...props }, children);
}
const ScrollBar = (_: P) => null;

const modules: Record<string, Record<string, unknown>> = {
  card: { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction },
  button: { Button, buttonVariants },
  badge: { Badge, badgeVariants },
  input: { Input },
  label: { Label },
  slider: { Slider },
  switch: { Switch },
  checkbox: { Checkbox },
  tabs: { Tabs, TabsList, TabsTrigger, TabsContent },
  select: { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel, SelectSeparator, SelectScrollUpButton, SelectScrollDownButton },
  progress: { Progress },
  separator: { Separator },
  alert: { Alert, AlertTitle, AlertDescription },
  tooltip: { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider },
  'scroll-area': { ScrollArea, ScrollBar },
};
for (const [name, mod] of Object.entries(modules)) {
  for (const [k, v] of Object.entries(mod)) if (typeof v === 'function' && !(v as { displayName?: string }).displayName) (v as { displayName?: string }).displayName = k;
  register(`@/components/ui/${name}`, mod, true);
}
