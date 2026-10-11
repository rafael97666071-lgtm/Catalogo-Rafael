#!/usr/bin/env node
'use strict';

/**
 * Importa supabase-products.csv para a tabela products do Turso.
 * Não acessa o Supabase, não apaga produtos e faz UPSERT por id.
 *
 * Requer: npm install @libsql/client
 * Variáveis: TURSO_DATABASE_URL e TURSO_AUTH_TOKEN
 * Arquivo: supabase-products.csv na raiz do repositório
 */

const fs = require('node:fs');
const { createClient } = require('@libsql/client');

const CSV_PATH = process.env.CSV_PATH || 'supabase-products.csv';
const EXPECTED_PRODUCTS = 87;

function fail(message) {
  console.error(`\nERRO: ${message}\n`);
  process.exit(1);
}

// Parser CSV que respeita campos entre aspas, vírgulas, aspas escapadas e quebras de linha.
function parseCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field.length === 0) {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (!(row.length === 1 && row[0] === '')) records.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (inQuotes) fail('CSV inválido: campo com aspas não foi fechado.');
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (!(row.length === 1 && row[0] === '')) records.push(row);
  }

  if (records.length < 2) fail('O CSV não contém linhas de produtos.');
  const headers = records[0].map((h, i) => i === 0 ? h.replace(/^\uFEFF/, '').trim() : h.trim());
  const result = records.slice(1).map((cells, index) => {
    if (cells.length !== headers.length) {
      fail(`Linha CSV ${index + 2} tem ${cells.length} campos; esperava ${headers.length}.`);
    }
    return Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
  });
  return result;
}

function parseNullableNumber(value) {
  const s = String(value ?? '').trim();
  if (!s || s.toLowerCase() === 'null') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) fail(`Valor numérico inválido: ${s.slice(0, 80)}`);
  return n;
}

function parseTimestamp(value) {
  const s = String(value ?? '').trim();
  if (!s || s.toLowerCase() === 'null') return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function parseProduct(row, index) {
  const id = String(row.id ?? '').trim();
  if (!id) fail(`Produto na linha ${index + 2} não tem ID.`);

  let photos;
  try {
    const raw = String(row.photos ?? '').trim();
    photos = raw && raw.toLowerCase() !== 'null' ? JSON.parse(raw) : [];
  } catch (e) {
    fail(`Não foi possível interpretar o JSON das fotos do produto ${id}: ${e.message}`);
  }
  if (!Array.isArray(photos)) fail(`A coluna photos do produto ${id} não é uma lista JSON.`);

  const featuredText = String(row.featured ?? '').trim().toLowerCase();
  const featured = ['true', '1', 't', 'yes'].includes(featuredText) ? 1 : 0;

  return {
    id,
    name: row.name || '',
    category: row.category || '',
    subcategory: row.subcategory || '',
    subfinal: row.subfinal || '',
    price: parseNullableNumber(row.price) ?? 0,
    old_price: parseNullableNumber(row.old_price),
    color: row.color || '',
    variant_group: row.variant_group || id,
    stock: Math.trunc(parseNullableNumber(row.stock) ?? 0),
    featured,
    description: row.description || '',
    width: row.width || '',
    height: row.height || '',
    depth: row.depth || '',
    installments: row.installments || '',
    photos: JSON.stringify(photos),
    created_at: parseTimestamp(row.created_at) ?? Math.floor(Date.now() / 1000),
  };
}

async function main() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    fail('Configure TURSO_DATABASE_URL e TURSO_AUTH_TOKEN nos GitHub Secrets.');
  }
  if (!fs.existsSync(CSV_PATH)) {
    fail(`Não encontrei ${CSV_PATH}. Coloque supabase-products.csv na raiz do repositório.`);
  }

  console.log('Lendo o CSV; isso pode levar alguns segundos...');
  const content = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(content);
  if (rows.length !== EXPECTED_PRODUCTS) {
    fail(`Esperava ${EXPECTED_PRODUCTS} produtos, mas encontrei ${rows.length}. Nenhuma gravação foi feita.`);
  }

  const products = rows.map(parseProduct);
  const ids = products.map(p => p.id);
  if (new Set(ids).size !== ids.length) fail('Há IDs duplicados no CSV. Nenhuma gravação foi feita.');

  console.log(`Validação concluída: ${products.length} produtos e IDs únicos.`);
  console.log('Conectando ao Turso...');
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const before = await client.execute('SELECT COUNT(*) AS total FROM products');
  console.log(`Produtos na tabela antes da importação: ${before.rows[0].total}`);

  const sql = `INSERT INTO products
    (id,name,category,subcategory,subfinal,price,old_price,color,variant_group,stock,featured,
     description,width,height,depth,installments,photos,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, category=excluded.category, subcategory=excluded.subcategory,
      subfinal=excluded.subfinal, price=excluded.price, old_price=excluded.old_price,
      color=excluded.color, variant_group=excluded.variant_group, stock=excluded.stock,
      featured=excluded.featured, description=excluded.description, width=excluded.width,
      height=excluded.height, depth=excluded.depth, installments=excluded.installments,
      photos=excluded.photos`;

  let completed = 0;
  for (const p of products) {
    await client.execute({
      sql,
      args: [
        p.id, p.name, p.category, p.subcategory, p.subfinal, p.price, p.old_price,
        p.color, p.variant_group, p.stock, p.featured, p.description, p.width,
        p.height, p.depth, p.installments, p.photos, p.created_at,
      ],
    });
    completed++;
    if (completed % 10 === 0 || completed === products.length) {
      console.log(`Importados/atualizados: ${completed}/${products.length}`);
    }
  }

  const after = await client.execute('SELECT COUNT(*) AS total FROM products');
  const sourceIds = await client.execute({
    sql: `SELECT COUNT(*) AS total FROM products WHERE id IN (${ids.map(() => '?').join(',')})`,
    args: ids,
  });

  console.log('\nImportação finalizada.');
  console.log(`Produtos encontrados no CSV: ${products.length}`);
  console.log(`IDs do CSV presentes no Turso: ${sourceIds.rows[0].total}`);
  console.log(`Total de produtos no Turso após a importação: ${after.rows[0].total}`);

  if (Number(sourceIds.rows[0].total) !== EXPECTED_PRODUCTS) {
    fail('A conferência final não encontrou os 87 IDs no Turso.');
  }
  if (Number(after.rows[0].total) !== EXPECTED_PRODUCTS) {
    console.warn('ATENÇÃO: o total da tabela não é 87. Não apague nada; pode haver produtos adicionais no Turso que não fazem parte do CSV.');
  } else {
    console.log('Conferência OK: a tabela tem exatamente 87 produtos.');
  }
  await client.close();
}

main().catch(error => {
  console.error('\nImportação interrompida:', error.message || error);
  process.exit(1);
});
