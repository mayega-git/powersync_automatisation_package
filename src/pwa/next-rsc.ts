/**
 * Helper to strip the `_rsc` query parameter from requests in the Service Worker cache.
 * Useful as a `cacheKeyWillBeUsed` plugin for Serwist/Workbox in Next.js App Router.
 */
export async function cleanRscQuery({ request }: { request: Request }): Promise<Request> {
  const url = new URL(request.url);
  if (url.searchParams.has('_rsc')) {
    url.searchParams.delete('_rsc');
    return new Request(url.href, { ...request, mode: 'cors' });
  }
  return request;
}
