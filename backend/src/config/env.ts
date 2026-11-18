import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend/.env if present, then fallback to project root .env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const projectRoot = path.resolve(__dirname, '../../..');

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 4000),
  DATABASE_URL: process.env.DATABASE_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || '',
  LLM_API_KEY: process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || '',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  EXTRACTION_CONFIDENCE_THRESHOLD: Number(
    process.env.EXTRACTION_CONFIDENCE_THRESHOLD || 0.8
  ),
  UPLOAD_DIR: path.resolve(
    projectRoot,
    process.env.UPLOAD_DIR || 'uploads'
  ),
};
