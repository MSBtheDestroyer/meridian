/**
 * Live bookkeeping of the client requests this process is working on or
 * holding, per upstream, for `GET /inflight`.
 *
 * This is an observation of admitted client HTTP requests, not a restart
 * authorization or atomic drain barrier. Background Responses jobs and pending
 * client-tool continuations can outlive their HTTP request. An entry lives from the moment a request is admitted until its
 * application response body, streamed or not, is consumed, cancelled or failed. Each entry
 * is counted exactly once: `queued` while it waits for its session's turn or
 * for an SDK slot, otherwise `streams` or `requests` by what the client asked
 * for. Meridian's own background work (token refresh, usage polling, session
 * GC) never enters here.
 *
 * Pure bookkeeping: no HTTP, no I/O, no imports. Entries carry no session id,
 * prompt, profile or account, so nothing identifying can leak through a
 * snapshot.
 */

export type InflightUpstream = "claude" | "antigravity" | "chatgpt"

export interface InflightCounts {
  readonly streams: number
  readonly requests: number
  readonly queued: number
}

export interface InflightSnapshot {
  readonly scope: "client-http"
  readonly at: string
  readonly total: number
  readonly oldestStartedAt: string | null
  readonly upstreams: Partial<Record<InflightUpstream, InflightCounts>>
}

export interface InflightHandle {
  /** Record whether the client asked for a streamed response. */
  setStream(stream: boolean): void
  /** Mark the request as waiting; call the returned function once it stops waiting. */
  enterQueue(): () => void
  /** The request is finished. Idempotent. */
  end(): void
}

interface Entry {
  readonly upstream: InflightUpstream
  readonly startedAt: number
  stream: boolean
  waits: number
}

export class InflightRegistry {
  private readonly entries = new Set<Entry>()

  get size(): number {
    return this.entries.size
  }

  begin(upstream: InflightUpstream, startedAt: number = Date.now()): InflightHandle {
    const entry: Entry = { upstream, startedAt, stream: false, waits: 0 }
    this.entries.add(entry)
    return {
      setStream: (stream) => { entry.stream = stream },
      enterQueue: () => {
        entry.waits++
        let left = false
        return () => {
          if (left) return
          left = true
          entry.waits--
        }
      },
      end: () => { this.entries.delete(entry) },
    }
  }

  /** Counts per upstream; every upstream in `reported` appears, with zeros when idle. */
  snapshot(reported: readonly InflightUpstream[], now: number = Date.now()): InflightSnapshot {
    const counts = new Map<InflightUpstream, { streams: number; requests: number; queued: number }>()
    for (const upstream of reported) counts.set(upstream, { streams: 0, requests: 0, queued: 0 })
    let oldest: number | undefined
    for (const entry of this.entries) {
      let bucket = counts.get(entry.upstream)
      if (!bucket) {
        bucket = { streams: 0, requests: 0, queued: 0 }
        counts.set(entry.upstream, bucket)
      }
      if (entry.waits > 0) bucket.queued++
      else if (entry.stream) bucket.streams++
      else bucket.requests++
      if (oldest === undefined || entry.startedAt < oldest) oldest = entry.startedAt
    }
    return {
      scope: "client-http",
      at: new Date(now).toISOString(),
      total: this.entries.size,
      oldestStartedAt: oldest === undefined ? null : new Date(oldest).toISOString(),
      upstreams: Object.fromEntries(counts),
    }
  }
}

/**
 * The request is from this host. Only the socket's own peer address counts;
 * a request carrying a forwarding header came through a proxy, which may be
 * relaying somebody else, so it is refused even from a loopback peer.
 */
export function isLoopbackPeer(remoteAddress: string | undefined, headers: Headers): boolean {
  if (headers.has("forwarded") || headers.has("x-forwarded-for") || headers.has("x-real-ip")) return false
  if (!remoteAddress) return false
  const address = remoteAddress.startsWith("::ffff:") ? remoteAddress.slice("::ffff:".length) : remoteAddress
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)
}

/**
 * A Host header that is exactly a loopback authority: `localhost`,
 * 127.0.0.0/8 in dotted decimal or `[::1]`, optionally `:<port>` (1-65535).
 * Nothing else is accepted - no userinfo, path, query, fragment, trailing dot
 * or other spelling of an address - so the value is matched as written rather
 * than parsed as a URL, which would accept `127.0.0.1/x` or `u@127.0.0.1`.
 */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)"
const LOOPBACK_HOST_AUTHORITY = new RegExp(`^(?:localhost|127\\.${OCTET}\\.${OCTET}\\.${OCTET}|\\[::1\\])(?::([1-9]\\d{0,4}))?$`, "i")

/**
 * Whether a request's Host header names this machine's loopback address.
 * With isLoopbackPeer it tells a client on this machine from a browser page
 * under a foreign name that merely resolves to 127.0.0.1: such a page sends
 * its own name as Host. A reverse proxy on this machine is refused by
 * isLoopbackPeer when it adds forwarding headers (Caddy, nginx and most
 * others do by default) and here when it keeps the public Host; one that
 * strips both is indistinguishable from a local client and is trusted as one.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  const match = LOOPBACK_HOST_AUTHORITY.exec(host)
  if (!match) return false
  return match[1] === undefined || Number(match[1]) <= 65535
}

/**
 * The same response, with `onDone` called once its body has been fully read,
 * cancelled or has failed; at once for a response without a body.
 */
export function onResponseDone(response: Response, onDone: () => void): Response {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    onDone()
  }
  if (!response.body) {
    finish()
    return response
  }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: ended, value } = await reader.read()
        if (ended) {
          finish()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish()
      await reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
