'use client';

import type { ReactNode } from 'react';
import { SaveProvider } from '@/lib/client/save';
import { SessionProvider } from '@/lib/client/session';
import { AppShell } from './AppShell';
import { ToastProvider } from './Toast';

/** Client providers. #app-root is made inert while a dialog is open; toasts and dialogs live outside it. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <ToastProvider>
        <SaveProvider>
          <div id="app-root">
            <AppShell>{children}</AppShell>
          </div>
        </SaveProvider>
      </ToastProvider>
    </SessionProvider>
  );
}
