#!/usr/bin/env node
/**
 * MIGRAÇÃO ÚNICA: SUPABASE -> TURSO
 * Catálogo Casas Bahia
 *
 * NÃO altera o index.html.
 * NÃO apaga dados do Turso.
 * Faz UPSERT por ID para evitar duplicações.
 *
 * Requisitos:
 *   Node.js 18+
 *
 * Variáveis de ambiente:
 *
 * Supabase:
 *   SUPABASE_URL=https://SEU-PROJETO.supabase.co
 *   SUPABASE_KEY=SUA_CHAVE_PUBLISHABLE_OU_ANON
 *
 *   Se a leitura pública da tabela estiver bloqueada pelo RLS,
 *   use uma chave com permissão de leitura:
 *   SUPABASE_SERVICE_ROLE_KEY=SUA_SERVICE_ROLE_KEY
 *
 * Turso:
 *   TURSO_DATABASE_URL=libsql://seu-banco-seu-org.turso.io
 *   TURSO_AUTH_TOKEN=SEU_TOKEN
 *
 * Opcional:
 *   SUPABASE_TABLE=products
 *   TURSO_TABLE=products
 *
 * Execução:
 *   node migrar-supabase-para-turso.js
 *
 * Primeiro use:
 *   DRY_RUN=1 node migrar-supabase-para-turso.js
 *
 * Isso apenas lê/analisa e mostra o que seria migrado.
 */

'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tuptrzvdqbaoohlerrfz.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_s9D9xICwKMA6vNLBO3eD6Q_yvUlMiXd';

const SUPABASE_TABLE = process.env.SUPABASE_TABLE || '';
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const TURSO_TABLE = process.env.TURSO_TABLE || '';

const DRY_RUN = process.env.DRY_RUN === '1';
const PAGE_SIZE = 500;

function die(message) {
  console.error('\n❌ ' + message + '\n');
  process.exit(1);
}

function normalizeTursoUrl(url) {
  return url
    .replace(/^libsql:/, 'https:')
    .replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function supabaseFetch(path) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    Accept: 'application/json',
  };

  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { headers });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text.slice(0, 1000)}`
    );
  }

  return text ? JSON.parse(text) : null;
}

/**
 * Executa SQL no Turso usando a API HTTP do pipeline libSQL.
 */
async function tursoExecute(sql, args = []) {
  const base = normalizeTursoUrl(TURSO_DATABASE_URL);
  const endpoint = `${base}/v2/pipeline`;

  const request = {
    requests: [
      {
        type: 'execute',
        stmt: {
          sql,
          args: args.map(value => {
            if (value === null || value === undefined) {
              return { type: 'null' };
            }

            if (typeof value === 'number' && Number.isFinite(value)) {
              return { type: 'float', value: String(value) };
            }

            if (typeof value === 'boolean') {
              return { type: 'integer', value: value ? '1' : '0' };
            }

            return { type: 'text', value: String(value) };
          }),
        },
      },
      { type: 'close' },
    ],
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TURSO_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Turso HTTP ${response.status}: ${text.slice(0, 1500)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Turso retornou resposta inválida: ${text.slice(0, 1500)}`);
  }

  const first = data.results?.[0];

  if (first?.type === 'error') {
    throw new Error(
      `Turso SQL: ${first.error?.message || JSON.stringify(first)}`
    );
  }

  if (first?.type !== 'ok') {
    throw new Error(`Resposta inesperada do Turso: ${JSON.stringify(data).slice(0, 2000)}`);
  }

  return first.result;
}

function rowsFromResult(result) {
  if (!result) return [];

  const cols = (result.cols || []).map(c =>
    typeof c === 'string' ? c : c.name
  );

  return (result.rows || []).map(row => {
    const obj = {};
    cols.forEach((col, i) => {
      const cell = row[i];

      // O protocolo libSQL normalmente devolve {type,value}.
      if (cell && typeof cell === 'object' && 'type' in cell) {
        if (cell.type === 'null') obj[col] = null;
        else obj[col] = cell.value;
      } else {
        obj[col] = cell;
      }
    });
    return obj;
  });
}

