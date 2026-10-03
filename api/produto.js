const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tuptrzvdqbaoohlerrfz.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_s9D9xICwKMA6vNLBO3eD6Q_yvUlMiXd';


function esc(value='') {
return String(value)
.replace(/&/g,'&')
.replace(/</g,'<')
.replace(/>/g,'>')
.replace(/"/g,'"')
.replace(/'/g,''');
}


function numberBR(value){
const n=Number(value);
if(!Number.isFinite(n)) return '';
return n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
}


function absoluteOrigin(req){
const proto=(req.headers && (req.headers['x-forwarded-proto'] || req.headers['x-forwarded-protocol'])) || 'https';
const host=req.headers && req.headers.host;
return ${proto}://${host};
}


async function getProduct(id){
if(!id) return null;


const url = ${SUPABASE_URL}/rest/v1/products?id=eq.${encodeURIComponent(String(id))}&select=*;


const r = await fetch(url,{
headers:{
apikey:SUPABASE_PUBLISHABLE_KEY,
Accept:'application/json'
}
});


if(!r.ok) throw new Error(Supabase ${r.status});


const rows=await r.json();


return Array.isArray(rows) && rows.length ? rows[0] : null;
}


function firstPhoto(product){
const photos=Array.isArray(product?.photos) ? product.photos : [];


if(photos.length) return photos[0];


return product?.photo || '';
}


function parseDataImage(data){
const m=String(data||'').match(
/^data:(image/[a-zA-Z0-9.+-]+)(?:;charset=[^;]+)?(?:;(base64))?,(.*)$/s
);


if(!m) return null;


const type=m[1].toLowerCase();
const body=m[3];
const isBase64=m[2]==='base64';


const buffer=Buffer.from(
isBase64 ? body : decodeURIComponent(body),
isBase64 ? 'base64' : 'utf8'
);


return {type,buffer};
}


async function sendImage(req,res,photo){


const parsed=parseDataImage(photo);


if(parsed){
res.setHeader('Content-Type',parsed.type);


res.setHeader(
  'Cache-Control',
  'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
);

res.status(200).end(parsed.buffer);
return;



}


if(/^https?:///i.test(String(photo||''))){


const r = await fetch(String(photo), {
  redirect:'follow'
});

if(!r.ok){
  res.status(404).send('Imagem não encontrada');
  return;
}

const contentType = r.headers.get('content-type') || 'image/jpeg';

if(!/^image\//i.test(contentType)){
  res.status(415).send('O endereço não retornou uma imagem');
  return;
}

const buffer=Buffer.from(await r.arrayBuffer());

res.setHeader('Content-Type',contentType);

res.setHeader(
  'Cache-Control',
  'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
);

res.status(200).end(buffer);
return;



}


res.status(404).send('Imagem não encontrada');
}


module.exports = async function handler(req,res){


try{


const id =
  req.query?.id ||
  new URL(
    req.url,
    `https://${req.headers.host}`
  ).searchParams.get('id');

const imageMode =
  String(
    req.query?.imagem ||
    new URL(
      req.url,
      `https://${req.headers.host}`
    ).searchParams.get('imagem') ||
    ''
  ) === '1';

const product=await getProduct(id);

if(!product){
  res.status(404).send('Produto não encontrado');
  return;
}

const photo=firstPhoto(product);

if(imageMode){
  await sendImage(req,res,photo);
  return;
}

const origin=absoluteOrigin(req);

const shareUrl=
  `${origin}/api/produto?id=${encodeURIComponent(String(product.id))}`;

const appUrl=
  `${origin}/?cliente=1&produto=${encodeURIComponent(String(product.id))}`;

const imageUrl=
  `${origin}/api/produto?id=${encodeURIComponent(String(product.id))}&imagem=1`;

const name=product.name || 'Produto';

const rawPhoto=String(photo||'').toLowerCase();

const imageType =
  rawPhoto.startsWith('data:image/png') ? 'image/png' :
  rawPhoto.startsWith('data:image/webp') ? 'image/webp' :
  rawPhoto.startsWith('data:image/gif') ? 'image/gif' :
  rawPhoto.startsWith('data:image/avif') ? 'image/avif' :
  'image/jpeg';

const price=numberBR(product.price);

const category=[
  product.category,
  product.subcategory,
  product.subfinal || product.subsubcategory
].filter(Boolean).join(' › ');

const description =
  (category ? `${category}. ` : '') +
  (price ? `Preço: ${price}.` : 'Veja este produto no catálogo.');

const html=`<!doctype html>



























Abrindo o produto ${esc(name)}…



Abrir produto




`;

res.setHeader(
  'Content-Type',
  'text/html; charset=utf-8'
);

res.setHeader(
  'Cache-Control',
  'public, max-age=60, s-maxage=300, stale-while-revalidate=600'
);

res.status(200).send(html);



}catch(err){


console.error(err);

res.status(500).send(
  'Não foi possível gerar o compartilhamento do produto.'
);



}
};


