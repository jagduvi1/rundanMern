import React from 'react';
import ReactDOM from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
import 'leaflet/dist/leaflet.css';
import './index.css';
import App from './App.jsx';
import { registerServiceWorker } from './utils/pwa';

// Register the service worker at startup so the app qualifies as installable
// (Chromium fires beforeinstallprompt only with a registered SW) and push is ready.
registerServiceWorker();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </React.StrictMode>
);
