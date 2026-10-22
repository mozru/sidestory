// Library 'd3': the d3 bundle (its modules are aliased to 'd3' by the compiler; see widget-imports.ts).
import * as d3 from 'd3';
import { register } from '../registry.ts';

register('d3', d3, true);
