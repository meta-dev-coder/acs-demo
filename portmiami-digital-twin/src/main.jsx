import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './app.css';

// Deliberately NOT wrapped in <StrictMode>. Its development double-mount would build, tear down and
// rebuild the Cesium Viewer — two WebGL contexts and two tile fetches on every reload — which is
// exactly the "unnecessary viewer recreation" this app is meant to avoid. The hook's cleanup is
// still written to be correct under a real unmount; see src/hooks/usePortTwin.js.
createRoot(document.getElementById('root')).render(<App />);
