// Builds dist/widget-libs/ (and the compiler's dist/widget-data/) before the widget specs (about a second).
import { buildWidgetLibs } from '../../scripts/build-widget-libs.mjs';
import { generateWidgetData } from '../../scripts/widget-data.ts';

export default async function globalSetup() {
  process.chdir(new URL('../..', import.meta.url).pathname);
  await buildWidgetLibs({ quiet: true });
  await generateWidgetData('dist/widget-data');
}
