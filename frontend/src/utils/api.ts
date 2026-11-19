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
  let baseUrl = typeof rawBase === 'string' ? rawBase.trim().replace(/\/+$/, '') : '';

  // Prevent HTTP -> HTTPS 301/302 redirects in production which downgrade POST requests to GET
  if (
    baseUrl.startsWith('http://') &&
    !baseUrl.includes('localhost') &&
    !baseUrl.includes('127.0.0.1')
  ) {
    baseUrl = baseUrl.replace(/^http:\/\//i, 'https://');
  }

  // If user configured VITE_API_URL ending with /api and the path also starts with /api, avoid /api/api duplication
  if (baseUrl.endsWith('/api') && path.startsWith('/api')) {
    baseUrl = baseUrl.slice(0, -4);
  }

  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return baseUrl ? `${baseUrl}${cleanPath}` : cleanPath;
}
