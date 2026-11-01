/**
 * Find Max Width Script
 *
 * Scans all exam questions to find the maximum image width.
 * Generates a report 'image-widths.json' and updates task status.
 *
 * Usage: node find-max-width.mjs
 */

import sharp from 'sharp';
import dotenv from 'dotenv';
import fs from 'fs/promises';
// import { fetch } from 'undici';

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
  CONCURRENCY: parseInt(args.CONCURRENCY || 20),
  TASK_ID: 'find-max-width'
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

// ============ Scanner ============

class WidthScanner {
  constructor() {
    this.client = new CloudApiClient(CONFIG.API_BASE_URL);
    this.resultsMap = new Map();
    this.maxWidth = 0;
    this.maxImage = null;
    this.outputFile = 'image-widths.json';
  }

  async loadExistingResults() {
    try {
      const data = await fs.readFile(this.outputFile, 'utf8');
      const json = JSON.parse(data);
      if (json.images && Array.isArray(json.images)) {
        for (const img of json.images) {
          this.resultsMap.set(img.hash, img);
          if (img.width > this.maxWidth) {
            this.maxWidth = img.width;
            this.maxImage = img;
          }
        }
      }
      console.log(`Loaded ${this.resultsMap.size} existing results from ${this.outputFile}.`);
    } catch (e) {
      console.log('No existing image-widths.json found or invalid, starting fresh.');
    }
  }

  async saveResults() {
    const images = Array.from(this.resultsMap.values());
    await fs.writeFile(this.outputFile, JSON.stringify({
      maxWidth: this.maxWidth,
      maxImage: this.maxImage,
      timestamp: new Date().toISOString(),
      images: images
    }, null, 2));
  }

  async processImageWithRetry(q, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const buffer = await this.client.getImage(q.dataUrl);
        const meta = await sharp(buffer).metadata();
        return meta;
      } catch (e) {
        if (i === retries - 1) throw e;
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
      }
    }
  }

  async run() {
    console.log(`Starting Width Scan (Concurrency: ${CONFIG.CONCURRENCY})`);

    // Load existing results first
    await this.loadExistingResults();

    await this.client.updateTaskStatus('running', 0, this.resultsMap.size, { message: 'Fetching exam list...' });

    // 1. Fetch all exams and build question map
    const exams = await this.client.getExams();
    console.log(`Found ${exams.length} exams.`);

    const questionMap = new Map();
    const examBatches = [];
    for (let i = 0; i < exams.length; i += CONFIG.CONCURRENCY) {
      examBatches.push(exams.slice(i, i + CONFIG.CONCURRENCY));
    }

    let fetchedCount = 0;
    process.stdout.write(`Fetching questions details...`);

    for (const batch of examBatches) {
      await Promise.all(batch.map(async (examMeta) => {
        try {
          const exam = await this.client.getExam(examMeta.id);
          if (exam.questions) {
            for (const q of exam.questions) {
              if (this.isHash(q.dataUrl) && !questionMap.has(q.dataUrl)) {
                 questionMap.set(q.dataUrl, {
                   examName: exam.name,
                   examId: exam.id,
                   ...q
                 });
              }
            }
          }
        } catch (error) {
          console.error(`Error fetching exam ${examMeta.id}:`, error.message);
        }
      }));
      fetchedCount += batch.length;
      process.stdout.write(`\rFetching questions details... ${Math.round(fetchedCount/exams.length*100)}%`);
    }
    console.log(`\nTotal unique hash images found: ${questionMap.size}`);

    // 2. Queue Setup
    let queue = [];
    for (const [hash, q] of questionMap.entries()) {
      if (!this.resultsMap.has(hash)) {
        queue.push(q);
      }
    }

    console.log(`Already processed: ${this.resultsMap.size}`);
    console.log(`Remaining to process: ${queue.length}`);

    await this.client.updateTaskStatus('running', questionMap.size, this.resultsMap.size, { message: 'Scanning image widths...' });

    // 3. Scan Loop
    let round = 1;
    while (queue.length > 0) {
      console.log(`\n=== Round ${round}: Processing ${queue.length} images ===`);
      const nextQueue = [];
      const batches = [];
      for (let i = 0; i < queue.length; i += CONFIG.CONCURRENCY) {
        batches.push(queue.slice(i, i + CONFIG.CONCURRENCY));
      }

      let processedInRound = 0;
      for (const batch of batches) {
        await Promise.all(batch.map(async (q) => {
          try {
            const meta = await this.processImageWithRetry(q, 3);
            const info = {
              exam_id: q.examId,
              question_id: q.id,
              hash: q.dataUrl,
              width: meta.width,
              height: meta.height
            };
            this.resultsMap.set(q.dataUrl, info);

            if (meta.width > this.maxWidth) {
              this.maxWidth = meta.width;
              this.maxImage = info;
            }
          } catch (e) {
            console.error(`Failed Q ${q.id}: ${e.message}`);
            nextQueue.push(q);
          }
        }));

        processedInRound += batch.length;
        if (processedInRound % 20 === 0) {
            await this.saveResults();
            await this.client.updateTaskStatus('running', questionMap.size, this.resultsMap.size, {
                message: `Scanning Round ${round}... Max: ${this.maxWidth}px`,
                maxWidth: this.maxWidth
            });
        }
        process.stdout.write(`\rRound ${round}: ${processedInRound}/${queue.length} processed.`);
      }

      await this.saveResults();

      if (nextQueue.length > 0) {
        console.log(`\nRound ${round} complete. ${nextQueue.length} failed. Retrying in 5s...`);
        queue = nextQueue;
        round++;
        await new Promise(r => setTimeout(r, 5000));
      } else {
        queue = [];
      }
    }

    console.log(`\n\nScan Complete.`);
    console.log(`Max Width: ${this.maxWidth}px`);

    await this.client.updateTaskStatus('completed', questionMap.size, this.resultsMap.size, {
      message: 'Scan complete',
      maxWidth: this.maxWidth,
      maxImage: this.maxImage
    });
  }

  isHash(str) {
    return /^[a-f0-9]{64}$/i.test(str);
  }
}

const scanner = new WidthScanner();
scanner.run().catch(err => {
  console.error(err);
  process.exit(1);
});
