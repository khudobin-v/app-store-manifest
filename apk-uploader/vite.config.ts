import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Вход без ввода токена: берём его у уже авторизованного gh CLI.
 *
 * Работает только в `npm run dev` (apply: 'serve') и только на localhost.
 * CORS-заголовки намеренно не выставляются — чужая страница прочитать ответ
 * не сможет. В собранной статике этого маршрута нет: там остаётся ручной ввод.
 */
function ghCliAuth(): Plugin {
  return {
    name: 'gh-cli-auth',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/gh-token', (_req, res) => {
        void (async () => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          try {
            const [{ stdout: token }, { stdout: login }] = await Promise.all([
              run('gh', ['auth', 'token']),
              run('gh', ['api', 'user', '-q', '.login']),
            ]);
            res.end(JSON.stringify({ token: token.trim(), login: login.trim() }));
          } catch {
            res.statusCode = 404;
            res.end(
              JSON.stringify({
                error: 'gh CLI не авторизован. Выполните gh auth login или вставьте токен вручную.',
              }),
            );
          }
        })();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), ghCliAuth()],
});
