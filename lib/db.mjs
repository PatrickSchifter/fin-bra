// Conexão com o Postgres. Um pool só, compartilhado pelo CLI e pelo painel.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const AJUDA = `DATABASE_URL não definida.

  cp .env.example .env    # e coloque a string de conexão do seu Postgres

Postgres local:  postgres://user:senha@localhost:5432/fin
Neon / Supabase: pegue a connection string no painel do serviço`;

// .env simples: KEY=valor, ignora comentário e linha vazia, tira aspas
export function lerEnv(texto) {
  const env = {};
  for (const linha of texto.split('\n')) {
    const t = linha.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

export function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  let texto;
  try {
    texto = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    throw new Error(AJUDA);
  }
  const url = lerEnv(texto).DATABASE_URL;
  if (!url) throw new Error(AJUDA);
  return url;
}

// Postgres local normalmente não fala TLS; serviço gerenciado (Neon, Supabase, RDS) exige.
// Forçar SSL sempre quebra o `docker run postgres` que todo contribuidor usa para testar.
// Override manual: DATABASE_SSL=disable | no-verify | require
export function sslPara(url, override = process.env.DATABASE_SSL) {
  if (override === 'disable') return false;
  if (override === 'no-verify') return { rejectUnauthorized: false };
  if (override === 'require') return { rejectUnauthorized: true };

  let host = '';
  let params;
  try {
    const u = new URL(url);
    host = u.hostname;
    params = u.searchParams;
  } catch {
    return { rejectUnauthorized: true };
  }
  if (params.get('sslmode') === 'disable') return false;
  if (params.get('sslmode') === 'no-verify') return { rejectUnauthorized: false };
  if (['localhost', '127.0.0.1', '::1', ''].includes(host)) return false;
  return { rejectUnauthorized: true };
}

export function criarPool() {
  const url = connectionString();
  return new pg.Pool({
    // o sslmode na query string é depreciado no pg-connection-string; resolvemos em sslPara()
    connectionString: url.replace(/[?&](sslmode|channel_binding)=[^&]*/g, ''),
    ssl: sslPara(url),
    max: 2,
  });
}
