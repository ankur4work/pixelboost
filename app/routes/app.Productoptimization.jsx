import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLoaderData, useFetcher, useRevalidator } from 'react-router';
import { authenticate } from '../shopify.server';
import {
  Page,
  Layout,
  Card,
  Button,
  Badge,
  Checkbox,
  Text,
  Box,
  InlineStack,
  BlockStack,
  Thumbnail,
  Divider,
  Banner,
  ProgressBar,
  Select,
  EmptyState
} from '@shopify/polaris';
import sharp from 'sharp';
import { setDefaultResultOrder } from 'node:dns';

/* -------------------------------------------------------------------------- */
/*  Networking helpers (server only)                                          */
/* -------------------------------------------------------------------------- */

// The container was hanging ~10s per image on IPv6 connect attempts to the
// Shopify CDN (ConnectTimeoutError to 2620:127:f00e::). Prefer IPv4 so fetch
// connects to the reachable address first, and cap every CDN request with an
// explicit timeout so a single bad fetch can never stall the loader or a batch.
let dnsConfigured = false;
function preferIPv4() {
  if (dnsConfigured) return;
  try { setDefaultResultOrder('ipv4first'); } catch { /* older runtimes */ }
  dnsConfigured = true;
}

async function timedFetch(url, opts = {}, timeoutMs = 20000) {
  preferIPv4();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Run async `fn` over `items` with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// Cheaply measure an image's size in MB via a HEAD request (no body download).
async function headSizeMB(url) {
  try {
    const res = await timedFetch(url, { method: 'HEAD' }, 8000);
    if (!res.ok) return 0;
    const cl = res.headers.get('content-length');
    return cl ? parseInt(cl, 10) / (1024 * 1024) : 0;
  } catch {
    return 0;
  }
}

const BATCH_SIZE = 6;          // images optimized per action call
const BATCH_CONCURRENCY = 6;   // images processed in parallel within a batch

/* -------------------------------------------------------------------------- */
/*  Product fetching                                                          */
/* -------------------------------------------------------------------------- */

async function fetchAllProducts(admin, cursor = null) {
  const query = `#graphql
    query GetProductsWithImages($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            status
            featuredImage { id url altText width height }
            images(first: 250) {
              edges { node { id url altText width height } }
            }
            metafields(first: 250, namespace: "image_optimization") {
              edges { node { key value } }
            }
          }
        }
      }
    }
  `;
  const response = await admin.graphql(query, { variables: { cursor } });
  return await response.json();
}

async function getAllProducts(admin) {
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  while (hasNextPage) {
    const data = await fetchAllProducts(admin, cursor);
    const products = data.data.products.edges.map(edge => edge.node);
    allProducts = [...allProducts, ...products];
    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
  }
  return allProducts;
}

// Parse the optimization_summary metafield (totals written by the action).
function parseSummary(product) {
  const mf = product.metafields.edges.find(e => e.node.key === 'optimization_summary');
  if (!mf) return null;
  try {
    return JSON.parse(mf.node.value);
  } catch {
    return null;
  }
}

function countProcessed(product) {
  return product.metafields.edges.filter(e => e.node.key.startsWith('image_')).length;
}

/* -------------------------------------------------------------------------- */
/*  Loader                                                                    */
/* -------------------------------------------------------------------------- */

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'all';
  const sortBy = url.searchParams.get('sortBy') || 'score_asc';

  try {
    const products = await getAllProducts(admin);

    // Build a flat list of images we need to measure (only for products that
    // have never been optimized — optimized products carry totals in their
    // summary metafield). Measured with bounded concurrency + IPv4 so the page
    // loads in a few seconds instead of stalling on per-image connect timeouts.
    const measureTasks = [];
    for (const product of products) {
      if (parseSummary(product)) continue;
      for (const edge of product.images.edges) {
        measureTasks.push({ productId: product.id, url: edge.node.url });
      }
    }
    const measuredSizes = await mapLimit(measureTasks, 24, t => headSizeMB(t.url));
    const measuredByProduct = {};
    measureTasks.forEach((t, i) => {
      measuredByProduct[t.productId] = (measuredByProduct[t.productId] || 0) + (measuredSizes[i] || 0);
    });

    const processedProducts = products.map((product) => {
      const images = product.images.edges.map(e => e.node);
      const imageCount = images.length;
      const imagesWithAlt = images.filter(img => img.altText && img.altText.length > 10).length;

      const summary = parseSummary(product);
      let processed = summary ? (summary.optimizedImages || 0) : countProcessed(product);
      processed = Math.min(processed, imageCount);

      let totalOriginalSize;
      let totalOptimizedSize;
      if (summary) {
        totalOriginalSize = summary.totalOriginalSizeMB || 0;
        totalOptimizedSize = summary.totalOptimizedSizeMB || 0;
      } else {
        totalOriginalSize = measuredByProduct[product.id] || 0;
        totalOptimizedSize = totalOriginalSize; // nothing saved yet
      }

      const score = imageCount > 0 ? Math.round((processed / imageCount) * 100) : 0;
      const sizeSavedMB = Math.max(0, totalOriginalSize - totalOptimizedSize);
      const compressionRate = totalOriginalSize > 0
        ? Math.max(0, Math.round((sizeSavedMB / totalOriginalSize) * 100))
        : 0;

      return {
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: product.status,
        imageCount,
        imagesWithAlt,
        optimizedImages: processed,
        score,
        totalOriginalSizeMB: totalOriginalSize,
        totalOptimizedSizeMB: totalOptimizedSize,
        sizeSavedMB,
        compressionRate,
        featuredImageUrl: product.featuredImage?.url || images[0]?.url,
        needsOptimization: score < 100,
      };
    });

    // Return ALL products; filtering/sorting happens instantly on the client
    // from this list, so changing a filter never re-runs this (heavy) loader.
    return {
      products: processedProducts,
      filter,
      sortBy,
      stats: {
        total: processedProducts.length,
        needsOptimization: processedProducts.filter(p => p.needsOptimization).length,
        optimized: processedProducts.filter(p => !p.needsOptimization).length,
        totalImages: processedProducts.reduce((s, p) => s + p.imageCount, 0),
        totalSizeMB: processedProducts.reduce((s, p) => s + p.totalOriginalSizeMB, 0),
        potentialSavingsMB: processedProducts.reduce((s, p) => s + p.sizeSavedMB, 0),
      },
      error: null,
    };
  } catch (error) {
    console.error('Error loading products:', error);
    return {
      products: [],
      filter,
      sortBy,
      stats: { total: 0, needsOptimization: 0, optimized: 0, totalImages: 0, totalSizeMB: 0, potentialSavingsMB: 0 },
      error: 'Failed to load products',
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Optimization primitives                                                   */
/* -------------------------------------------------------------------------- */

// Download + compress one image with Sharp. Always re-encodes to WebP, which
// reliably beats JPEG/PNG (typically 25-40% smaller at q80). Retries the
// download once to ride out transient CDN blips.
async function optimizeImage(imageUrl) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await timedFetch(imageUrl, {}, 25000);
      if (!response.ok) throw new Error(`Fetch image HTTP ${response.status}`);
      const originalBuffer = Buffer.from(await response.arrayBuffer());
      const originalSizeMB = originalBuffer.byteLength / (1024 * 1024);

      const optimizedBuffer = await sharp(originalBuffer)
        .rotate() // honor EXIF orientation before stripping metadata
        .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();

      const optimizedSizeMB = optimizedBuffer.byteLength / (1024 * 1024);
      return {
        originalSizeMB,
        optimizedSizeMB,
        optimizedBuffer,
        compressionRate: originalSizeMB > 0
          ? Math.round(((originalSizeMB - optimizedSizeMB) / originalSizeMB) * 100)
          : 0,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Upload the optimized buffer via Shopify staged uploads, attach it to the
// product, and delete the original. Returns the new MediaImage gid.
async function uploadAndReplaceImage(admin, productId, originalMediaId, optimizedBuffer, altText) {
  const isWebP = optimizedBuffer[8] === 0x57 && optimizedBuffer[9] === 0x45;
  const mimeType = isWebP ? 'image/webp' : 'image/jpeg';
  const filename = `pixelboost-${Date.now()}.${isWebP ? 'webp' : 'jpg'}`;

  const stagedRes = await admin.graphql(
    `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        input: [{
          filename,
          mimeType,
          httpMethod: 'POST',
          resource: 'IMAGE',
          fileSize: String(optimizedBuffer.byteLength),
        }],
      },
    }
  );
  const stagedData = await stagedRes.json();
  if (stagedData.data?.stagedUploadsCreate?.userErrors?.length > 0) {
    throw new Error(stagedData.data.stagedUploadsCreate.userErrors[0].message);
  }
  const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error('Failed to create staged upload target');

  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append('file', new Blob([optimizedBuffer], { type: mimeType }), filename);
  const uploadRes = await timedFetch(target.url, { method: 'POST', body: form }, 40000);
  if (!uploadRes.ok) throw new Error(`Staged upload HTTP ${uploadRes.status}`);

  const mediaRes = await admin.graphql(
    `#graphql
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { ... on MediaImage { id } }
          mediaUserErrors { field message }
        }
      }`,
    {
      variables: {
        productId,
        media: [{ alt: altText, mediaContentType: 'IMAGE', originalSource: target.resourceUrl }],
      },
    }
  );
  const mediaData = await mediaRes.json();
  if (mediaData.data?.productCreateMedia?.mediaUserErrors?.length > 0) {
    throw new Error(mediaData.data.productCreateMedia.mediaUserErrors[0].message);
  }
  const newMedia = mediaData.data?.productCreateMedia?.media?.[0];
  if (!newMedia) throw new Error('Failed to attach media to product');

  await admin.graphql(
    `#graphql
      mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
        productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
          deletedMediaIds
          mediaUserErrors { field message }
        }
      }`,
    { variables: { productId, mediaIds: [originalMediaId] } }
  );

  return newMedia.id;
}

async function generateAIAltText(imageUrl, productTitle) {
  if (!process.env.ANTHROPIC_API_KEY) return `${productTitle} - product image`;
  try {
    const imageResponse = await timedFetch(imageUrl, {}, 20000);
    if (!imageResponse.ok) throw new Error('Failed to fetch image');
    const base64Image = Buffer.from(await imageResponse.arrayBuffer()).toString('base64');
    let mediaType = 'image/jpeg';
    if (imageUrl.toLowerCase().includes('.png')) mediaType = 'image/png';
    if (imageUrl.toLowerCase().includes('.webp')) mediaType = 'image/webp';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
            { type: 'text', text: `Generate SEO-optimized alt text for this ${productTitle} image. Include: product type, color, material, style. Keep under 125 characters. Return only the alt text.` },
          ],
        }],
      }),
    });
    const result = await response.json();
    let altText = result.content[0].text.trim().replace(/^["']|["']$/g, '').replace(/\n/g, ' ');
    if (altText.length > 125) altText = altText.substring(0, 122) + '...';
    return altText;
  } catch (error) {
    console.error('Error generating AI alt text:', error);
    return `${productTitle} - product image`;
  }
}

// Recompute product totals from the parsed per-image metafield records and
// persist the optimization_summary metafield.
async function writeSummary(admin, productId, totalImages, records) {
  const processed = records.length;
  const totalOriginalSizeMB = records.reduce((s, r) => s + (r.originalSizeMB || 0), 0);
  const totalOptimizedSizeMB = records.reduce((s, r) => s + (r.optimizedSizeMB ?? r.originalSizeMB ?? 0), 0);
  const totalSizeSavedMB = Math.max(0, totalOriginalSizeMB - totalOptimizedSizeMB);
  const compressed = records.filter(r => r.status === 'optimized');
  const avgCompressionRate = compressed.length > 0
    ? Math.round(compressed.reduce((s, r) => s + (r.compressionRate || 0), 0) / compressed.length)
    : 0;

  await admin.graphql(
    `#graphql
      mutation CreateMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
    {
      variables: {
        metafields: [{
          ownerId: productId,
          namespace: 'image_optimization',
          key: 'optimization_summary',
          type: 'json',
          value: JSON.stringify({
            totalImages,
            optimizedImages: processed,
            totalOriginalSizeMB,
            totalOptimizedSizeMB,
            totalSizeSavedMB,
            avgCompressionRate,
            lastOptimizedAt: new Date().toISOString(),
          }),
        }],
      },
    }
  );

  return { processed, totalOriginalSizeMB, totalOptimizedSizeMB, totalSizeSavedMB, avgCompressionRate };
}