async function getTursoTables() {
  const result = await tursoExecute(`
    SELECT name
    FROM sqlite_master
    WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);

  return rowsFromResult(result).map(r => r.name);
}

async function getTursoColumns(table) {
  // Nome de tabela vem do sqlite_master/PRAGMA, nunca de entrada externa direta.
  const result = await tursoExecute(`PRAGMA table_info("${table.replaceAll('"', '""')}")`);
  return rowsFromResult(result).map(r => ({
    name: r.name,
    type: r.type,
    pk: String(r.pk) === '1',
  }));
}

function scoreProductTable(table, columns) {
  const names = new Set(columns.map(c => c.name.toLowerCase()));

  let score = 0;

  if (names.has('id')) score += 5;
  if (names.has('name')) score += 5;
  if (names.has('price')) score += 3;
  if (names.has('category')) score += 2;
  if (names.has('subcategory')) score += 2;
  if (names.has('photos')) score += 2;
  if (names.has('photo')) score += 1;
  if (/product|produto|catalog|catalogo/i.test(table)) score += 3;

  return score;
}

async function chooseTursoTable() {
  if (TURSO_TABLE) {
    const columns = await getTursoColumns(TURSO_TABLE);
    if (!columns.length) {
      throw new Error(`A tabela TURSO_TABLE="${TURSO_TABLE}" não existe ou não possui colunas.`);
    }
    return { table: TURSO_TABLE, columns };
  }

  const tables = await getTursoTables();

  if (!tables.length) {
    throw new Error('O banco Turso não possui tabelas. O index.html atual precisa criar a estrutura antes da migração.');
  }

  const candidates = [];

  for (const table of tables) {
    const columns = await getTursoColumns(table);
    candidates.push({
      table,
      columns,
      score: scoreProductTable(table, columns),
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];

  console.log('\n📋 Tabelas encontradas no Turso:');
  for (const c of candidates) {
    console.log(`   ${c.table} — pontuação ${c.score}`);
  }

  if (!best || best.score < 8) {
    throw new Error(
      'Não consegui identificar com segurança a tabela de produtos no Turso. ' +
      'Defina TURSO_TABLE com o nome exato da tabela.'
    );
  }

  return best;
}

async function discoverSupabaseTable() {
  if (SUPABASE_TABLE) return SUPABASE_TABLE;

  // Primeiro tentamos a tabela mais provável.
  const likely = ['products', 'produtos', 'catalog_products', 'catalogo_produtos'];

  for (const table of likely) {
    try {
      const data = await supabaseFetch(
        `/${encodeURIComponent(table)}?select=id&limit=1`
      );
      if (Array.isArray(data)) return table;
    } catch {
      // Continua tentando.
    }
  }

  throw new Error(
    'Não consegui descobrir a tabela de produtos no Supabase. ' +
    'Defina SUPABASE_TABLE com o nome exato da tabela.'
  );
}

async function loadSupabaseProducts(table) {
  const all = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query =
      `/${encodeURIComponent(table)}` +
      `?select=*` +
      `&order=id.asc` +
      `&offset=${offset}` +
      `&limit=${PAGE_SIZE}`;

    const page = await supabaseFetch(query);

    if (!Array.isArray(page)) {
      throw new Error('A resposta do Supabase não é uma lista de produtos.');
    }

    all.push(...page);

    console.log(`   Supabase: ${all.length} produto(s) lido(s)...`);

    if (page.length < PAGE_SIZE) break;

    await sleep(100);
  }

  return all;
}

function cleanProduct(product) {
  const p = { ...product };

  // Compatibilidade com o catálogo atual.
  if (!Array.isArray(p.photos)) {
    if (p.photo) p.photos = [p.photo];
    else p.photos = [];
  }

  if (p.photo === undefined || p.photo === null) {
    p.photo = p.photos[0] || '';
  }

  if (p.color === undefined || p.color === null) p.color = '';
  if (p.variantGroup === undefined || p.variantGroup === null) {
    p.variantGroup = p.id ?? '';
  }
  if (p.stock === undefined || p.stock === null) p.stock = 0;
  if (p.featured === undefined || p.featured === null) p.featured = false;

  return p;
}

function commonColumns(supabaseProducts, tursoColumns) {
  const available = new Set(tursoColumns.map(c => c.name));

  const preferred = [
    'id',
    'name',
    'category',
    'subcategory',
    'subsubcategory',
    'subfinal',
    'price',
    'oldPrice',
    'color',
    'variantGroup',
    'stock',
    'featured',
    'description',
    'width',
    'height',
    'depth',
    'installments',
    'photos',
    'photo',
    'created_at',
    'updated_at',
  ];

  const discovered = new Set();

  for (const product of supabaseProducts) {
    for (const key of Object.keys(product)) {
      if (available.has(key)) discovered.add(key);
    }
  }

  // Garante ID primeiro, depois os campos conhecidos e, por fim,
  // outros campos que existam simultaneamente nas duas bases.
  const result = [];

  for (const key of preferred) {
    if (available.has(key) && discovered.has(key) && !result.includes(key)) {
      result.push(key);
    }
  }

  for (const key of discovered) {
    if (!result.includes(key)) result.push(key);
  }

  return result;
}

function sqlIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function serializeValue(value) {
  if (value === undefined) return null;

  // Objetos/arrays precisam virar JSON porque SQLite/Turso guarda o valor
  // como TEXT na estrutura do catálogo.
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return JSON.stringify(value);
  }

  if (typeof value === 'boolean') return value ? 1 : 0;

  return value;
}

async function ensureUniqueId(product, existingIds) {
  const id = product.id;

  if (id === undefined || id === null || String(id).trim() === '') {
    throw new Error(
      `Produto "${product.name || '(sem nome)'}" não possui ID. ` +
      'A migração não vai inventar um ID para evitar quebrar compartilhamentos existentes.'
    );
  }

  const key = String(id);

  if (existingIds.has(key)) return;

  existingIds.add(key);
}

async function getExistingIds(table) {
  try {
    const result = await tursoExecute(
      `SELECT ${sqlIdentifier('id')} AS id FROM ${sqlIdentifier(table)}`
    );

    return new Set(
      rowsFromResult(result)
        .map(r => r.id)
        .filter(v => v !== null && v !== undefined)
        .map(String)
    );
  } catch (error) {
    console.warn(
      '\n⚠️ Não consegui ler os IDs existentes no Turso. ' +
      'O UPSERT ainda será usado, mas confira o schema antes de executar.\n'
    );
    return new Set();
  }
}

async function upsertProduct(table, columns, product) {
  const safeProduct = cleanProduct(product);

  const names = columns.map(sqlIdentifier).join(', ');
  const placeholders = columns.map(() => '?').join(', ');

  const updates = columns
    .filter(c => c !== 'id')
    .map(c => `${sqlIdentifier(c)}=excluded.${sqlIdentifier(c)}`)
    .join(', ');

  const values = columns.map(column => serializeValue(safeProduct[column]));

  const sql = `
    INSERT INTO ${sqlIdentifier(table)} (${names})
    VALUES (${placeholders})
    ON CONFLICT(${sqlIdentifier('id')})
    DO UPDATE SET ${updates}
  `;

  await tursoExecute(sql, values);
}

async function main() {
  console.log('\n==============================================');
  console.log('  MIGRAÇÃO SUPABASE → TURSO');
  console.log('  Catálogo Casas Bahia');
  console.log('==============================================\n');

  if (!SUPABASE_URL) die('SUPABASE_URL não configurada.');
  if (!SUPABASE_KEY) die('Chave do Supabase não configurada.');
  if (!TURSO_DATABASE_URL) die('TURSO_DATABASE_URL não configurada.');
  if (!TURSO_AUTH_TOKEN) die('TURSO_AUTH_TOKEN não configurado.');

  if (DRY_RUN) {
    console.log('🔎 MODO DRY RUN: nenhuma gravação será feita no Turso.\n');
  }

  console.log('1) Descobrindo tabela do Supabase...');
  const supabaseTable = await discoverSupabaseTable();
  console.log(`   ✅ Supabase: ${supabaseTable}`);

  console.log('\n2) Lendo produtos do Supabase...');
  const products = await loadSupabaseProducts(supabaseTable);

  console.log(`   ✅ Total encontrado: ${products.length}`);

  if (!products.length) {
    die(
      'O Supabase respondeu, mas não retornou produtos. ' +
      'Não vou alterar o Turso.'
    );
  }

  console.log('\n3) Descobrindo estrutura do Turso...');
  const turso = await chooseTursoTable();

  console.log(`   ✅ Tabela de destino: ${turso.table}`);
  console.log(
    `   Colunas: ${turso.columns.map(c => c.name).join(', ')}`
  );

  const columns = commonColumns(products, turso.columns);

  if (!columns.includes('id')) {
    die('A tabela do Turso não possui a coluna "id". A migração foi interrompida.');
  }

  if (!columns.includes('name')) {
    console.warn('⚠️ A tabela do Turso não possui "name". Continuarei apenas se o schema permitir.');
  }

  console.log(`\n4) Campos que serão migrados: ${columns.join(', ')}`);

  const existingIds = DRY_RUN
    ? new Set()
    : await getExistingIds(turso.table);

  let insertedOrUpdated = 0;
  let failed = 0;

  console.log('\n5) Preparando transferência...\n');

  for (let i = 0; i < products.length; i++) {
    const product = cleanProduct(products[i]);
    const id = product.id;

    try {
      await ensureUniqueId(product, new Set());

      if (DRY_RUN) {
        console.log(
          `   [${i + 1}/${products.length}] OK — ${id} — ${product.name || '(sem nome)'}`
        );
        continue;
      }

      const existed = existingIds.has(String(id));

      await upsertProduct(turso.table, columns, product);

      insertedOrUpdated++;
      existingIds.add(String(id));

      console.log(
        `   [${i + 1}/${products.length}] ${existed ? 'ATUALIZADO' : 'INSERIDO'} — ${id} — ${product.name || '(sem nome)'}`
      );
    } catch (error) {
      failed++;
      console.error(
        `   ❌ [${i + 1}/${products.length}] ${id || '(sem ID)'} — ${product.name || '(sem nome)'}`
      );
      console.error(`      ${error.message}`);
    }
  }

  console.log('\n==============================================');

  if (DRY_RUN) {
    console.log('✅ DRY RUN concluído.');
    console.log(`   Produtos que seriam migrados: ${products.length}`);
    console.log(`   Nada foi gravado no Turso.`);
  } else {
    console.log('✅ MIGRAÇÃO CONCLUÍDA.');
    console.log(`   Lidos do Supabase: ${products.length}`);
    console.log(`   Inseridos/atualizados no Turso: ${insertedOrUpdated}`);
    console.log(`   Falhas: ${failed}`);

    if (failed === 0) {
      console.log('\n🎉 Todos os produtos foram transferidos sem apagar os atuais do Turso.');
    } else {
      console.log('\n⚠️ Houve falhas. NÃO apague o Supabase ainda.');
    }
  }

  console.log('==============================================\n');
}

main().catch(error => {
  console.error('\n❌ MIGRAÇÃO INTERROMPIDA');
  console.error(error.stack || error.message || error);
  process.exit(1);
});
