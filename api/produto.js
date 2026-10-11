
const { createClient } = require('@libsql/client');

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function esc(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function numberBR(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';

  return n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
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

function getQueryParam(req, name) {
  if (req.query && req.query[name] !== undefined) {
    return req.query[name];
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  return url.searchParams.get(name);
}

async function getProduct(id) {
  if (!id) return null;

  const result = await turso.execute({
    sql: 'SELECT * FROM products WHERE id = ? LIMIT 1',
    args: [String(id)],
  });

  return result.rows.length ? result.rows[0] : null;
}

function normalizePhotos(value) {
  if (Array.isArray(value)) return value;

  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return [parsed];
    return [];
  } catch {
    return [value];
  }
}

function firstPhoto(product) {
  const photos = normalizePhotos(product.photos);

  if (photos.length) {
    const first = photos[0];

    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') {
      return first.url || first.src || first.photo || '';
    }
  }

  return product.photo || '';
}

function parseDataImage(data) {
  const match = String(data || '').match(
    /^data:(image\/[a-zA-Z0-9.+-]+)(?:;charset=[^;]+)?(?:;(base64))?,(.*)$/s
  );

  if (!match) return null;

  const type = match[1].toLowerCase();
  const body = match[3];
  const isBase64 = match[2] === 'base64';

  try {
    const buffer = Buffer.from(
      isBase64 ? body : decodeURIComponent(body),
      isBase64 ? 'base64' : 'utf8'
    );

    return { type, buffer };
  } catch {
    return null;
  }
}

async function sendImage(req, res, photo) {
  const parsed = parseDataImage(photo);

  if (parsed) {
    res.setHeader('Content-Type', parsed.type);
    res.setHeader(
      'Cache-Control',
      'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
    );
    res.status(200).end(parsed.buffer);
    return;
  }

  if (/^https?:\/\//i.test(String(photo || ''))) {
    res.setHeader('Location', photo);
    res.setHeader(
      'Cache-Control',
      'public, max-age=3600, s-maxage=86400'
    );
    res.status(302).end();
    return;
  }

  res.status(404).send('Imagem não encontrada');
}

module.exports = async function handler(req, res) {
  try {
    const id = getQueryParam(req, 'id');
    const imageMode = String(getQueryParam(req, 'imagem') || '') === '1';

    if (!process.env.TURSO_DATABASE_URL ||
        !process.env.TURSO_AUTH_TOKEN) {
      throw new Error('Configuração do Turso ausente');
    }

    const product = await getProduct(id);

    if (!product) {
      res.status(404).send('Produto não encontrado');
      return;
    }

    const photo = firstPhoto(product);

    if (imageMode) {
      await sendImage(req, res, photo);
      return;
    }

    const origin = absoluteOrigin(req);
    const productId = String(product.id);

    const shareUrl =
      `${origin}/api/produto?id=${encodeURIComponent(productId)}`;

    const appUrl =
      `${origin}/?cliente=1&produto=${encodeURIComponent(productId)}`;

    const imageUrl =
      `${origin}/api/produto?id=${encodeURIComponent(productId)}&imagem=1`;

    const name = product.name || 'Produto';
    const price = numberBR(product.price);

    const userAgent = String(
      req.headers && req.headers['user-agent'] || ''
    ).toLowerCase();

    const isPreviewCrawler =
      /(whatsapp|facebookexternalhit|facebot|twitterbot|linkedinbot|telegrambot|slackbot|discordbot|googlebot|bingbot|pinterest|applebot|meta-externalagent)/i
        .test(userAgent);

    res.setHeader('Vary', 'User-Agent');

    if (!isPreviewCrawler) {
      res.setHeader('Location', appUrl);
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, max-age=0'
      );
      res.status(302).end();
      return;
    }

    const category = [
      product.category,
      product.subcategory,
      product.subfinal || product.subsubcategory,
    ].filter(Boolean).join(' › ');

    const description =
      (category ? `${category}. ` : '') +
      (price ? `Preço: ${price}.` : 'Veja este produto no catálogo.');

    const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} | Catálogo Casas Bahia</title>
<meta property="og:title" content="${esc(name)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(shareUrl)}">
<meta property="og:image" content="${esc(imageUrl)}">
<meta property="og:image:secure_url" content="${esc(imageUrl)}">
<meta property="og:image:alt" content="${esc(name)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:site_name" content="Catálogo Casas Bahia">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(name)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(imageUrl)}">
<link rel="canonical" href="${esc(appUrl)}">
<meta http-equiv="refresh" content="0;url=${esc(appUrl)}">
</head>
<body>
<p>Abrindo o produto <strong>${esc(name)}</strong>…</p>
<p><a href="${esc(appUrl)}">Abrir produto</a></p>
<script>
location.replace(${JSON.stringify(appUrl)});
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Cache-Control',
      'public, max-age=60, s-maxage=300, stale-while-revalidate=600'
    );
    res.status(200).send(html);
  } catch (err) {
    console.error('Erro ao compartilhar produto:', err);
    res.status(500).send(
      'Não foi possível gerar o compartilhamento do produto.'
    );
  }
};