/* -------------------------------------------------------------------------- */
/*  Action — processes ONE batch per call, returns live progress              */
/* -------------------------------------------------------------------------- */

async function optimizeBatch(admin, productId) {
  // Query current media (MediaImage gids) + existing optimization metafields.
  const response = await admin.graphql(
    `#graphql
      query GetProductMedia($id: ID!) {
        product(id: $id) {
          id
          title
          media(first: 250) {
            edges { node { ... on MediaImage { id image { url altText } } } }
          }
          metafields(first: 250, namespace: "image_optimization") {
            edges { node { key value } }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const data = await response.json();
  const product = data.data?.product;
  if (!product) return { success: false, error: 'Product not found', productId };

  const images = (product.media?.edges || [])
    .map(e => e.node)
    .filter(n => n && n.image && n.image.url)
    .map(n => ({ id: n.id, url: n.image.url, altText: n.image.altText }));
  const total = images.length;

  // Parse existing per-image records and the set of already-processed media ids.
  const records = [];
  const doneIds = new Set();
  for (const e of product.metafields.edges) {
    if (!e.node.key.startsWith('image_')) continue;
    try {
      const rec = JSON.parse(e.node.value);
      records.push(rec);
      doneIds.add(e.node.key.slice('image_'.length));
    } catch { /* ignore malformed */ }
  }

  if (total === 0) {
    return { success: true, productId, total: 0, optimized: 0, remaining: 0, advanced: false, done: true,
      score: 0, sizeSavedMB: 0, originalSizeMB: 0, optimizedSizeMB: 0, compressionRate: 0,
      message: 'No images to optimize' };
  }

  const pending = images.filter(img => !doneIds.has(img.id.split('/').pop()));
  const batch = pending.slice(0, BATCH_SIZE);

  // Process this batch in parallel. Each result is a per-image metafield record.
  const newRecords = (await mapLimit(batch, BATCH_CONCURRENCY, async (image) => {
    try {
      const opt = await optimizeImage(image.url);

      // Re-encoding an already-tiny image can grow it — skip so we never
      // degrade the merchant's image. Mark as processed so it isn't retried.
      if (opt.optimizedSizeMB >= opt.originalSizeMB) {
        const key = `image_${image.id.split('/').pop()}`;
        return {
          key,
          record: { status: 'skipped', originalSizeMB: opt.originalSizeMB, optimizedSizeMB: opt.originalSizeMB, compressionRate: 0, optimizedAt: new Date().toISOString() },
        };
      }

      let altText = image.altText;
      if (!altText || altText.length < 10) altText = await generateAIAltText(image.url, product.title);

      const newId = await uploadAndReplaceImage(admin, productId, image.id, opt.optimizedBuffer, altText);
      const key = `image_${newId.split('/').pop()}`;
      return {
        key,
        record: {
          status: 'optimized',
          originalSizeMB: opt.originalSizeMB,
          optimizedSizeMB: opt.optimizedSizeMB,
          compressionRate: opt.compressionRate,
          altText,
          optimizedAt: new Date().toISOString(),
          originalImageId: image.id,
          newImageId: newId,
        },
      };
    } catch (err) {
      const detail = err?.graphQLErrors?.[0]?.message || err?.message || 'optimize failed';
      console.error(`[OPTIMIZE] ${image.id}:`, detail);
      return null; // failure — leave pending, don't write a metafield
    }
  })).filter(Boolean);

  // Persist the per-image metafields written this batch (up to 25 per call).
  if (newRecords.length > 0) {
    await admin.graphql(
      `#graphql
        mutation CreateMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
      {
        variables: {
          metafields: newRecords.map(r => ({
            ownerId: productId,
            namespace: 'image_optimization',
            key: r.key,
            type: 'json',
            value: JSON.stringify(r.record),
          })),
        },
      }
    );
  }

  const allRecords = [...records, ...newRecords.map(r => r.record)];
  const totals = await writeSummary(admin, productId, total, allRecords);

  const processed = Math.min(totals.processed, total);
  const remaining = total - processed;
  const advanced = newRecords.length > 0;

  return {
    success: true,
    productId,
    title: product.title,
    total,
    optimized: processed,
    remaining,
    advanced,
    done: remaining === 0,
    score: total > 0 ? Math.round((processed / total) * 100) : 0,
    sizeSavedMB: totals.totalSizeSavedMB,
    originalSizeMB: totals.totalOriginalSizeMB,
    optimizedSizeMB: totals.totalOptimizedSizeMB,
    compressionRate: totals.totalOriginalSizeMB > 0
      ? Math.round((totals.totalSizeSavedMB / totals.totalOriginalSizeMB) * 100)
      : 0,
    batchFailures: batch.length - newRecords.length,
    message: remaining === 0
      ? `Optimized "${product.title}" — ${processed}/${total} images`
      : `Optimizing "${product.title}" — ${processed}/${total} images`,
  };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'optimizeProduct') {
    const productId = formData.get('productId');
    try {
      return await optimizeBatch(admin, productId);
    } catch (error) {
      const msg = error?.graphQLErrors?.[0]?.message || error?.message || 'unknown error';
      console.error('[OPTIMIZE] product failed:', msg);
      return { success: false, productId, error: 'Failed to optimize product: ' + msg };
    }
  }

  return { success: false, error: 'Invalid action' };
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                        */
/* -------------------------------------------------------------------------- */

