// Inserted before Tailwind's browser build runs: the theme it compiles against (docs/WIDGETS-PLAN.md §7).
import css from '../theme.css';

const style = document.createElement('style');
style.type = 'text/tailwindcss';
style.id = 'cx-theme';
style.textContent = css;
document.head.append(style);
