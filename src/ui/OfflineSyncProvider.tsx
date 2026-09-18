import React, { createContext, useContext, useEffect, useState } from 'react';
import { connectBridge } from '../pwa/index.js';

// Ce fichier exporte le Provider React du moteur PowerSync.
// ⚠️ ATTENTION NEXT.JS (App Router) : 
// Ce composant utilise des hooks (useState, useEffect) mais NE DÉCLARE PAS "use client".
// Il ne peut donc pas être importé directement dans un Server Component (ex: layout.tsx).
// Vous DEVEZ créer un composant "Wrapper" client pour l'utiliser :
// 
// // providers/OfflineSyncWrapper.tsx
// "use client"
// import { OfflineSyncProvider } from "@ksm/offline-sync/ui";
// import { initSync } from "@/app/services/offline/init";
// export function OfflineSyncWrapper({ children }) {
//    return <OfflineSyncProvider initSync={initSync}>{children}</OfflineSyncProvider>;
// }

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
