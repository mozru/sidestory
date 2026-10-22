// End to end inside the frame: TSX compiled by the real widget compiler (src/extension/widgets), then run by
// the runtime with the libraries the compiler lists.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WidgetCompilerCore } from '../../src/extension/widgets/compile-core.ts';
import { expect, init, test } from './fixtures.ts';

function explainer(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cx-widget-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test('a compiled TSX widget: relative modules, JSON, an image, lucide icons, Tailwind, the SDK and loop guards', async ({ harness }) => {
  const dir = explainer({
    'widgets/ring.tsx': `import { useState } from 'react';
import { motion } from 'framer-motion';
import { scaleLinear } from 'd3-scale';
import { Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useWidgetState, useStepValue } from 'explainer';
import { sum } from './lib/math';
import data from './data.json';
import logo from './logo.svg';

export default function Ring({ depth = 8 }: { depth?: number }) {
  const [wr, setWr] = useWidgetState('wr', 0);
  const [spun, setSpun] = useState('');
  const angle = useStepValue({ refill: 90 }, 0);
  const x = scaleLinear().domain([0, depth]).range([0, 100]);
  const spin = () => {
    try { let i = 0; while (true) { i++; } } catch (e) { setSpun((e as Error).message.slice(0, 20)); }
  };
  return (
    <Card>
      <CardContent className="pt-6">
        <motion.div animate={{ rotate: angle }} data-testid="m"><Activity data-testid="icon" /></motion.div>
        <p data-testid="out">{sum(data.values)}|{x(wr)}|{logo.slice(0, 14)}</p>
        <Button data-testid="w" onClick={() => setWr((wr + 1) % depth)}>Write {wr}</Button>
        <Button data-testid="spin" variant="ghost" onClick={spin}>Spin {spun}</Button>
      </CardContent>
    </Card>
  );
}
`,
    'widgets/lib/math.ts': 'export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n',
    'widgets/data.json': '{"values": [1, 2, 3]}',
    'widgets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  const core = new WidgetCompilerCore({ dataDir: 'dist/widget-data' });
  const r = await core.compile(dir, 'widgets/ring.tsx');
  expect(r.errors).toEqual([]);
  const id = await harness.mount({ libs: r.libraries, init: { ...init(r.entry, r.modules, { props: { depth: 4 } }), icons: r.icons } });
  const f = harness.frame(id);
  await expect(f.getByTestId('out')).toHaveText('6|0|data:image/svg');
  await expect(f.getByTestId('icon')).toHaveClass(/lucide-activity/);
  await f.getByTestId('w').click();
  await expect(f.getByTestId('out')).toHaveText('6|25|data:image/svg');
  await expect(f.getByTestId('m')).toHaveCSS('transform', /matrix\(0, 1, -1, 0|matrix\(6\.1/);
  await f.getByTestId('spin').click();
  await expect(f.getByTestId('spin')).toHaveText('Spin A loop ran for more', { timeout: 5000 });
  expect(await harness.messages(id, 'error')).toEqual([]);
});
