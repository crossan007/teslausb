import React, { useEffect, useState } from 'react';
import { loadConfig, getConfig } from './config';
import { useWebSocket, useApi } from './hooks';
import TransferSessionComponent from './components/TransferSession';
import SnapshotsComponent from './components/Snapshots';
import SystemStatusComponent from './components/SystemStatus';
import './App.css';

export default function App() {
  const [configLoaded, setConfigLoaded] = useState(false);
  const wsUrl = configLoaded ? `${getConfig().wsUrl}/ws` : '';
  const wsResult = useWebSocket(wsUrl);

  useEffect(() => {
    loadConfig()
      .then(() => {
        const config = getConfig();
        console.log('Configuration loaded:', config);
        setConfigLoaded(true);
      })
      .catch((error) => {
        console.error('Failed to load configuration:', error);
        setConfigLoaded(true); // Use defaults
      });
  }, []);

  if (!configLoaded) {
    return <div className="App loading">Loading configuration...</div>;
  }

  const config = getConfig();

  return (
    <div className="App">
      <header className="App-header">
        <h1>TeslaUSB Archive Monitor</h1>
        <div className="connection-status">
          <span className={wsResult.isConnected ? 'connected' : 'disconnected'}>
            {wsResult.isConnected ? '🟢 Connected' : '🔴 Disconnected'}
          </span>
        </div>
      </header>

      <main className="App-main">
        <div className="dashboard-grid">
          <SystemStatusComponent />
          <TransferSessionComponent wsMessage={wsResult.lastMessage} />
          <SnapshotsComponent wsMessage={wsResult.lastMessage} />
        </div>
      </main>

      <footer className="App-footer">
        <p>Backend: {config.apiBaseUrl}</p>
      </footer>
    </div>
  );
}
