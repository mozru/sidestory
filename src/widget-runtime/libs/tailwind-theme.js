// Inserted before Tailwind's browser build runs: the theme it compiles against (docs/WIDGETS-PLAN.md §7).
import tokens from '../../shared/diagram-tokens.css';
import css from '../theme.css';

const style = document.createElement('style');
style.type = 'text/tailwindcss';
style.id = 'cx-theme';
// The diagram tokens the content frame uses too (one file, so they can't drift apart); after theme.css's @import.
style.textContent = `${css}\n${tokens}`;
document.head.append(style);
