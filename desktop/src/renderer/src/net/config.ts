import { parseEndpoints, type Endpoint, type EndpointsResult } from './endpoints'

/**
 * Approved servers, fixed at build time from RENDERER_VITE_SERVERS (or the older single
 * RENDERER_VITE_SERVER_URL). See desktop/.env.example and net/endpoints.ts. Nothing secret may
 * ever be placed in renderer env vars: they are embedded in the shipped JavaScript.
 */
export const endpointsConfig: EndpointsResult = parseEndpoints(
  import.meta.env.RENDERER_VITE_SERVERS,
  import.meta.env.RENDERER_VITE_SERVER_URL
)

/** Optional LiveKit host when it isn't the same machine as a configured server. */
export const extraLivekitUrl: string | undefined =
  import.meta.env.RENDERER_VITE_LIVEKIT_URL || undefined

const CHOICE_KEY = 'd2.endpoint'

/** The endpoint to start with: the one a saved session belongs to, else the last choice, else the first. */
export function initialEndpoint(endpoints: Endpoint[], sessionServer: string | null): Endpoint {
  const byId = (id: string | null): Endpoint | undefined => endpoints.find((e) => e.id === id)
  return byId(sessionServer) ?? byId(localStorage.getItem(CHOICE_KEY)) ?? endpoints[0]!
}

export function rememberEndpoint(endpoint: Endpoint): void {
  localStorage.setItem(CHOICE_KEY, endpoint.id)
}
