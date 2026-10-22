// Library 'lodash' (CommonJS, registered as its exports so `import _ from 'lodash'` and named imports both work).
import _ from 'lodash';
import { register } from '../registry.ts';

register('lodash', _, false);
