import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ApiError, errorCode } from './lib/api.ts';
import { AnnouncerProvider } from './lib/announce.tsx';
import { setSessionEnded } from './lib/session-ended.ts';

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (errorCode(error) === 'UNAUTHENTICATED' && query.queryKey[0] !== 'session') setSessionEnded(true);
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (errorCode(error) === 'UNAUTHENTICATED' && queryClient.getQueryData(['session'])) setSessionEnded(true);
    },
  }),
  defaultOptions: {
    queries: {
      // Domain errors (4xx) are answers, not glitches; only retry server/network trouble.
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AnnouncerProvider>
        <App />
      </AnnouncerProvider>
    </QueryClientProvider>
  </StrictMode>,
);
