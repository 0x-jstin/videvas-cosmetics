import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './CloudApp.jsx';
import './styles.css';
import './customers.css';
import './cloud.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
