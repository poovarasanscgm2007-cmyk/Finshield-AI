import { env } from './config/env.ts';
import { attachApiErrorHandlers, createApiApp } from './app.ts';

const app = createApiApp();
attachApiErrorHandlers(app);

app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`FINSHIELD AI backend listening on http://0.0.0.0:${env.PORT}`);
});
