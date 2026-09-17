import React, { createContext, useContext, useEffect, useState } from 'react';
import { connectBridge } from '../pwa/index.js';

// Ce fichier est conçu pour être utilisé dans un composant "use client" Next.js ou React standard.

export interface OfflineSyncContextValue {
  isReady: boolean;
}

const OfflineSyncContext = createContext<OfflineSyncContextValue>({ isReady: false });

export interface OfflineSyncProviderProps {
  children: React.ReactNode;
  /**
   * Fonction asynchrone qui initialise et retourne l'instance PowerSync/OfflineSync.
   */
  initSync: () => Promise<any>;
}

export function OfflineSyncProvider({ children, initSync }: OfflineSyncProviderProps) {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let bridgeCleanup: (() => void) | undefined;
    
    let active = true;
    async function startSync() {
      try {
        const syncInstance = await initSync();
        if (!active) return;
        
        bridgeCleanup = connectBridge(syncInstance);
        setIsReady(true);
      } catch (e) {
        console.error("Failed to initialize OfflineSync:", e);
      }
    }

    startSync();

    return () => {
      active = false;
      if (bridgeCleanup) bridgeCleanup();
    };
  }, [initSync]);

  return (
    <OfflineSyncContext.Provider value={{ isReady }}>
      {children}
    </OfflineSyncContext.Provider>
  );
}

export function useOfflineSync() {
  return useContext(OfflineSyncContext);
}
