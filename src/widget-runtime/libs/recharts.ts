// Library 'recharts', with ResponsiveContainer shimmed for content-sized frames: a percentage height that
// doesn't resolve (the parent's height comes from its content, as everything's does in a widget frame)
// falls back to `minHeight` or 300 px, instead of rendering a 0-px chart. See docs/WIDGETS-PLAN.md §2.
import { createElement, useLayoutEffect, useRef, useState } from 'react';
import * as Recharts from 'recharts';
import { register } from '../registry.ts';

type Props = React.ComponentProps<typeof Recharts.ResponsiveContainer>;

const FALLBACK_HEIGHT = 300;

function ResponsiveContainer(props: Props) {
  const probe = useRef<HTMLSpanElement>(null);
  const [fallback, setFallback] = useState<number | null>(null);
  const { height = '100%', aspect, minHeight } = props;
  const percent = typeof height === 'string' && height.trim().endsWith('%') && !aspect;
  useLayoutEffect(() => {
    if (!percent || fallback !== null) return;
    // Recharts' own container, which has the percentage height: whatever the parent's padding, borders or
    // display, this is the box the chart gets.
    const container = probe.current?.firstElementChild;
    if (container && container.clientHeight < 2) {
      const min = typeof minHeight === 'number' ? minHeight : Number.parseFloat(String(minHeight ?? ''));
      setFallback(Number.isFinite(min) && min > 0 ? min : FALLBACK_HEIGHT);
    }
  }, [percent, fallback, minHeight]);
  // `display: contents` keeps the probe out of layout, so the chart's percentage still resolves against
  // the real parent.
  return createElement(
    'span',
    { ref: probe, style: { display: 'contents' } },
    createElement(Recharts.ResponsiveContainer, fallback === null ? props : { ...props, height: fallback }),
  );
}

register('recharts', { ...Recharts, ResponsiveContainer }, true);
