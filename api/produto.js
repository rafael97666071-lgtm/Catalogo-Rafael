const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tuptrzvdqbaoohlerrfz.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_s9D9xICwKMA6vNLBO3eD6Q_yvUlMiXd';

function esc(value='') {
  return String(value)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

function numberBR(value){
  const n=Number(value);
  if(!Number.isFinite(n)) return '';
  return n.toLocaleString('pt-BR',{
    style:'currency',
    currency:'BRL'
  });
}

function absoluteOrigin(req){
  const proto=
    (req.headers &&
      (req.headers['x-forwarded-proto'] ||
       req.headers['x-forwarded-protocol'])) ||
    'https';

  const host=req.headers && req.headers.host;

  return `${proto}://${host}`;
}

function queryParam(req,name){
  try{
    if(req.query && req.query[name] != null){
      return req.query[name];
    }

    return new URL(
      req.url,
      `https://${req.headers.host}`
    ).searchParams.get(name);

  }catch(e){
    return null;
  }
}

function isBrowserNavigation(req){
  const dest=String(
    req.headers?.['sec-fetch-dest'] || ''
  ).toLowerCase();

  const mode=String(
    req.headers?.['sec-fetch-mode'] || ''
  ).toLowerCase();

  return dest === 'document' || mode === 'navigate';
}

function isPreviewBot(req){
  const ua=String(
    req.headers?.['user-agent'] || ''
  ).toLowerCase();

  /*
    Quando o próprio WhatsApp monta a prévia,
    normalmente ele consulta o link sem os
    cabeçalhos de navegação de um navegador.

    Quando uma pessoa toca no link dentro do WhatsApp,
    o navegador envia cabeçalhos como:
    sec-fetch-dest=document
    sec-fetch-mode=navigate

    Nesse caso, tratamos como usuário normal.
  */

  if(ua.includes('whatsapp')){
    return !isBrowserNavigation(req);
  }

  const bots=[
    'facebookexternalhit',
    'facebot',
    'twitterbot',
    'linkedinbot',
    'telegrambot',
    'slackbot',
    'discordbot',
    'googlebot',
    'bingbot',
    'applebot',
    'pinterestbot'
  ];

  return bots.some(bot=>ua.includes(bot));
}

async function getProduct(id){
  if(!id) return null;

  const url =
    `${SUPABASE_URL}/rest/v1/products?id=eq.` +
    `${encodeURIComponent(String(id))}&select=*`;

  const r=await fetch(url,{
    headers:{
      apikey:SUPABASE_PUBLISHABLE_KEY,
      Accept:'application/json'
    }
  });

  if(!r.ok){
    throw new Error(`Supabase ${r.status}`);
  }

  const rows=await r.json();

  return Array.isArray(rows) && rows.length
    ? rows[0]
    : null;
}

function firstPhoto(product){
  const photos=
    Array.isArray(product?.photos)
      ? product.photos
      : [];

  if(photos.length){
    return photos[0];
  }

  return product?.photo || '';
}

function parseDataImage(data){
  const m=String(data||'').match(
    /^data:(image\/[a-zA-Z0-9.+-]+)(?:;charset=[^;]+)?(?:;(base64))?,(.*)$/s
  );

  if(!m){
    return null;
  }

  const type=m[1].toLowerCase();
  const body=m[3];
  const isBase64=m[2] === 'base64';

  const buffer=Buffer.from(
    isBase64
      ? body
      : decodeURIComponent(body),
    isBase64
      ? 'base64'
      : 'utf8'
  );

  return {
    type,
    buffer
  };
}

async function sendImage(req,res,photo){
  const parsed=parseDataImage(photo);

  if(parsed){
    res.setHeader(
      'Content-Type',
      parsed.type
    );

    res.setHeader(
      'Cache-Control',
      'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
    );

    res.setHeader(
      'CDN-Cache-Control',
      'public, max-age=86400, stale-while-revalidate=604800'
    );

    res.status(200).end(parsed.buffer);
    return;
  }

  if(/^https?:\/\//i.test(String(photo||''))){
    res.setHeader(
      'Location',
      photo
    );

    res.setHeader(
      'Cache-Control',
      'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
    );

    res.setHeader(
      'CDN-Cache-Control',
      'public, max-age=86400, stale-while-revalidate=604800'
    );

    res.status(302).end();
    return;
  }

  res.status(404).send(
    'Imagem não encontrada'
  );
}

module.exports = async function handler(req,res){

  try{

    const id=queryParam(req,'id');

    const imageMode=
      String(
        queryParam(req,'imagem') || ''
      ) === '1';

    if(!id){
      res.status(400).send(
        'Produto não informado'
      );
      return;
    }

    const origin=absoluteOrigin(req);

    const appUrl=
      `${origin}/?cliente=1&produto=` +
      `${encodeURIComponent(String(id))}`;

    /*
      USUÁRIO NORMAL
      --------------
      Vai direto para o catálogo.
      Não consulta o Supabase aqui.
      Não gera página intermediária.
    */

    if(
      !imageMode &&
      !isPreviewBot(req)
    ){

      res.setHeader(
        'Cache-Control',
        'no-store'
      );

      res.setHeader(
        'Location',
        appUrl
      );

      res.status(302).end();

      return;
    }

    /*
      ROBÔ DE PRÉVIA
      --------------
      Aqui sim consultamos o Supabase
      para montar a prévia do WhatsApp,
      Facebook, Telegram etc.
    */

    const product=await getProduct(id);

    if(!product){
      res.status(404).send(
        'Produto não encontrado'
      );
      return;
    }

    const photo=firstPhoto(product);

    if(imageMode){

      await sendImage(
        req,
        res,
        photo
      );

      return;
    }

    const shareUrl=
      `${origin}/api/produto?id=` +
      `${encodeURIComponent(String(product.id))}`;

    const imageUrl=
      `${origin}/api/produto?id=` +
      `${encodeURIComponent(String(product.id))}` +
      `&imagem=1`;

    const name=
      product.name ||
      'Produto';

    const price=
      numberBR(product.price);

    const category=[
      product.category,
      product.subcategory,
      product.subfinal ||
        product.subsubcategory
    ]
      .filter(Boolean)
      .join(' › ');

    const description=
      (category
        ? `${category}. `
        : '') +
      (
        price
          ? `Preço: ${price}.`
          : 'Veja este produto no catálogo.'
      );

    const html=`<!doctype html>
<html lang="pt-BR">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
${esc(name)} | Meu Catálogo
</title>

<meta
  property="og:title"
  content="${esc(name)}"
/>

<meta
  property="og:type"
  content="website"
/>

<meta
  property="og:url"
  content="${esc(shareUrl)}"
/>

<meta
  property="og:image"
  content="${esc(imageUrl)}"
/>

<meta
  property="og:image:secure_url"
  content="${esc(imageUrl)}"
/>

<meta
  property="og:image:type"
  content="image/jpeg"
/>

<meta
  property="og:image:alt"
  content="${esc(name)}"
/>

<meta
  property="og:description"
  content="${esc(description)}"
/>

<meta
  property="og:site_name"
  content="Meu Catálogo | Casas Bahia"
/>

<meta
  name="twitter:card"
  content="summary_large_image"
/>

<meta
  name="twitter:title"
  content="${esc(name)}"
/>

<meta
  name="twitter:description"
  content="${esc(description)}"
/>

<meta
  name="twitter:image"
  content="${esc(imageUrl)}"
/>

<link
  rel="canonical"
  href="${esc(appUrl)}"
/>

<meta
  http-equiv="refresh"
  content="0;url=${esc(appUrl)}"
>

</head>

<body>

<p>
Abrindo o produto
<strong>${esc(name)}</strong>…
</p>

<p>

<a href="${esc(appUrl)}">
Abrir produto
</a>

</p>

<script>

location.replace(
  ${JSON.stringify(appUrl)}
);

</script>

</body>

</html>`;

    res.setHeader(
      'Content-Type',
      'text/html; charset=utf-8'
    );

    res.setHeader(
      'Cache-Control',
      'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400'
    );

    res.setHeader(
      'CDN-Cache-Control',
      'public, max-age=3600, stale-while-revalidate=86400'
    );

    res.status(200).send(html);

  }catch(err){

    console.error(err);

    res.status(500).send(
      'Não foi possível gerar o compartilhamento do produto.'
    );

  }

};
