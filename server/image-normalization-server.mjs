/**
 * Image Normalization Server
 *
 * Normalizes the width of all exam paper question images.
 * Strategy: For each exam, find the widest question image, and pad others with white space on the right.
 *
 * Run with: node image-normalization-server.mjs
 */

import sharp from 'sharp';
import dotenv from 'dotenv';
// import { fetch } from 'undici'; // using global fetch

dotenv.config();

// ============ Configuration ============

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let value = true;
      if (key.includes('=')) {
        const parts = key.split('=');
        key = parts[0];
        value = parts.slice(1).join('=');
      } else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
        value = process.argv[i + 1];
        i++;
      }
      args[key.toUpperCase().replace(/-/g, '_')] = value;
    }
  }
  return args;
}

const args = parseArgs();

const CONFIG = {
  API_BASE_URL: args.API_BASE_URL || process.env.API_BASE_URL || 'https://openmath.toreal.site',
  CDN_URL: args.CDN_URL || process.env.CDN_URL || 'https://openmath.toreal.site/api/r2',
  CONCURRENCY: parseInt(args.CONCURRENCY || 10),
  TARGET_WIDTH: parseInt(args.TARGET_WIDTH || 0),
  TASK_ID: 'image-normalization'
};

// ============ API Client ============

class CloudApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  async fetch(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`API Error ${response.status}: ${response.statusText}`);
      }
      return response;
    } catch (err) {
      console.error(`Fetch failed for ${url}:`, err.message);
      throw err;
    }
  }

  async getExams() {
    const res = await this.fetch('/api/exams');
    return res.json();
  }

  async getExam(id) {
    const res = await this.fetch(`/api/exams/${id}`);
    return res.json();
  }

  async updateQuestionImage(examId, questionId, dataUrl) {
    const res = await this.fetch(`/api/exams/${examId}/questions/${questionId}/image`, {
      method: 'PATCH', // We need to implement this endpoint
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl })
    });
    return res.json();
  }

  async uploadToR2(hash, buffer, contentType = 'image/png') {
    const res = await this.fetch(`/api/r2/${hash}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: buffer
    });
    return res.json();
  }

  async getImage(hash) {
    // Try public CDN first
    const cdnUrl = `${CONFIG.CDN_URL}/${hash}`;
    try {
      const res = await fetch(cdnUrl);
      if (res.ok) return await res.arrayBuffer();
    } catch (e) {
      // ignore
    }

    // Fallback to API
    const res = await this.fetch(`/api/r2/${hash}`);
    return await res.arrayBuffer();
  }

  async updateTaskStatus(status, total, processed, metadata) {
    await this.fetch(`/api/tasks/${CONFIG.TASK_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, total, processed, metadata })
    });
  }
}

// ============ Processor ============

class ImageProcessor {
  constructor() {
    this.client = new CloudApiClient(CONFIG.API_BASE_URL);
    this.totalExams = 0;
    this.processedExams = 0;
  }

  async run() {
    console.log(`Starting Image Normalization (Concurrency: ${CONFIG.CONCURRENCY}, Target Width: ${CONFIG.TARGET_WIDTH || 'Auto'})`);

    // reset status
    await this.client.updateTaskStatus('running', 0, 0, { message: 'Fetching exams...' });

    const exams = await this.client.getExams();
    this.totalExams = exams.length;
    console.log(`Found ${exams.length} exams.`);

    if (!CONFIG.TARGET_WIDTH) {
       console.error("Error: --target-width is required.");
       process.exit(1);
    }

    await this.client.updateTaskStatus('running', this.totalExams, 0, { message: `Processing (Target: ${CONFIG.TARGET_WIDTH}px)...` });

    for (const examMeta of exams) {
      this.processedExams++;
      console.log(`[${this.processedExams}/${this.totalExams}] Processing exam: ${examMeta.name} (${examMeta.id})`);

      try {
        await this.processExam(examMeta.id);
      } catch (err) {
        console.error(`Failed to process exam ${examMeta.id}:`, err);
      }

      await this.client.updateTaskStatus('running', this.totalExams, this.processedExams, {
        currentExam: examMeta.name,
        lastUpdated: new Date().toISOString()
      });
    }

    await this.client.updateTaskStatus('completed', this.totalExams, this.processedExams, { message: 'All done' });
    console.log('Done.');
  }

  async processExam(examId) {
    const exam = await this.client.getExam(examId);
    const questions = exam.questions || [];

    if (questions.length === 0) {
      console.log(`  No questions, skipping.`);
      return;
    }

    // 1. Download images to check dimensions
    const images = []; // { id, buffer, width, height, hash }

    // Use concurrency for downloading
    const chunks = [];
    for (let i = 0; i < questions.length; i += CONFIG.CONCURRENCY) {
      const batch = questions.slice(i, i + CONFIG.CONCURRENCY);
      const results = await Promise.all(batch.map(q => this.fetchImageMeta(q)));
      images.push(...results.filter(Boolean));
    }

    if (images.length === 0) return;

    // 2. Process images that need padding
    let updatedCount = 0;
    const processBatch = [];
    const targetWidth = CONFIG.TARGET_WIDTH;

    for (const img of images) {
      if (img.width < targetWidth) {
        processBatch.push(async () => {
          try {
            // Pad image
            const newBuffer = await sharp(img.buffer)
              .extend({
                top: 0,
                bottom: 0,
                left: 0,
                right: targetWidth - img.width, // Pad right
                background: { r: 255, g: 255, b: 255, alpha: 1 }
              })
              .png()
              .toBuffer();

            // Compute hash (simple sha256 of buffer)
            const { createHash } = await import('crypto');
            const hash = createHash('sha256').update(newBuffer).digest('hex');

            // Upload if hash changed (it should)
            if (hash !== img.hash) {
              await this.client.uploadToR2(hash, newBuffer);

              // Update question
              await this.client.updateQuestionImage(examId, img.id, hash);
              updatedCount++;
              process.stdout.write('.');
            }
          } catch (e) {
            console.error(`    Error processing image ${img.id}:`, e.message);
          }
        });
      }
    }

    // Run updates in concurrent batches
    if (processBatch.length > 0) {
      console.log(`  Padding ${processBatch.length} images to ${targetWidth}px...`);
      for (let i = 0; i < processBatch.length; i += CONFIG.CONCURRENCY) {
        const batch = processBatch.slice(i, i + CONFIG.CONCURRENCY);
        await Promise.all(batch.map(fn => fn()));
      }
      console.log(`\n  Updated ${updatedCount} images.`);
    } else {
      console.log(`  All images already match or exceed target width.`);
    }
  }

  async fetchImageMeta(question) {
    try {
      let buffer;
      let hash = null;

      if (this.isHash(question.data_url)) {
        hash = question.data_url;
        buffer = await this.client.getImage(hash);
      } else if (question.data_url.startsWith('data:')) {
         // Base64
         const base64 = question.data_url.split(',')[1];
         buffer = Buffer.from(base64, 'base64');
      } else {
        return null;
      }

      if (!buffer) return null;

      const meta = await sharp(buffer).metadata();
      return {
        id: question.id,
        buffer,
        width: meta.width,
        height: meta.height,
        hash,
        isBase64: !hash
      };
    } catch (e) {
      console.error(`    Failed to fetch/parse image for Q ${question.id}:`, e.message);
      return null;
    }
  }

  isHash(str) {
    return /^[a-f0-9]{64}$/i.test(str);
  }
}

// Run
const processor = new ImageProcessor();
processor.run().catch(console.error);
