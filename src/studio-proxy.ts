import express from 'express';
import proxy from 'express-http-proxy';
import * as crypto from 'crypto';

const app = express();
const port = process.env.PRISMA_STUDIO_PROXY_PORT || 5555;
const targetHost = process.env.PRISMA_STUDIO_HOST || 'prisma-studio';
const targetPort = process.env.PRISMA_STUDIO_TARGET_PORT || 5554;

const expectedUser =
  process.env.BULL_BOARD_USER || process.env.ADMIN_USER || 'admin';
const expectedPassword =
  process.env.BULL_BOARD_PASSWORD ||
  process.env.ADMIN_PASSWORD ||
  'vladMatrixQueues2026SafeAdmin';

// Basic Auth Middleware
app.use((req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader(
      'WWW-Authenticate',
      'Basic realm="Prisma Studio Admin", charset="UTF-8"',
    );
    res.status(401).send('Authentication required for Prisma Studio.');
    return;
  }

  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString(
    'utf8',
  );
  const [user, password] = credentials.split(':');

  const userBuffer = Buffer.from(user || '');
  const expUserBuffer = Buffer.from(expectedUser);
  const passBuffer = Buffer.from(password || '');
  const expPassBuffer = Buffer.from(expectedPassword);

  const isUserValid =
    userBuffer.length === expUserBuffer.length &&
    crypto.timingSafeEqual(userBuffer, expUserBuffer);
  const isPassValid =
    passBuffer.length === expPassBuffer.length &&
    crypto.timingSafeEqual(passBuffer, expPassBuffer);

  if (!isUserValid || !isPassValid) {
    res.setHeader(
      'WWW-Authenticate',
      'Basic realm="Prisma Studio Admin", charset="UTF-8"',
    );
    res.status(401).send('Invalid credentials.');
    return;
  }

  next();
});

// Proxy to Prisma Studio at root /
app.use(
  '/',
  proxy(`${targetHost}:${targetPort}`, {
    proxyErrorHandler: (err, res, next) => {
      if (err && (err as any).code === 'ECONNREFUSED') {
        res.status(530).send(`
          <!DOCTYPE html>
          <html>
            <head><title>Prisma Studio Launching</title></head>
            <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f0f13; color: white;">
              <h2>🔄 Prisma Studio поднимается...</h2>
              <p style="opacity: 0.7;">Пожалуйста, обновите страницу через 5-10 секунд.</p>
              <button onclick="location.reload()" style="padding: 10px 20px; background: #0057ff; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: bold;">
                Обновить страницу
              </button>
            </body>
          </html>
        `);
        return;
      }
      next(err);
    },
  }),
);

app.listen(port, () => {
  console.log(
    `Prisma Studio Auth Proxy listening on port ${port} -> ${targetHost}:${targetPort}`,
  );
});
