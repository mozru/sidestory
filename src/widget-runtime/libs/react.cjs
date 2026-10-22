// Library 'react': React 19 and React DOM, registered as their CommonJS exports (React 19 has no UMD build).
const { register } = require('../registry.ts');

register('react', require('react'), false);
register('react/jsx-runtime', require('react/jsx-runtime'), false);
register('react-dom', require('react-dom'), false);
register('react-dom/client', require('react-dom/client'), false);
