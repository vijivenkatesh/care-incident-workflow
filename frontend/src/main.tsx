import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { App } from './App';
import { theme } from './theme';
import { createAwsSession, createDemoSession, type AppConfig, type Session } from './session';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  const config: AppConfig = await fetch('/config.json').then((r) => r.json()).catch(() => ({ mode: 'mock' }));

  const render = (session: Session) =>
    root.render(
      <StrictMode>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <App session={session} />
        </ThemeProvider>
      </StrictMode>,
    );

  if (config.mode === 'aws') {
    const session = await createAwsSession(config);
    if (session) render(session);
  } else {
    render(createDemoSession(render));
  }
}

void start();
