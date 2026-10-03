const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  'https://tuptrzvdqbaoohlerrfz.supabase.co';

const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_s9D9xICwKMA6vNLBO3eD6Q_yvUlMiXd';


function esc(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function numberBR(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return '';

  return n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}


function absoluteOrigin(req) {
  const proto =
    (req.headers &&
      (req.headers['x-forwarded-proto'] ||
        req.headers['x-forwarded-protocol'])) ||
    'https';

  const host = req.headers && req.headers.host;

  return `${proto}://${host}`;
}


async function getProduct(id) {
  if (!id) return null;

  const url =
    `${SUPABASE_URL}/rest/v1/products?id=eq.${encodeURIComponent(
      String(id)
    )}&select=*`;

  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Accept: 'application/json'
    }
  });

  if (!r.ok) {
    throw new Error(`Supabase ${r.status}`);
  }

  const rows = await r.json();

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}


function firstPhoto(product) {
  const photos = Array.isArray(product?.photos)
    ? product.photos
    : [];

  if (photos.length) return photos[0];

  return product?.photo || '';
}


function parseDataImage(data) {
  const m = String(data || '').match(
    /^data:(image\/[a-zA-Z0-9.+-]+)(?:;charset=[^;]+)?(?:;(base64))?,(.*)$/s
  );

  if (!m) return null;

  const type = m[1].toLowerCase();
  const body = m[3];
  const isBase64 = m[2] === 'base64';

  const buffer = Buffer.from(
    isBase64 ? body : decodeURIComponent(body),
    isBase64 ? 'base64' : 'utf8'
  );

  return {
    type,
    buffer
  };
}


async function sendImage(req, res, photo) {

  const parsed = parseDataImage(photo);

  if (parsed) {

    res.setHeader(
      'Content-Type',
      parsed.type
    );

    res.setHeader(
      'Cache-Control',
      'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
    );

    res.status(200).end(parsed.buffer);

    return;
  }


  if (/^https?:\/\//i.test(String(photo || ''))) {

    const r = await fetch(String(photo), {
      redirect: 'follow'
    });

    if (!r.ok) {
      res.status(404).send('Imagem não encontrada');
      return;
    }

    const contentType =
      r.headers.get('content-type') || 'image/jpeg';

    if (!/^image\//i.test(contentType)) {
      res.status(415).send(
        'O endereço não retornou uma imagem'
      );
      return;
    }

    const buffer = Buffer.from(
      await r.arrayBuffer()
    );

    res.setHeader(
      'Content-Type',
      contentType
    );

    res.setHeader(
      'Cache-Control',
      'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
    );

    res.status(200).end(buffer);

    return;
  }


  res.status(404).send(
    'Imagem não encontrada'
  );
}


module.exports = async function handler(req, res) {

  try {

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


    const product = await getProduct(id);


    if (!product) {
      res.status(404).send(
        'Produto não encontrado'
      );
      return;
    }


    const photo = firstPhoto(product);


    if (imageMode) {
      await sendImage(req, res, photo);
      return;
    }


    const origin = absoluteOrigin(req);


    const shareUrl =
      `${origin}/api/produto?id=${encodeURIComponent(
        String(product.id)
      )}`;


    const appUrl =
      `${origin}/?cliente=1&produto=${encodeURIComponent(
        String(product.id)
      )}`;


    const imageUrl =
      `${origin}/api/produto?id=${encodeURIComponent(
        String(product.id)
      )}&imagem=1`;


    const name =
      product.name || 'Produto';


    const rawPhoto =
      String(photo || '').toLowerCase();


    const imageType =
      rawPhoto.startsWith('data:image/png')
        ? 'image/png'
        : rawPhoto.startsWith('data:image/webp')
        ? 'image/webp'
        : rawPhoto.startsWith('data:image/gif')
        ? 'image/gif'
        : rawPhoto.startsWith('data:image/avif')
        ? 'image/avif'
        : 'image/jpeg';


    const price =
      numberBR(product.price);


    const category = [
      product.category,
      product.subcategory,
      product.subfinal ||
        product.subsubcategory
    ]
      .filter(Boolean)
      .join(' › ');


    const description =
      (category
        ? `${category}. `
        : '') +
      (price
        ? `Preço: ${price}.`
        : 'Veja este produto no catálogo.');


    const safeName = esc(name);
    const safeDescription = esc(description);
    const safeShareUrl = esc(shareUrl);
    const safeImageUrl = esc(imageUrl);
    const safeAppUrl = esc(appUrl);


    const html = `<!doctype html>
<html lang="pt-BR">
<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<title>${safeName} | Catálogo Casas Bahia</title>

<meta
  name="description"
  content="${safeDescription}"
>

<meta
  property="og:type"
  content="product"
>

<meta
  property="og:title"
  content="${safeName}"
>

<meta
  property="og:description"
  content="${safeDescription}"
>

<meta
  property="og:image"
  content="${safeImageUrl}"
>

<meta
  property="og:image:secure_url"
  content="${safeImageUrl}"
>

<meta
  property="og:image:type"
  content="${imageType}"
>

<meta
  property="og:url"
  content="${safeShareUrl}"
>

<meta
  property="og:site_name"
  content="Catálogo Casas Bahia"
>

<meta
  name="twitter:card"
  content="summary_large_image"
>

<meta
  name="twitter:title"
  content="${safeName}"
>

<meta
  name="twitter:description"
  content="${safeDescription}"
>

<meta
  name="twitter:image"
  content="${safeImageUrl}"
>

<link
  rel="canonical"
  href="${safeShareUrl}"
>

<style>
  body {
    font-family: Arial, sans-serif;
    margin: 0;
    padding: 40px 20px;
    text-align: center;
    background: #f5f5f5;
    color: #222;
  }

  .card {
    max-width: 600px;
    margin: auto;
    background: white;
    padding: 30px;
    border-radius: 18px;
    box-shadow: 0 4px 20px rgba(0,0,0,.08);
  }

  img {
    max-width: 100%;
    max-height: 500px;
    object-fit: contain;
    border-radius: 12px;
  }

  h1 {
    margin: 20px 0 10px;
  }

  p {
    color: #555;
    line-height: 1.5;
  }

  a {
    display: inline-block;
    margin-top: 20px;
    padding: 14px 24px;
    background: #0645d8;
    color: white;
    text-decoration: none;
    border-radius: 10px;
    font-weight: bold;
  }
</style>

</head>

<body>

<div class="card">

  ${
    imageUrl
      ? `<img src="${safeImageUrl}" alt="${safeName}">`
      : ''
  }

  <h1>${safeName}</h1>

  <p>${safeDescription}</p>

  <a href="${safeAppUrl}">
    Abrir produto
  </a>

</div>

</body>
</html>`;


    res.setHeader(
      'Content-Type',
      'text/html; charset=utf-8'
    );


    res.setHeader(
      'Cache-Control',
      'public, max-age=60, s-maxage=300, stale-while-revalidate=600'
    );


    res.status(200).send(html);


  } catch (err) {

    console.error(err);

    res.status(500).send(
      'Não foi possível gerar o compartilhamento do produto.'
    );

  }
};
