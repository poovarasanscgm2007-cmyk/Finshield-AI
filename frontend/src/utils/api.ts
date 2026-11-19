/**
 * FINSHIELD AI - API Base URL Helper
 *
 * Resolves the full URL for an API endpoint based on VITE_API_URL.
 * - In Production (Vercel connecting to Render): VITE_API_URL is set to
 *   e.g. https://finshield-ai-backend.onrender.com, so getApiUrl('/api/auth/login')
 *   resolves to https://finshield-ai-backend.onrender.com/api/auth/login.
 * - In Local Development: VITE_API_URL is unset or empty, so getApiUrl('/api/auth/login')
 *   returns '/api/auth/login' (relative to local server / Vite dev proxy).
 */
export function getApiUrl(path: string): string {
  const rawBase = import.meta.env.VITE_API_URL;
  const baseUrl = typeof rawBase === 'string' ? rawBase.trim().replace(/\/+$/, '') : '';
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return baseUrl ? `${baseUrl}${cleanPath}` : cleanPath;
}
