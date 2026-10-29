import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import PortalApp from './PortalApp';
import { AuthProvider } from './auth/Auth';
import './index.css';
import './portal.css';
import './developer-mobile.css';
import './membership.css';

if (import.meta.env.PROD) registerSW({ immediate: true });
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><BrowserRouter><AuthProvider><PortalApp /></AuthProvider></BrowserRouter></React.StrictMode>,
);
