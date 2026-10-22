// Library 'lucide': only lucide-react's icon factory. The runtime builds each widget's 'lucide-react'
// module from the icon nodes the compiler sends (only the icons that widget imports).
import createLucideIcon from 'lucide-react/dist/esm/createLucideIcon.mjs';
import Icon from 'lucide-react/dist/esm/Icon.mjs';
import { LucideProvider, useLucideContext } from 'lucide-react/dist/esm/context.mjs';
import { LUCIDE_FACTORY, register } from '../registry.ts';

register(LUCIDE_FACTORY, { createLucideIcon, Icon, LucideProvider, useLucideContext }, true);
