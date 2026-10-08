const { createClient } = require('@libsql/client');
const crypto = require('crypto');

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const ADMIN_EMAIL = (process.env.CATALOGO_ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.CATALOGO_ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.CATALOGO_SESSION_SECRET || '';

let dbPromise;
async function db() {
  if (!TURSO_URL || !TURSO_TOKEN) throw new Error('TURSO_DATABASE_URL/TURSO_AUTH_TOKEN não configurados.');
  if (!dbPromise) {
    const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
    dbPromise = (async () => {
      await client.batch([
        { sql: `CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT '',
          subcategory TEXT NOT NULL DEFAULT '',
          subfinal TEXT NOT NULL DEFAULT '',
          price REAL NOT NULL DEFAULT 0,
          old_price REAL,
          color TEXT NOT NULL DEFAULT '',
          variant_group TEXT NOT NULL DEFAULT '',
          stock INTEGER NOT NULL DEFAULT 0,
          featured INTEGER NOT NULL DEFAULT 0,
          description TEXT NOT NULL DEFAULT '',
          width TEXT NOT NULL DEFAULT '',
          height TEXT NOT NULL DEFAULT '',
          depth TEXT NOT NULL DEFAULT '',
          installments TEXT NOT NULL DEFAULT '',
          photos TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )`, args: [] },
        { sql: `CREATE TABLE IF NOT EXISTS catalog_settings (
          id INTEGER PRIMARY KEY,
          whatsapp TEXT NOT NULL DEFAULT ''
        )`, args: [] }
      ]);
      return client;
    })();
  }
  return dbPromise;
}

function json(res, status, data) {
  res.status(status).setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  return res.status(status).json(data);
}
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function signToken(payload) {
  const head=b64url(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const body=b64url(JSON.stringify(payload));
  const sig=b64url(crypto.createHmac('sha256',SESSION_SECRET).update(head+'.'+body).digest());
  return `${head}.${body}.${sig}`;
}
function verifyToken(token) {
  if(!SESSION_SECRET || !token) return false;
  const parts=String(token).split('.');
  if(parts.length!==3)return false;
  const [h,p,s]=parts;
  const expected=b64url(crypto.createHmac('sha256',SESSION_SECRET).update(h+'.'+p).digest());
  const a=Buffer.from(s), b=Buffer.from(expected);
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b))return false;
  try {
    const payload=JSON.parse(Buffer.from(p,'base64url').toString('utf8'));
    return Number(payload.exp||0)>Math.floor(Date.now()/1000);
  } catch(e) { return false; }
}
function bearer(req) {
  const v=req.headers.authorization||'';
  return v.startsWith('Bearer ')?v.slice(7):'';
}
function requireAdmin(req) {
  if(!verifyToken(bearer(req))) {
    const err=new Error('UNAUTHORIZED'); err.status=401; throw err;
  }
}

function rowToProduct(row) {
  let photos=[];
  try { photos=JSON.parse(row.photos||'[]'); } catch(e) {}
  return {...row, photos};
}
function productArgs(p) {
  return [
    String(p.id), p.name||'', p.category||'', p.subcategory||'', p.subfinal||'',
    Number(p.price)||0, p.old_price==null?null:Number(p.old_price),
    p.color||'', p.variant_group||String(p.id), Number(p.stock)||0,
    p.featured?1:0, p.description||'', p.width||'', p.height||'', p.depth||'',
    p.installments||'', JSON.stringify(Array.isArray(p.photos)?p.photos:[])
  ];
}

module.exports = async (req,res) => {
  try {
    const action = String(req.query.acao||'');
    if(!action) return json(res,400,{error:'Ação não informada.'});

    if(action==='login') {
      if(req.method!=='POST') return json(res,405,{error:'Método não permitido.'});
      if(!ADMIN_EMAIL || !ADMIN_PASSWORD || !SESSION_SECRET) return json(res,500,{error:'As credenciais de administrador ainda não foram configuradas na Vercel.'});
      const {email,password}=req.body||{};
      if(String(email||'').trim().toLowerCase()!==ADMIN_EMAIL || String(password||'')!==ADMIN_PASSWORD)
        return json(res,401,{error:'E-mail ou senha inválidos.'});
      const now=Math.floor(Date.now()/1000), exp=now+30*24*60*60;
      return json(res,200,{access_token:signToken({sub:ADMIN_EMAIL,iat:now,exp}),expires_at:exp});
    }

    if(action==='produtos') {
      const client=await db();
      const r=await client.execute(`SELECT * FROM products ORDER BY created_at ASC`);
      return json(res,200,r.rows.map(rowToProduct));
    }

    if(action.startsWith('produto&id=')) {
      const id=decodeURIComponent(action.slice('produto&id='.length));
      const client=await db();
      const r=await client.execute({sql:`SELECT * FROM products WHERE id=? LIMIT 1`,args:[String(id)]});
      return json(res,200,r.rows[0]?rowToProduct(r.rows[0]):null);
    }

    if(action==='whatsapp') {
      const client=await db();
      const r=await client.execute(`SELECT whatsapp FROM catalog_settings WHERE id=1 LIMIT 1`);
      return json(res,200,r.rows[0]||{whatsapp:''});
    }

    requireAdmin(req);

    if(action==='upsertProdutos') {
      if(req.method!=='POST') return json(res,405,{error:'Método não permitido.'});
      const produtos=Array.isArray(req.body?.produtos)?req.body.produtos:[];
      if(!produtos.length)return json(res,200,{ok:true});
      const client=await db();
      const sql=`INSERT INTO products
        (id,name,category,subcategory,subfinal,price,old_price,color,variant_group,stock,featured,description,width,height,depth,installments,photos)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,category=excluded.category,subcategory=excluded.subcategory,
          subfinal=excluded.subfinal,price=excluded.price,old_price=excluded.old_price,
          color=excluded.color,variant_group=excluded.variant_group,stock=excluded.stock,
          featured=excluded.featured,description=excluded.description,width=excluded.width,
          height=excluded.height,depth=excluded.depth,installments=excluded.installments,
          photos=excluded.photos`;
      await client.batch(produtos.map(p=>({sql,args:productArgs(p)})));
      return json(res,200,{ok:true,count:produtos.length});
    }

    if(action==='excluirProduto') {
      if(req.method!=='POST') return json(res,405,{error:'Método não permitido.'});
      const id=String(req.body?.id||'');
      if(!id)return json(res,400,{error:'ID não informado.'});
      const client=await db();
      await client.execute({sql:`DELETE FROM products WHERE id=?`,args:[id]});
      return json(res,200,{ok:true});
    }

    if(action==='salvarWhatsapp') {
      if(req.method!=='POST') return json(res,405,{error:'Método não permitido.'});
      const whatsapp=String(req.body?.whatsapp||'');
      const client=await db();
      await client.execute({
        sql:`INSERT INTO catalog_settings(id,whatsapp) VALUES(1,?)
             ON CONFLICT(id) DO UPDATE SET whatsapp=excluded.whatsapp`,
        args:[whatsapp]
      });
      return json(res,200,{ok:true});
    }

    return json(res,404,{error:'Ação desconhecida.'});
  } catch(e) {
    console.error(e);
    return json(res,e.status||500,{error:e.message||'Erro interno.'});
  }
};
