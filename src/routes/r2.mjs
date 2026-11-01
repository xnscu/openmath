/**
 * R2 Storage Routes
 * Handles image storage operations with Cloudflare R2
 */
import { Hono } from 'hono';

const r2Routes = new Hono();

// Fallback legacy R2 bucket URL for already existing images
const LEGACY_R2_URL = 'https://r2-gksx.xnscu.com';

// HEAD /:hash - Check if image exists in R2
r2Routes.on('HEAD', '/:hash', async (c) => {
  const r2 = c.env.R2;
  const hash = c.req.param('hash');

  if (!r2) {
    return c.json({ error: 'R2 storage not configured' }, 503);
  }

  try {
    const object = await r2.head(hash);
    if (object) {
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': object.httpMetadata?.contentType || 'image/png',
          'Content-Length': object.size.toString(),
        },
      });
    }

    // Fallback: check legacy R2 storage
    try {
      const legacyRes = await fetch(`${LEGACY_R2_URL}/${hash}`, { method: 'HEAD' });
      if (legacyRes.ok) {
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Type': legacyRes.headers.get('Content-Type') || 'image/png',
            'Content-Length': legacyRes.headers.get('Content-Length') || '0',
          },
        });
      }
    } catch {}

    return new Response(null, { status: 404 });
  } catch (error) {
    return c.json({ error: `R2 check failed: ${error.message}` }, 500);
  }
});

// GET /:hash - Get image from R2
r2Routes.get('/:hash', async (c) => {
  const r2 = c.env.R2;
  const hash = c.req.param('hash');

  if (!r2) {
    return c.json({ error: 'R2 storage not configured' }, 503);
  }

  try {
    const object = await r2.get(hash);
    if (object) {
      return new Response(object.body, {
        status: 200,
        headers: {
          'Content-Type': object.httpMetadata?.contentType || 'image/png',
          'Content-Length': object.size.toString(),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    // Fallback: fetch from legacy R2 storage
    try {
      const legacyRes = await fetch(`${LEGACY_R2_URL}/${hash}`);
      if (legacyRes.ok) {
        return new Response(legacyRes.body, {
          status: 200,
          headers: {
            'Content-Type': legacyRes.headers.get('Content-Type') || 'image/png',
            'Content-Length': legacyRes.headers.get('Content-Length') || '0',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
      }
    } catch {}

    return c.json({ error: 'Image not found' }, 404);
  } catch (error) {
    return c.json({ error: `R2 get failed: ${error.message}` }, 500);
  }
});

// PUT /:hash - Upload image to R2 (always saves to new torealsite R2 bucket)
r2Routes.put('/:hash', async (c) => {
  const r2 = c.env.R2;
  const hash = c.req.param('hash');

  if (!r2) {
    return c.json({ error: 'R2 storage not configured' }, 503);
  }

  try {
    // Check if already exists in new bucket
    const existing = await r2.head(hash);
    if (existing) {
      return c.json({ success: true, hash, existed: true });
    }

    // Get content type from header
    const contentType = c.req.header('Content-Type') || 'image/png';

    // Upload to R2
    const body = await c.req.arrayBuffer();
    await r2.put(hash, body, {
      httpMetadata: { contentType },
    });

    return c.json({ success: true, hash, existed: false });
  } catch (error) {
    return c.json({ error: `R2 upload failed: ${error.message}` }, 500);
  }
});

// POST /check-batch - Batch check if images exist (checks both new and legacy)
r2Routes.post('/check-batch', async (c) => {
  const r2 = c.env.R2;

  if (!r2) {
    return c.json({ error: 'R2 storage not configured' }, 503);
  }

  try {
    const body = await c.req.json();
    if (!body || !Array.isArray(body.hashes)) {
      return c.json({ error: 'Invalid request: expected { hashes: string[] }' }, 400);
    }

    const results = {};

    // Check each hash in parallel
    const checks = body.hashes.map(async (hash) => {
      const object = await r2.head(hash);
      if (object) return { hash, exists: true };
      // Fallback check
      try {
        const legacyRes = await fetch(`${LEGACY_R2_URL}/${hash}`, { method: 'HEAD' });
        return { hash, exists: legacyRes.ok };
      } catch {
        return { hash, exists: false };
      }
    });

    const checkResults = await Promise.all(checks);

    for (const { hash, exists } of checkResults) {
      results[hash] = exists;
    }

    return c.json({ results });
  } catch (error) {
    return c.json({ error: `R2 batch check failed: ${error.message}` }, 500);
  }
});

export default r2Routes;
