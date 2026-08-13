import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lerEnv, sslPara } from '../lib/db.mjs';

describe('lerEnv', () => {
  it('lê KEY=valor e ignora comentário e linha vazia', () => {
    const env = lerEnv('# comentário\n\nDATABASE_URL=postgres://a:b@host/db\nOUTRA = 2\n');
    assert.equal(env.DATABASE_URL, 'postgres://a:b@host/db');
    assert.equal(env.OUTRA, '2');
  });

  it('tira aspas', () => {
    assert.equal(lerEnv('A="com aspas"').A, 'com aspas');
    assert.equal(lerEnv("A='simples'").A, 'simples');
  });

  it('não quebra em valor com = dentro (senha, query string)', () => {
    assert.equal(lerEnv('A=postgres://u:p@h/db?sslmode=require').A, 'postgres://u:p@h/db?sslmode=require');
  });
});

describe('sslPara', () => {
  it('Postgres local não fala TLS — forçar SSL quebraria todo contribuidor', () => {
    assert.equal(sslPara('postgres://u:p@localhost:5432/fin'), false);
    assert.equal(sslPara('postgres://u:p@127.0.0.1:5432/fin'), false);
  });

  it('serviço gerenciado exige SSL com verificação', () => {
    assert.deepEqual(sslPara('postgres://u:p@ep-x.neon.tech/db'), { rejectUnauthorized: true });
    assert.deepEqual(sslPara('postgres://u:p@db.abc.supabase.co/postgres'), { rejectUnauthorized: true });
  });

  it('sslmode na URL manda', () => {
    assert.equal(sslPara('postgres://u:p@remoto.example/db?sslmode=disable'), false);
    assert.deepEqual(sslPara('postgres://u:p@remoto.example/db?sslmode=no-verify'), { rejectUnauthorized: false });
  });

  it('DATABASE_SSL sobrepõe tudo', () => {
    assert.equal(sslPara('postgres://u:p@neon.tech/db', 'disable'), false);
    assert.deepEqual(sslPara('postgres://u:p@localhost/db', 'require'), { rejectUnauthorized: true });
  });

  it('URL que não parseia cai no seguro (verifica)', () => {
    assert.deepEqual(sslPara('não é url'), { rejectUnauthorized: true });
  });
});