export default function ProductOptimization() {
  const { products, filter: initialFilter, sortBy: initialSortBy, stats, error: loadError } = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const [filter, setFilter] = useState(initialFilter);
  const [sortBy, setSortBy] = useState(initialSortBy);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [error, setError] = useState(loadError);
  const [successMessage, setSuccessMessage] = useState(null);

  // Live per-product progress, keyed by product id, updated after every batch.
  const [liveProgress, setLiveProgress] = useState({});
  const [activeId, setActiveId] = useState(null);
  const queueRef = useRef([]);
  const activeRef = useRef(null);

  const startNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) {
      activeRef.current = null;
      setActiveId(null);
      // Quietly re-run the loader in place (no full-page reload). The live
      // numbers in liveProgress remain authoritative for display, so stale
      // read-after-write metafield lag can't flip a finished product back to
      // "needs optimization".
      revalidator.revalidate();
      return;
    }
    activeRef.current = next;
    setActiveId(next);
    fetcher.submit({ actionType: 'optimizeProduct', productId: next }, { method: 'post' });
  }, [fetcher, revalidator]);

  // Drive the batch loop: each completed batch either continues the same
  // product or advances to the next queued product.
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    const data = fetcher.data;
    if (!data.productId || data.productId !== activeRef.current) return;

    if (data.success === false) {
      setError(data.error || 'Optimization failed');
      startNext();
      return;
    }

    setLiveProgress(prev => ({ ...prev, [data.productId]: data }));

    if (data.done) {
      setSuccessMessage(data.message);
      setTimeout(() => setSuccessMessage(null), 4000);
      startNext();
    } else if (!data.advanced) {
      // A whole batch failed (e.g. unreachable images) — stop to avoid looping.
      setError(`Some images for "${data.title}" couldn't be processed (${data.remaining} remaining). Try again.`);
      startNext();
    } else {
      fetcher.submit({ actionType: 'optimizeProduct', productId: data.productId }, { method: 'post' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const beginQueue = useCallback((ids) => {
    if (!ids.length || activeRef.current) return;
    setError(null);
    queueRef.current = [...ids];
    startNext();
  }, [startNext]);

  // Filter/sort are pure client-side transforms of the already-loaded product
  // list — no server roundtrip, so the list updates instantly.
  const handleFilterChange = useCallback((value) => setFilter(value), []);
  const handleSortChange = useCallback((value) => setSortBy(value), []);

  const displayedProducts = useMemo(() => {
    let list = products;
    if (filter === 'needs_optimization') list = list.filter(p => p.needsOptimization);
    else if (filter === 'optimized') list = list.filter(p => !p.needsOptimization);
    else if (filter === 'no_alt_text') list = list.filter(p => p.imagesWithAlt === 0);

    // Sort a copy so we never mutate loader data (which would corrupt the next
    // filter pass). Score reflects live progress, so re-sorts stay correct.
    const sorted = [...list];
    if (sortBy === 'score_asc') sorted.sort((a, b) => a.score - b.score);
    else if (sortBy === 'score_desc') sorted.sort((a, b) => b.score - a.score);
    else if (sortBy === 'size_desc') sorted.sort((a, b) => b.totalOriginalSizeMB - a.totalOriginalSizeMB);
    else if (sortBy === 'images_desc') sorted.sort((a, b) => b.imageCount - a.imageCount);
    return sorted;
  }, [products, filter, sortBy]);

  const handleSelectProduct = useCallback((id) => {
    setSelectedProducts(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedProducts(selectedProducts.length === displayedProducts.length ? [] : displayedProducts.map(p => p.id));
  }, [selectedProducts.length, displayedProducts]);

  const handleOptimizeProduct = useCallback((id) => beginQueue([id]), [beginQueue]);
  const handleOptimizeSelected = useCallback(() => {
    beginQueue(selectedProducts);
    setSelectedProducts([]);
  }, [beginQueue, selectedProducts]);

  const isBusy = activeId !== null;

  const getScoreBadge = (score) => {
    if (score >= 80) return <Badge tone="success">{`${score}%`}</Badge>;
    if (score >= 60) return <Badge tone="attention">{`${score}%`}</Badge>;
    return <Badge tone="critical">{`${score}%`}</Badge>;
  };

  const formatBytes = (mb) => {
    const v = mb || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(1)} GB`;
    if (v >= 1) return `${v.toFixed(1)} MB`;
    if (v > 0) return `${Math.max(1, Math.round(v * 1024))} KB`;
    return `0 KB`;
  };

  const filterOptions = [
    { label: 'All Products', value: 'all' },
    { label: 'Needs Optimization', value: 'needs_optimization' },
    { label: 'Optimized', value: 'optimized' },
    { label: 'No Alt Text', value: 'no_alt_text' },
  ];
  const sortOptions = [
    { label: 'Score: Low to High', value: 'score_asc' },
    { label: 'Score: High to Low', value: 'score_desc' },
    { label: 'Size: Largest First', value: 'size_desc' },
    { label: 'Most Images First', value: 'images_desc' },
  ];

  // Merge loader values with any live progress for a product.
  const view = (product) => {
    const lp = liveProgress[product.id];
    if (!lp) return product;
    return {
      ...product,
      score: lp.score,
      optimizedImages: lp.optimized,
      totalOriginalSizeMB: lp.originalSizeMB || product.totalOriginalSizeMB,
      sizeSavedMB: lp.sizeSavedMB,
      compressionRate: lp.compressionRate,
      needsOptimization: lp.score < 100,
    };
  };

  const liveSavings = stats.potentialSavingsMB
    + Object.entries(liveProgress).reduce((sum, [id, lp]) => {
        const base = products.find(p => p.id === id)?.sizeSavedMB || 0;
        return sum + Math.max(0, (lp.sizeSavedMB || 0) - base);
      }, 0);

  return (
    <Page
      title="PixelBoost — Image Optimizer"
      subtitle="Compress and replace product images with real optimization and automatic WebP conversion"
    >
      <Layout>
        <Layout.Section>
          <div className="pb-page-header">
            <span className="pb-page-header-icon">⚡</span>
            <div>
              <p className="pb-page-header-title">Image Optimizer</p>
              <p className="pb-page-header-sub">WebP conversion &amp; smart compression — up to 70% smaller</p>
            </div>
          </div>
        </Layout.Section>

        {error && (
          <Layout.Section>
            <Banner title="Error" tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
          </Layout.Section>
        )}
        {successMessage && (
          <Layout.Section>
            <Banner title="Success" tone="success" onDismiss={() => setSuccessMessage(null)}>{successMessage}</Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <InlineStack gap="400" wrap={false}>
            <Box width="25%">
              <Card><BlockStack gap="200">
                <Text variant="bodyMd" as="p" tone="subdued">Total Products</Text>
                <Text variant="heading2xl" as="h2">{stats.total}</Text>
              </BlockStack></Card>
            </Box>
            <Box width="25%">
              <Card><BlockStack gap="200">
                <Text variant="bodyMd" as="p" tone="subdued">Needs Optimization</Text>
                <Text variant="heading2xl" as="h2" tone="critical">{stats.needsOptimization}</Text>
              </BlockStack></Card>
            </Box>
            <Box width="25%">
              <Card><BlockStack gap="200">
                <Text variant="bodyMd" as="p" tone="subdued">Total Images</Text>
                <Text variant="heading2xl" as="h2">{stats.totalImages}</Text>
              </BlockStack></Card>
            </Box>
            <Box width="25%">
              <Card><BlockStack gap="200">
                <Text variant="bodyMd" as="p" tone="subdued">Actual Savings</Text>
                <Text variant="heading2xl" as="h2" tone="success">{formatBytes(liveSavings)}</Text>
              </BlockStack></Card>
            </Box>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="300">
                  <Box width="200px">
                    <Select label="Filter" options={filterOptions} value={filter} onChange={handleFilterChange} disabled={isBusy} />
                  </Box>
                  <Box width="200px">
                    <Select label="Sort by" options={sortOptions} value={sortBy} onChange={handleSortChange} disabled={isBusy} />
                  </Box>
                </InlineStack>
                {selectedProducts.length > 0 && (
                  <Button variant="primary" onClick={handleOptimizeSelected} loading={isBusy} disabled={isBusy}>
                    {`Optimize Selected (${selectedProducts.length})`}
                  </Button>
                )}
              </InlineStack>
              <Divider />
              <Checkbox
                label={`Select All (${displayedProducts.length} products)`}
                checked={selectedProducts.length === displayedProducts.length && displayedProducts.length > 0}
                onChange={handleSelectAll}
                disabled={isBusy}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {displayedProducts.length === 0 ? (
                <EmptyState heading="No products found" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                  <p>Try adjusting your filters to see products.</p>
                </EmptyState>
              ) : (
                displayedProducts.map((raw) => {
                  const product = view(raw);
                  const isActive = activeId === product.id;
                  return (
                    <Card key={product.id} background={selectedProducts.includes(product.id) ? 'bg-surface-selected' : undefined}>
                      <InlineStack gap="400" blockAlign="start">
                        <Checkbox checked={selectedProducts.includes(product.id)} onChange={() => handleSelectProduct(product.id)} disabled={isBusy} />
                        {product.featuredImageUrl && (
                          <Thumbnail source={product.featuredImageUrl} alt={product.title} size="large" />
                        )}
                        <Box width="100%">
                          <BlockStack gap="400">
                            <InlineStack align="space-between" blockAlign="center">
                              <BlockStack gap="200">
                                <Text variant="headingMd" as="h3">{product.title}</Text>
                                <InlineStack gap="200">
                                  <Badge>{product.status}</Badge>
                                  <Badge tone="info">{`${product.imageCount} images`}</Badge>
                                  {isActive && <Badge tone="attention">Optimizing…</Badge>}
                                </InlineStack>
                              </BlockStack>
                              {getScoreBadge(product.score)}
                            </InlineStack>

                            <Divider />

                            <InlineStack gap="800" wrap={true}>
                              <BlockStack gap="200">
                                <Text variant="bodySm" as="p" tone="subdued">Images with Alt Text</Text>
                                <Text variant="bodyMd" as="p" fontWeight="semibold">{`${product.imagesWithAlt} / ${product.imageCount}`}</Text>
                              </BlockStack>
                              <BlockStack gap="200">
                                <Text variant="bodySm" as="p" tone="subdued">Optimized Images</Text>
                                <Text variant="bodyMd" as="p" fontWeight="semibold">{`${product.optimizedImages} / ${product.imageCount}`}</Text>
                              </BlockStack>
                              <BlockStack gap="200">
                                <Text variant="bodySm" as="p" tone="subdued">Original Size</Text>
                                <Text variant="bodyMd" as="p" fontWeight="semibold">{formatBytes(product.totalOriginalSizeMB)}</Text>
                              </BlockStack>
                              <BlockStack gap="200">
                                <Text variant="bodySm" as="p" tone="subdued">Size Saved</Text>
                                <Text variant="bodyMd" as="p" fontWeight="semibold" tone="success">{`${formatBytes(product.sizeSavedMB)} (${product.compressionRate}%)`}</Text>
                              </BlockStack>
                            </InlineStack>

                            <BlockStack gap="200">
                              <Text variant="bodySm" as="p" tone="subdued">Optimization Progress</Text>
                              <ProgressBar
                                progress={product.score}
                                size="small"
                                tone={product.score >= 80 ? 'success' : product.score >= 60 ? 'attention' : 'critical'}
                              />
                            </BlockStack>

                            {product.needsOptimization && (
                              <InlineStack align="end">
                                <Button variant="primary" onClick={() => handleOptimizeProduct(product.id)} loading={isActive} disabled={isBusy}>
                                  {isActive ? 'Optimizing…' : 'Optimize This Product'}
                                </Button>
                              </InlineStack>
                            )}
                          </BlockStack>
                        </Box>
                      </InlineStack>
                    </Card>
                  );
                })
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
