/**
 * Compatibility shim for whatwg-url in Cloudflare Workers.
 *
 * Provides named and default exports for URL and URLSearchParams,
 * resolving the esbuild/unenv missing default export warning.
 */
interface GlobalWithURL {
  URL: any;
  URLSearchParams: any;
}

const g = globalThis as unknown as GlobalWithURL;

export const URL = g.URL;
export const URLSearchParams = g.URLSearchParams;

const whatwgUrl = {
  URL: g.URL,
  URLSearchParams: g.URLSearchParams,
};

export default whatwgUrl;
